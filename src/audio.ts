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

/**
 * Re-encode arbitrary input audio to 16 kHz mono mp3 at the given bitrate —
 * the shape `stt-input.ts` sends an oversize STT upload through. 16 kHz mono
 * is lossless for STT purposes: Whisper-class models resample internally to
 * 16 kHz mono before transcribing, so nothing the upstream would have used is
 * discarded.
 */
export async function compressForStt(input: Uint8Array, opts: { bitrateKbps: number }): Promise<ArrayBuffer> {
  // Temp file, not `pipe:0`: an MP4/M4A upload (every iPhone voice memo) can
  // carry its moov atom at the end of the file, and ffmpeg cannot demux that
  // from a non-seekable pipe. These inputs are oversize by definition, so the
  // write also keeps a >25 MiB body out of the stdin buffer.
  return runFfmpegToBuffer(input, (tmp) => [
    "-i", tmp,
    ...sttEncodeArgs(opts.bitrateKbps),
  ], "compressForStt");
}

/**
 * Cut `[startSec, startSec + durationSec)` — or `startSec` to the end when
 * `durationSec` is null — out of arbitrary input audio and re-encode it to
 * 16 kHz mono mp3. Used to time-slice an oversize STT upload into
 * upload-sized chunks that are each independently decodable.
 */
export async function sliceAudio(
  input: Uint8Array,
  startSec: number,
  durationSec: number | null,
  opts: { bitrateKbps: number },
): Promise<ArrayBuffer> {
  // `durationSec: null` runs the slice to the end of the input — used for the
  // last chunk, so float rounding in the per-chunk length never truncates the
  // tail of the recording.
  return runFfmpegToBuffer(input, (tmp) => [
    "-ss", String(startSec),
    ...(durationSec === null ? [] : ["-t", String(durationSec)]),
    "-i", tmp,
    ...sttEncodeArgs(opts.bitrateKbps),
  ], "sliceAudio");
}

/** 16 kHz mono mp3 encode args — the one shape every STT-bound re-encode uses. */
const sttEncodeArgs = (bitrateKbps: number): string[] => [
  "-ar", "16000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", `${bitrateKbps}k`, "-f", "mp3", "pipe:1",
];

/** Run ffmpeg over a temp-file copy of `input` and return stdout, throwing on a non-zero exit. */
async function runFfmpegToBuffer(
  input: Uint8Array,
  args: (tmpPath: string) => string[],
  label: string,
): Promise<ArrayBuffer> {
  const tmp = `/tmp/audio-gateway-${crypto.randomUUID()}`;
  try {
    await Bun.write(tmp, input);
    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", ...args(tmp)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).arrayBuffer();
    const stderr = new Response(proc.stderr).text();
    const [bytes, errText, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg ${label} failed (${exitCode}): ${errText.slice(0, 300)}`);
    }
    return bytes;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export interface SilenceRange {
  start: number;
  end: number;
}

const SILENCE_START_RE = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END_RE = /silence_end:\s*(-?[\d.]+)/;

/**
 * Detect silent stretches via ffmpeg's `silencedetect` filter — used by
 * `stt-input.ts` to snap hard chunk-boundary cuts to a nearby pause instead of
 * slicing mid-word. Never throws: a parse miss or non-zero exit returns `[]`
 * and the caller falls back to hard boundaries, since this is an optimisation,
 * not a correctness requirement.
 */
export async function detectSilence(
  input: Uint8Array,
  opts: { noiseDb: number; minDurationSec: number },
): Promise<SilenceRange[]> {
  const tmp = `/tmp/audio-gateway-${crypto.randomUUID()}`;
  try {
    await Bun.write(tmp, input);
    const proc = Bun.spawn(
      [
        "ffmpeg", "-hide_banner",
        "-i", tmp,
        "-af", `silencedetect=noise=${opts.noiseDb}dB:d=${opts.minDurationSec}`,
        "-f", "null", "-",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    // silencedetect prints at the default (info) log level, on stderr —
    // deliberately no `-loglevel error` here, unlike the other ffmpeg calls
    // in this module, since that would suppress the very output we parse.
    const stderrText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];

    const ranges: SilenceRange[] = [];
    let pendingStart: number | null = null;
    for (const line of stderrText.split("\n")) {
      const startMatch = SILENCE_START_RE.exec(line);
      if (startMatch?.[1] !== undefined) {
        pendingStart = Number.parseFloat(startMatch[1]);
        continue;
      }
      const endMatch = SILENCE_END_RE.exec(line);
      if (endMatch?.[1] !== undefined && pendingStart !== null) {
        const end = Number.parseFloat(endMatch[1]);
        if (Number.isFinite(pendingStart) && Number.isFinite(end)) ranges.push({ start: pendingStart, end });
        pendingStart = null;
      }
    }
    if (pendingStart !== null) {
      // Trailing unpaired silence_start — the silence runs to end of file.
      // We don't know EOF from stderr alone; probe it via ffprobe.
      const totalSeconds = await audioDuration(input);
      if (Number.isFinite(pendingStart) && totalSeconds > pendingStart) {
        ranges.push({ start: pendingStart, end: totalSeconds });
      }
    }
    return ranges.sort((a, b) => a.start - b.start);
  } catch {
    return [];
  } finally {
    await unlink(tmp).catch(() => {});
  }
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
