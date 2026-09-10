import { describe, expect, test } from "bun:test";

// config.ts is a genuine process-wide singleton — bun test shares one module
// registry, and config.ts reads env exactly once, on whichever test file's
// import chain resolves it first. Every config-touching test file sets this
// SAME baseline so the outcome is identical no matter which file wins.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";

const { audioDuration, compressForStt, concatPcm, detectSilence, parseOutputFormat, pcmToWav, transcode } = await import("./audio");

describe("parseOutputFormat", () => {
  test("empty string defaults to mp3", () => {
    expect(parseOutputFormat("")).toBe("mp3");
  });

  test("accepts mp3, opus, wav, pcm", () => {
    expect(parseOutputFormat("mp3")).toBe("mp3");
    expect(parseOutputFormat("opus")).toBe("opus");
    expect(parseOutputFormat("wav")).toBe("wav");
    expect(parseOutputFormat("pcm")).toBe("pcm");
  });

  test("returns null for an unrecognized format", () => {
    expect(parseOutputFormat("flac")).toBeNull();
    expect(parseOutputFormat("aac")).toBeNull();
  });
});

describe("pcmToWav", () => {
  test("writes a valid 44-byte WAV header for mono 16-bit 24kHz", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const buf = pcmToWav(pcm, 24000);
    const view = new DataView(buf);
    const str = (off: number, len: number): string =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(buf.byteLength).toBe(44 + pcm.byteLength);
    expect(str(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // PCM subchunk size
    expect(view.getUint16(20, true)).toBe(1); // audio format = PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate = rate * blockAlign
    expect(view.getUint16(32, true)).toBe(2); // block align = channels * bytes/sample
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(str(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(new Uint8Array(buf, 44)).toEqual(pcm);
  });
});

describe("concatPcm", () => {
  test("inserts silence between parts and preserves sample rate", () => {
    const a = { pcm: new Uint8Array([1, 1, 1, 1]), sampleRate: 24000 };
    const b = { pcm: new Uint8Array([2, 2]), sampleRate: 24000 };
    const { pcm, sampleRate } = concatPcm([a, b]);
    const silenceBytes = Math.round((400 / 1000) * 24000) * 2;
    expect(sampleRate).toBe(24000);
    expect(pcm.byteLength).toBe(a.pcm.byteLength + b.pcm.byteLength + silenceBytes);
    expect(pcm.slice(0, 4)).toEqual(a.pcm);
    expect(pcm.slice(pcm.byteLength - 2)).toEqual(b.pcm);
  });

  test("a single part needs no silence gap", () => {
    const a = { pcm: new Uint8Array([9, 9, 9]), sampleRate: 24000 };
    const { pcm } = concatPcm([a]);
    expect(pcm).toEqual(a.pcm);
  });
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));

describe.skipIf(!hasFfmpeg)("transcode + audioDuration (real ffmpeg)", () => {
  // 0.5s of silent s16le mono PCM at 24kHz.
  const silentPcm = new Uint8Array(24000 * 0.5 * 2);

  test("pcm output is raw s16le mono 24kHz, byte-exact", async () => {
    const { bytes, contentType } = await transcode(silentPcm, { kind: "pcm", sampleRate: 24000 }, "pcm");
    expect(contentType).toBe("audio/pcm");
    expect(bytes.byteLength).toBe(silentPcm.byteLength);
  });

  test("wav output carries a RIFF header sized for the PCM payload", async () => {
    const { bytes, contentType } = await transcode(silentPcm, { kind: "pcm", sampleRate: 24000 }, "wav");
    expect(contentType).toBe("audio/wav");
    const header = new Uint8Array(bytes, 0, 4);
    expect(String.fromCharCode(...header)).toBe("RIFF");
  });

  test("mp3 round-trips through 'auto' decode back to pcm", async () => {
    const { bytes: mp3Bytes } = await transcode(silentPcm, { kind: "pcm", sampleRate: 24000 }, "mp3");
    const decoded = await transcode(new Uint8Array(mp3Bytes), { kind: "auto" }, "pcm");
    // MP3 is lossy/framed, so byte length isn't exact — just verify it decoded
    // to a comparable amount of 24kHz mono s16le audio.
    const expectedSamples = silentPcm.byteLength / 2;
    const decodedSamples = decoded.bytes.byteLength / 2;
    expect(Math.abs(decodedSamples - expectedSamples)).toBeLessThan(expectedSamples * 0.2 + 4800);
  });

  test("audioDuration reports ~0.5s for the silent clip via a wav wrapper", async () => {
    const { bytes } = await transcode(silentPcm, { kind: "pcm", sampleRate: 24000 }, "wav");
    const duration = await audioDuration(new Uint8Array(bytes));
    expect(duration).toBeGreaterThan(0.4);
    expect(duration).toBeLessThan(0.6);
  });

  test("runFfmpegToBuffer throws on a non-zero ffmpeg exit (undecodable input)", async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    await expect(compressForStt(garbage, { bitrateKbps: 32 })).rejects.toThrow(/ffmpeg compressForStt failed/);
  });

  /** Generate `durationSec` of 44.1kHz mono sine-wave audio as a WAV `Uint8Array` via ffmpeg. */
  async function genWavBytes(durationSec: number): Promise<Uint8Array> {
    const proc = Bun.spawn(
      [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
        "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bytes = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`ffmpeg fixture generation failed (${exitCode})`);
    return new Uint8Array(bytes);
  }

  test("detectSilence reports a range to EOF when silence_start has no matching silence_end", async () => {
    // Real ffmpeg builds emit a paired silence_end at EOF, so this exercises
    // the defensive "trailing unpaired silence_start" branch directly by
    // faking just the silencedetect subprocess's stderr — everything else
    // (writing the temp file, probing duration via a REAL ffprobe on the
    // real bytes) still runs for real.
    const bytes = await genWavBytes(2);

    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], ...rest: unknown[]) => {
      if (cmd[0] === "ffmpeg" && cmd.some((a) => typeof a === "string" && a.includes("silencedetect"))) {
        return {
          stdout: new Response("").body,
          stderr: new Response("[silencedetect] silence_start: 0.500000\n").body,
          exited: Promise.resolve(0),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      return originalSpawn(cmd as never, ...(rest as []));
    }) as typeof Bun.spawn;

    try {
      const ranges = await detectSilence(bytes, { noiseDb: -30, minDurationSec: 0.2 });
      expect(ranges).toHaveLength(1);
      expect(ranges[0]!.start).toBeCloseTo(0.5, 1);
      // end is the real clip duration (~2s), probed via ffprobe on `bytes`.
      expect(ranges[0]!.end).toBeGreaterThan(1.8);
      expect(ranges[0]!.end).toBeLessThan(2.2);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});
