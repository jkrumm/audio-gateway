import { describe, expect, test } from "bun:test";
import { buildFfmetadata, concatWithGaps, masterPodcastMp3 } from "./podcast-mux";

describe("concatWithGaps", () => {
  test("inserts gapMsAfter silence between turns and reports per-turn start offsets", () => {
    const sampleRate = 24000;
    const bytesPerMs = (sampleRate * 2) / 1000;
    const a = { pcm: new Uint8Array(Math.round(bytesPerMs * 1000)).fill(1), sampleRate, gapMsAfter: 400 };
    const b = { pcm: new Uint8Array(Math.round(bytesPerMs * 500)).fill(2), sampleRate, gapMsAfter: 0 };

    const { pcm, sampleRate: sr, turnStartsMs, totalMs } = concatWithGaps([a, b]);

    expect(sr).toBe(sampleRate);
    expect(turnStartsMs).toEqual([0, 1400]);
    expect(totalMs).toBe(1900);
    expect(pcm.byteLength).toBe(a.pcm.byteLength + Math.round(bytesPerMs * 400) + b.pcm.byteLength);
    // Silence gap between the two turns is zeroed.
    const gapStart = a.pcm.byteLength;
    const gapBytes = Math.round(bytesPerMs * 400);
    expect(pcm.slice(gapStart, gapStart + gapBytes).every((b2) => b2 === 0)).toBe(true);
    expect(pcm.slice(pcm.byteLength - b.pcm.byteLength)).toEqual(b.pcm);
  });

  test("empty input returns an empty, zero-duration result", () => {
    const result = concatWithGaps([]);
    expect(result).toEqual({ pcm: new Uint8Array(0), sampleRate: 0, turnStartsMs: [], totalMs: 0 });
  });

  test("mismatched sample rates throw", () => {
    expect(() =>
      concatWithGaps([
        { pcm: new Uint8Array(4), sampleRate: 24000, gapMsAfter: 0 },
        { pcm: new Uint8Array(4), sampleRate: 44100, gapMsAfter: 0 },
      ]),
    ).toThrow();
  });
});

const BASE_TAGS = {
  title: "Episode One",
  album: "Hermes Briefings",
  artist: "Jonas & Lena",
  albumArtist: "Hermes",
  comment: "Generated briefing",
  date: "2026-09-02",
  genre: "News",
  language: "deu",
  track: 1,
};

describe("buildFfmetadata", () => {
  test("chapter END is the next chapter's START, and the last chapter's END is totalMs", () => {
    const chapters = [
      { title: "Intro", startMs: 0 },
      { title: "Main", startMs: 5000 },
      { title: "Outro", startMs: 12000 },
    ];
    const meta = buildFfmetadata(chapters, 15000, BASE_TAGS);

    expect(meta.startsWith(";FFMETADATA1\n")).toBe(true);
    expect(meta).toContain("title=Episode One");
    expect(meta).toContain("language=deu");
    expect(meta).toContain("track=1");

    const blocks = meta.split("[CHAPTER]").slice(1);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("START=0");
    expect(blocks[0]).toContain("END=5000");
    expect(blocks[0]).toContain("title=Intro");
    expect(blocks[1]).toContain("START=5000");
    expect(blocks[1]).toContain("END=12000");
    expect(blocks[2]).toContain("START=12000");
    expect(blocks[2]).toContain("END=15000");
  });

  test("escapes =, ;, #, backslash, and newline in tag values", () => {
    const meta = buildFfmetadata(
      [],
      1000,
      { ...BASE_TAGS, title: "A=B; C#D\\E\nF" },
    );
    expect(meta).toContain("title=A\\=B\\; C\\#D\\\\E\\\nF");
  });
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));
const hasFfprobe = Boolean(Bun.which("ffprobe"));

describe.skipIf(!hasFfmpeg)("masterPodcastMp3 (real ffmpeg)", () => {
  // 2s of a quiet 440Hz sine at 24kHz, s16le mono. Pure digital silence
  // (all-zero PCM) crashes some libmp3lame builds' psymodel energy
  // calculation (log(0)), so the fixture carries a low-amplitude tone instead.
  const sampleRate = 24000;
  const durationSec = 2;
  const pcm = new Uint8Array(sampleRate * durationSec * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < sampleRate * durationSec; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000);
    view.setInt16(i * 2, sample, true);
  }

  // Minimal 1x1 transparent PNG.
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  test("produces a playable MP3 with embedded chapters and title tag", async () => {
    const mp3 = await masterPodcastMp3(pcm, sampleRate, {
      chapters: [
        { title: "Chapter 1", startMs: 0 },
        { title: "Chapter 2", startMs: 1000 },
      ],
      tags: BASE_TAGS,
      cover: new Uint8Array(TINY_PNG),
      bitrateKbps: 64,
    });

    expect(mp3.byteLength).toBeGreaterThan(0);

    if (!hasFfprobe) return;

    const tmp = `/tmp/audio-gateway-mux-test-${crypto.randomUUID()}.mp3`;
    await Bun.write(tmp, mp3);
    try {
      const proc = Bun.spawnSync(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_chapters", "-show_format", tmp],
        { stdout: "pipe" },
      );
      expect(proc.success).toBe(true);
      const probe = JSON.parse(proc.stdout.toString()) as {
        chapters?: Array<{ tags?: { title?: string } }>;
        format?: { tags?: Record<string, string> };
      };
      expect(probe.chapters).toHaveLength(2);
      expect(probe.chapters?.[0]?.tags?.title).toBe("Chapter 1");
      expect(probe.chapters?.[1]?.tags?.title).toBe("Chapter 2");
      const titleTag = probe.format?.tags?.["title"] ?? probe.format?.tags?.["TITLE"];
      expect(titleTag).toBe("Episode One");
    } finally {
      await Bun.file(tmp).delete?.().catch?.(() => {});
    }
  });

  test("masters without a cover", async () => {
    const mp3 = await masterPodcastMp3(pcm, sampleRate, {
      chapters: [{ title: "Only", startMs: 0 }],
      tags: BASE_TAGS,
      bitrateKbps: 48,
    });
    expect(mp3.byteLength).toBeGreaterThan(0);
  });
});
