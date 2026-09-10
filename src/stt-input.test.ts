import { afterEach, describe, expect, test } from "bun:test";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching test file sets this SAME
// baseline. The size-limit knobs under test are stubbed directly on the
// `config` object per-test instead of via env vars, since which test file's
// import chain resolves config.ts first (and therefore wins env-var races)
// is not something this file controls.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";

const { audioDuration, detectSilence } = await import("./audio");
const { config } = await import("./config");
const { prepareSttInput, snapBoundaries, SttChunkLimitError } = await import("./stt-input");

const mutableConfig = config as unknown as {
  sttMaxUploadBytes: number;
  sttMaxSttChunks: number;
  sttMaxChunkSeconds: number;
};
const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
const originalMaxSttChunks = mutableConfig.sttMaxSttChunks;
const originalMaxChunkSeconds = mutableConfig.sttMaxChunkSeconds;

afterEach(() => {
  mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
  mutableConfig.sttMaxSttChunks = originalMaxSttChunks;
  mutableConfig.sttMaxChunkSeconds = originalMaxChunkSeconds;
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));

/** Generate `durationSec` of 44.1kHz mono sine-wave audio as a WAV `File` via ffmpeg. */
async function genWavFile(durationSec: number, name = "input.wav"): Promise<File> {
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
  return new File([bytes], name, { type: "audio/wav" });
}

describe.skipIf(!hasFfmpeg)("prepareSttInput (real ffmpeg)", () => {
  test("under-limit, under-duration file is returned untouched, with only an ffprobe spawn (no ffmpeg re-encode)", async () => {
    const file = await genWavFile(0.3);
    expect(file.size).toBeLessThan(config.sttMaxUploadBytes);

    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], ...rest: unknown[]) => {
      if (cmd[0] !== "ffprobe") {
        throw new Error(`only ffprobe may be spawned on the under-limit fast path, got: ${cmd[0]}`);
      }
      return originalSpawn(cmd as never, ...(rest as []));
    }) as typeof Bun.spawn;
    try {
      const result = await prepareSttInput(file);
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]).toBe(file); // identity — untouched, not a re-wrapped copy
      expect(result.compressed).toBe(false);
      expect(Math.abs(result.totalSeconds - 0.3)).toBeLessThan(0.2);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("over-limit file compresses to a single decodable part under the limit", async () => {
    const file = await genWavFile(3);
    mutableConfig.sttMaxUploadBytes = 100_000; // raw wav (~264KB) is over this; compressed mp3 (~12KB) is not
    expect(file.size).toBeGreaterThan(mutableConfig.sttMaxUploadBytes);

    const result = await prepareSttInput(file);
    expect(result.compressed).toBe(true);
    expect(result.parts).toHaveLength(1);
    const part = result.parts[0]!;
    expect(part.size).toBeLessThan(mutableConfig.sttMaxUploadBytes);

    const duration = await audioDuration(new Uint8Array(await part.arrayBuffer()));
    expect(Math.abs(duration - 3)).toBeLessThan(2);
  });

  test("still-oversize compressed audio splits into multiple in-limit chunks", async () => {
    const file = await genWavFile(10);
    mutableConfig.sttMaxUploadBytes = 18_000; // full ~10s compress (~40KB) still exceeds this
    mutableConfig.sttMaxSttChunks = 12;

    const result = await prepareSttInput(file);
    expect(result.compressed).toBe(true);
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.parts.length).toBeLessThanOrEqual(mutableConfig.sttMaxSttChunks);

    let totalDuration = 0;
    for (const part of result.parts) {
      expect(part.size).toBeLessThan(mutableConfig.sttMaxUploadBytes);
      totalDuration += await audioDuration(new Uint8Array(await part.arrayBuffer()));
    }
    expect(Math.abs(totalDuration - 10)).toBeLessThan(2);
  });

  test("throws SttChunkLimitError naming the limit when even the smallest split is too many chunks", async () => {
    const file = await genWavFile(10);
    mutableConfig.sttMaxUploadBytes = 18_000;
    mutableConfig.sttMaxSttChunks = 2; // the same input needs 3 chunks (see test above) — over the cap

    await expect(prepareSttInput(file)).rejects.toThrow(SttChunkLimitError);
    await expect(prepareSttInput(file)).rejects.toThrow(/2/);
  });

  test("splits on duration alone when the file is under the size limit but over sttMaxChunkSeconds", async () => {
    const file = await genWavFile(10);
    // The raw wav (~882KB for 10s@44.1kHz) and its compressed mp3 are both
    // comfortably under this — only the duration axis forces chunking.
    mutableConfig.sttMaxUploadBytes = 5_000_000;
    mutableConfig.sttMaxChunkSeconds = 4; // 10s / 4s → 3 chunks

    const result = await prepareSttInput(file);
    expect(result.compressed).toBe(true);
    expect(result.parts.length).toBeGreaterThan(1);

    let totalDuration = 0;
    for (const part of result.parts) {
      totalDuration += await audioDuration(new Uint8Array(await part.arrayBuffer()));
    }
    expect(Math.abs(totalDuration - 10)).toBeLessThan(2);
  });
});

