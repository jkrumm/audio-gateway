import { describe, expect, test } from "bun:test";
import type { ChunkLimits } from "./gemini-tts-core";
import { enforceChunkLimits, looksGerman, parsePrepResponse, synthConcurrent } from "./gemini-tts-core";

// pcmToWav now lives in audio.test.ts alongside the rest of the ffmpeg/ffprobe
// process boundary module it moved into.

describe("looksGerman", () => {
  test("detects umlauts", () => {
    expect(looksGerman("Grüß dich")).toBe(true);
  });

  test("detects common German stopwords", () => {
    expect(looksGerman("Das ist ein Test und nicht mehr")).toBe(true);
  });

  test("returns false for plain English", () => {
    expect(looksGerman("This is a simple test sentence")).toBe(false);
  });
});

describe("synthConcurrent", () => {
  test("preserves order even when later items finish first", async () => {
    const items = [0, 1, 2, 3, 4];
    const out = await synthConcurrent(2, items, async (i) => {
      await Bun.sleep((5 - i) * 5);
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  test("throws the first failure — no silent partial output", async () => {
    const items = [0, 1, 2, 3];
    await expect(
      synthConcurrent(2, items, async (i) => {
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow(/boom/);
  });

  test("does not start a new window once a failure is known", async () => {
    const seen: number[] = [];
    const items = [0, 1, 2, 3, 4, 5];
    await expect(
      synthConcurrent(2, items, async (i) => {
        seen.push(i);
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow();
    // Window 1 (items 0,1) is allowed to fully settle; windows after the
    // failure (items 4,5) must never start.
    expect(seen).not.toContain(4);
    expect(seen).not.toContain(5);
  });
});

describe("parsePrepResponse", () => {
  test("parses strict JSON", () => {
    const out = parsePrepResponse(
      '{"lang":"de","chunks":[{"style":"Lies ruhig","text":"Heute drei Termine."}]}',
    );
    expect(out.lang).toBe("de");
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toEqual({ style: "Lies ruhig", text: "Heute drei Termine." });
  });

  test("tolerates markdown fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"lang":"en","chunks":[{"style":"Warm","text":"[pause] Done."}]}\n```';
    const out = parsePrepResponse(raw);
    expect(out.lang).toBe("en");
    expect(out.chunks[0]?.text).toBe("[pause] Done.");
  });

  test("defaults a missing style to empty string", () => {
    const out = parsePrepResponse('{"lang":"en","chunks":[{"text":"Hi there."}]}');
    expect(out.chunks[0]).toEqual({ style: "", text: "Hi there." });
  });

  test("parses the title", () => {
    const out = parsePrepResponse(
      '{"lang":"de","title":"Drei Termine heute","chunks":[{"style":"x","text":"Heute drei Termine."}]}',
    );
    expect(out.title).toBe("Drei Termine heute");
  });

  test("defaults a missing title to empty string", () => {
    const out = parsePrepResponse('{"lang":"en","chunks":[{"text":"Hi there."}]}');
    expect(out.title).toBe("");
  });

  test("throws on no JSON object", () => {
    expect(() => parsePrepResponse("not json at all")).toThrow();
  });

  test("throws on empty chunks", () => {
    expect(() => parsePrepResponse('{"lang":"de","chunks":[]}')).toThrow();
  });

  test("throws when a chunk has no text", () => {
    expect(() => parsePrepResponse('{"lang":"de","chunks":[{"style":"x"}]}')).toThrow();
  });
});

describe("enforceChunkLimits", () => {
  const LIMITS: ChunkLimits = { targetWords: 110, maxWords: 150, maxBytes: 1800 };
  const words = (n: number, w = "wort"): string => Array.from({ length: n }, () => w).join(" ");
  const wc = (s: string): number => (s.match(/\S+/g) ?? []).length;
  const bytes = (s: string): number => new TextEncoder().encode(s).length;

  test("passes a within-limit chunk through untouched", () => {
    const chunks = [{ style: "calm", text: "[pause] Heute drei Termine. Nichts Dringendes." }];
    expect(enforceChunkLimits(chunks, LIMITS)).toEqual(chunks);
  });

  test("splits an over-long chunk at sentence boundaries, never mid-sentence", () => {
    // 8 sentences × 30 words = 240 words → must split; each piece ends on a sentence.
    const text = Array.from({ length: 8 }, (_, i) => `${words(29)} ende${i}.`).join(" ");
    const out = enforceChunkLimits([{ style: "s", text }], LIMITS);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.style).toBe("s");
      expect(wc(c.text)).toBeLessThanOrEqual(LIMITS.maxWords);
      expect(c.text.trim()).toMatch(/ende\d\.$/); // ends at a sentence boundary
    }
    expect(out.map((c) => c.text).join(" ")).toBe(text); // content preserved
  });

  test("prefers paragraph boundaries over sentence splits", () => {
    const text = `${words(80)} absatz1.\n\n${words(80)} absatz2.`; // ~162 words, two paragraphs
    const out = enforceChunkLimits([{ style: "p", text }], LIMITS);
    expect(out).toHaveLength(2);
    expect(out[0]?.text.endsWith("absatz1.")).toBe(true);
    expect(out[1]?.text.endsWith("absatz2.")).toBe(true);
  });

  test("word-splits only as a last resort for a single over-long sentence", () => {
    const text = `${words(200)}.`; // one 201-word sentence, no internal boundary
    const out = enforceChunkLimits([{ style: "x", text }], LIMITS);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(wc(c.text)).toBeLessThanOrEqual(LIMITS.maxWords);
  });

  test("enforces the byte ceiling independently of word count", () => {
    const tight: ChunkLimits = { targetWords: 1000, maxWords: 1000, maxBytes: 160 };
    const text = Array.from({ length: 4 }, (_, i) => `${words(20)} satz${i}.`).join(" ");
    const out = enforceChunkLimits([{ style: "b", text }], tight);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(bytes(c.text)).toBeLessThanOrEqual(tight.maxBytes);
  });
});
