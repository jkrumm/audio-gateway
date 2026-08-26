import { unlink } from "node:fs/promises";
import { config } from "./config";

// ffmpeg/ffprobe process boundary. Both TTS lanes speak a different native
// audio shape (Gemini emits raw s16le PCM; Replicate/ElevenLabs emits MP3) and
// clients ask for one of four OpenAI-compatible response formats — this module
// is the single place that framing, concatenation and transcoding happen.
// STT duration probing (transcriptions.ts) reuses `audioDuration`.

export const SAMPLE_RATE_DEFAULT = 24000;
const SILENCE_MS = 400;

export type AudioOutputFormat = "mp3" | "opus" | "wav" | "pcm";

const CONTENT_TYPES: Record<AudioOutputFormat, string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/**
 * Parse a client-supplied `response_format`. Empty defaults to `mp3` (matches
 * OpenAI's own default). `null` means unrecognized — callers should 400.
 */
export function parseOutputFormat(raw: string): AudioOutputFormat | null {
  if (raw === "") return "mp3";
  if (raw === "mp3" || raw === "opus" || raw === "wav" || raw === "pcm") return raw;
  return null;
}

export interface ChunkAudio {
  pcm: Uint8Array;
  sampleRate: number;
}

/**
 * Wrap raw s16le PCM in a 44-byte WAV header (mono, 16-bit). Not used by the
 * ffmpeg transcode path (which consumes/produces raw streams directly), but
 * kept as a documented single-chunk fallback and exercised by the header unit
 * test.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE_DEFAULT, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
}

/** Concatenate s16le PCM chunks with SILENCE_MS of silence between them. */
export function concatPcm(parts: ChunkAudio[]): { pcm: Uint8Array; sampleRate: number } {
  const sampleRate = parts[0]?.sampleRate ?? SAMPLE_RATE_DEFAULT;
  const silenceBytes = Math.round((SILENCE_MS / 1000) * sampleRate) * 2; // 16-bit mono
  const gaps = Math.max(0, parts.length - 1);
  const total = parts.reduce((n, p) => n + p.pcm.byteLength, 0) + gaps * silenceBytes;
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((p, i) => {
    out.set(p.pcm, offset);
    offset += p.pcm.byteLength;
    if (i < parts.length - 1) offset += silenceBytes; // leave zeroed silence
  });
  return { pcm: out, sampleRate };
}

interface Encoded {
  bytes: ArrayBuffer;
  contentType: string;
}

/** Raw s16le PCM at a known rate, or an auto-detected container (e.g. an MP3 chunk to decode). */
export type TranscodeInput = { kind: "pcm"; sampleRate: number } | { kind: "auto" };

function outputArgs(format: AudioOutputFormat): string[] {
  switch (format) {
    case "mp3":
      // Low bitrate is intentional — this is TTS narration, not music.
      return ["-c:a", "libmp3lame", "-b:a", `${config.ttsBitrateKbps}k`, "-f", "mp3"];
    case "opus":
      // libopus's `voip` mode is optimized for speech.
      return ["-c:a", "libopus", "-b:a", `${config.ttsOpusBitrateKbps}k`, "-application", "voip", "-f", "ogg"];
    case "wav":
      // 24 kHz mono s16le WAV — the shape Hermes' OpenAIStreamer expects.
      return ["-ar", String(SAMPLE_RATE_DEFAULT), "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav"];
    case "pcm":
      // Raw s16le mono 24 kHz, no container.
      return ["-ar", String(SAMPLE_RATE_DEFAULT), "-ac", "1", "-f", "s16le"];
  }
}

/**
 * Transcode audio via ffmpeg between what a TTS lane produced (raw s16le PCM,
 * or an auto-detected container like MP3) and the OpenAI-compatible format the
 * client asked for. Also used in reverse — decoding a fetched MP3 chunk down
 * to raw PCM (`to: "pcm"`, `from: { kind: "auto" }`) ahead of concatenation.
 */
export async function transcode(input: Uint8Array, from: TranscodeInput, to: AudioOutputFormat): Promise<Encoded> {
  const inputArgs = from.kind === "pcm"
    ? ["-f", "s16le", "-ar", String(from.sampleRate), "-ac", "1", "-i", "pipe:0"]
    : ["-i", "pipe:0"];
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", ...inputArgs, ...outputArgs(to), "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  // Read stdout/stderr concurrently with the write so the output pipe never deadlocks.
  const stdout = new Response(proc.stdout).arrayBuffer();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(input);
  await proc.stdin.end();
  const [bytes, errText, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg transcode failed (${exitCode}): ${errText.slice(0, 300)}`);
  }
  return { bytes, contentType: CONTENT_TYPES[to] };
}

/** Probe audio duration via ffprobe; 0 if unavailable (timing is best-effort). */
export async function audioDuration(data: Blob | ArrayBuffer | Uint8Array): Promise<number> {
  const tmp = `/tmp/audio-gateway-${crypto.randomUUID()}`;
  try {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
    await Bun.write(tmp, bytes);
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", tmp],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const d = Number.parseFloat(out.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