describe.skipIf(!hasFfmpeg)("detectSilence (real ffmpeg)", () => {
  test("detects a silent stretch between two tones", async () => {
    // 3s tone + 2s silence + 3s tone, concatenated into one wav.
    const proc = Bun.spawn(
      [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
        "-map", "[out]", "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bytes = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const ranges = await detectSilence(new Uint8Array(bytes), { noiseDb: -30, minDurationSec: 0.35 });
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const range = ranges[0]!;
    expect(range.start).toBeGreaterThan(2.6);
    expect(range.start).toBeLessThan(3.4);
    expect(range.end).toBeGreaterThan(4.6);
    expect(range.end).toBeLessThan(5.4);
  });

  test("never throws on unparseable input — returns []", async () => {
    const ranges = await detectSilence(new Uint8Array([1, 2, 3, 4]), { noiseDb: -30, minDurationSec: 0.35 });
    expect(ranges).toEqual([]);
  });
});

describe("snapBoundaries (pure)", () => {
  test("snaps a target to the nearest in-window silence midpoint", () => {
    const result = snapBoundaries([100], [{ start: 95, end: 105 }], { windowSec: 20, totalSeconds: 200, maxChunkSeconds: Infinity });
    expect(result).toEqual([100]); // midpoint of [95,105] is exactly 100
  });

  test("picks the closest of several candidate silences", () => {
    const result = snapBoundaries(
      [100],
      [
        { start: 60, end: 70 }, // midpoint 65, dist 35
        { start: 108, end: 112 }, // midpoint 110, dist 10
      ],
      { windowSec: 50, totalSeconds: 200, maxChunkSeconds: Infinity },
    );
    expect(result).toEqual([110]);
  });

  test("leaves the target unchanged when no silence falls in window", () => {
    const result = snapBoundaries([100], [{ start: 0, end: 5 }], { windowSec: 20, totalSeconds: 200, maxChunkSeconds: Infinity });
    expect(result).toEqual([100]);
  });

  test("handles an empty silences array", () => {
    const result = snapBoundaries([50, 100, 150], [], { windowSec: 20, totalSeconds: 200, maxChunkSeconds: Infinity });
    expect(result).toEqual([50, 100, 150]);
  });

  test("discards a snap that would be non-increasing, falling back to the hard target instead", () => {
    // A single silence range sits between both targets: the first target
    // (100) snaps to its midpoint (150); the second target (200) is also in
    // that silence's window and would want to snap to the same 150, but that
    // is <= the already-chosen first boundary, so it discards the snap and
    // keeps its own hard target (200) — boundaries stay strictly increasing.
    const result = snapBoundaries(
      [100, 200],
      [{ start: 140, end: 160 }],
      { windowSec: 60, totalSeconds: 400, maxChunkSeconds: Infinity },
    );
    expect(result).toEqual([150, 200]);
    expect(result[1]!).toBeGreaterThan(result[0]!);
  });

  test("never produces a boundary outside (0, totalSeconds)", () => {
    const result = snapBoundaries([50], [{ start: -10, end: 5 }], { windowSec: 60, totalSeconds: 100, maxChunkSeconds: Infinity });
    // midpoint would be -2.5, invalid — falls back to the hard target.
    expect(result).toEqual([50]);
  });

  // --- B1: reject a snap that would push either adjacent chunk over maxChunkSeconds ---

  test("discards a snap that would push the LEFT (preceding) chunk over maxChunkSeconds", () => {
    // Silence midpoint 670 is within the 100s window of target 600, and would
    // otherwise be a valid snap (it's still < totalSeconds, and increasing).
    // But the left chunk it would create (670 - prev(0) = 670) exceeds the
    // 600s cap, so the snap is discarded and the hard target (600) is kept.
    const result = snapBoundaries([600], [{ start: 660, end: 680 }], {
      windowSec: 100,
      totalSeconds: 700,
      maxChunkSeconds: 600,
    });
    expect(result).toEqual([600]);
  });

  test("discards a snap that would push the RIGHT (final) chunk over maxChunkSeconds", () => {
    // Silence midpoint 540 is within window of target 600 and keeps the left
    // chunk (540 - 0 = 540) under the 600s cap — but this is the LAST
    // boundary, so the final chunk runs from here to totalSeconds (1300).
    // 1300 - 540 = 760 exceeds the cap, so the snap is discarded.
    const result = snapBoundaries([600], [{ start: 530, end: 550 }], {
      windowSec: 100,
      totalSeconds: 1300,
      maxChunkSeconds: 600,
    });
    expect(result).toEqual([600]);
  });

  test("two adjacent boundaries drifting in opposite directions no longer overrun the middle chunk", () => {
    // Each snap looks valid in isolation (checked against the next HARD
    // TARGET, since the neighbor hasn't been decided yet): boundary 1 drifts
    // early to 510 (checked against target 1200), boundary 2 drifts late to
    // 1290 (checked against target 600's hard-target-spaced gap). But once
    // boundary 1 is actually fixed at 510, boundary 2's own left-chunk check
    // (1290 - 510 = 780) exceeds the 700s cap and is discarded, falling back
    // to its hard target (1200) — the middle chunk stays within the cap.
    const silences = [
      { start: 500, end: 520 }, // midpoint 510, near target 600 (-90)
      { start: 1280, end: 1300 }, // midpoint 1290, near target 1200 (+90)
    ];
    const result = snapBoundaries([600, 1200], silences, { windowSec: 90, totalSeconds: 1800, maxChunkSeconds: 700 });
    expect(result).toEqual([510, 1200]);
    expect(result[1]! - result[0]!).toBeLessThanOrEqual(700);
  });

  test("still snaps when neither adjacent chunk would overrun maxChunkSeconds", () => {
    const result = snapBoundaries([600], [{ start: 590, end: 610 }], {
      windowSec: 100,
      totalSeconds: 900,
      maxChunkSeconds: 600,
    });
    expect(result).toEqual([600]); // midpoint of [590,610] is exactly 600, well within both caps
  });
});
