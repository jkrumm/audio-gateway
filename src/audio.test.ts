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
process.env["TTS_PREP"] ??= "off";

const { audioDuration, concatPcm, parseOutputFormat, pcmToWav, transcode } = await import("./audio");

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
});
