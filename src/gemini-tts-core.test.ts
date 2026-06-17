import { describe, expect, test } from "bun:test";
import type { ChunkLimits } from "./gemini-tts-core";
import { enforceChunkLimits, parsePrepResponse, pcmToWav } from "./gemini-tts-core";

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
