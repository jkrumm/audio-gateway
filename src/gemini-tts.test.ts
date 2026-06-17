/**
 * Integration tests for the Gemini concurrent-synth core (Decision 1).
 *
 * Stubs globalThis.fetch — no network, no creds. Verifies the two properties the
 * route tests don't cover: order-preserving reassembly when chunks complete out
 * of order, and fail-fast on a chunk error (no silent partial output).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { PrepChunk } from "./gemini-tts-core";

// Env must be set before importing modules — config.ts reads env at import.
// In-memory usage DB: this test asserts only audio ordering, never usage rows,
// and an in-memory sink keeps it independent of sibling test files' temp dirs.
process.env["IU_API_KEY"] = "test-key";
process.env["IU_OPENAI_BASE_URL"] = "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] = "https://iu.example.com/gemini/v1beta";
process.env["USAGE_DB"] = ":memory:";
process.env["TTS_CONCURRENCY"] = "4";

const { synthChunksConcurrent } = await import("./gemini-tts");

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = impl;
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

/** A Gemini generateContent response carrying `pcm` as base64 L16/24kHz audio. */
function geminiAudio(pcm: Uint8Array): Response {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from(pcm).toString("base64"), mimeType: "audio/L16;rate=24000" } }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** Recover the chunk index from the synthesized request body (`<style>: idx:<n>`). */
function chunkIndex(init?: RequestInit): number {
  const raw = typeof init?.body === "string" ? init.body : "";
  const parsed = JSON.parse(raw) as { contents: Array<{ parts: Array<{ text: string }> }> };
  const text = parsed.contents[0]?.parts[0]?.text ?? "";
  return Number(/idx:(\d+)/.exec(text)?.[1]);
}

const chunks = (n: number): PrepChunk[] =>
  Array.from({ length: n }, (_, i) => ({ style: "s", text: `idx:${i}` }));

describe("synthChunksConcurrent", () => {
  test("preserves chunk order even when later chunks finish first", async () => {
    // Chunk 0 is the slowest — without index-based reassembly it would land last.
    setFetch(async (_url, init) => {
      const i = chunkIndex(init);
      await Bun.sleep((5 - i) * 10);
      return geminiAudio(Uint8Array.from([i, 0]));
    });

    const parts = await synthChunksConcurrent("gemini-tts", "Charon", chunks(5));
    expect(parts.map((p) => p.pcm[0])).toEqual([0, 1, 2, 3, 4]);
  });

  test("throws on a chunk failure — no silent partial output", async () => {
    setFetch(async (_url, init) => {
      const i = chunkIndex(init);
      if (i === 2) return new Response("boom", { status: 500 }); // 500 is not retried
      return geminiAudio(Uint8Array.from([i, 0]));
    });

    await expect(synthChunksConcurrent("gemini-tts", "Charon", chunks(3))).rejects.toThrow(/Gemini TTS failed/);
  });
});
