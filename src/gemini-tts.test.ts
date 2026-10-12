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
// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";
process.env["TTS_CONCURRENCY"] ??= "4";

const { synthChunksConcurrent, handleGeminiSpeech, retryHintMs } = await import("./gemini-tts");

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

describe("handleGeminiSpeech — spoken summary", () => {
  test("summarize call never sends reasoning_effort (config.ttsSummaryModel is Gemini, outside the known families)", async () => {
    let summaryBody: { reasoning_effort?: string } | undefined;
    setFetch(async (url, init) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        summaryBody = JSON.parse(String(init?.body ?? "{}")) as { reasoning_effort?: string };
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ lang: "de", title: "Kurztitel", chunks: [{ style: "warm", text: "Kurzer Satz." }] }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200 },
        );
      }
      return geminiAudio(Uint8Array.from([1, 0]));
    });

    const res = await handleGeminiSpeech({
      model: "gemini-3.1-flash-tts-preview",
      input: "Ein längerer Satz, der zusammengefasst werden soll.",
      voice: "Charon",
      responseFormat: "mp3",
      summarize: true,
    });

    expect(res.status).toBe(200);
    expect(summaryBody?.reasoning_effort).toBeUndefined();
  });
});

describe("retryHintMs", () => {
  test("reads Retry-After delay-seconds", () => {
    expect(retryHintMs(new Headers({ "retry-after": "8" }), "")).toBe(8000);
  });

  test("reads Retry-After as an HTTP-date", () => {
    const headers = new Headers({ "retry-after": new Date(Date.now() + 5000).toUTCString() });
    const hint = retryHintMs(headers, "");
    expect(hint).not.toBeNull();
    expect(hint!).toBeGreaterThan(4000);
    expect(hint!).toBeLessThanOrEqual(5000);
  });

  test("reads a retry_after JSON field", () => {
    expect(retryHintMs(new Headers(), '{"detail":"throttled","retry_after":12}')).toBe(12000);
  });

  test("reads Replicate's documented 'resets in ~30s' prose (no header, no field)", () => {
    const body = JSON.stringify({ detail: "Request was throttled. Your rate limit resets in ~30s." });
    expect(retryHintMs(new Headers(), body)).toBe(30000);
  });

  test("is null when the response carries no hint", () => {
    expect(retryHintMs(new Headers(), '{"error":"boom"}')).toBeNull();
  });

  test("is null when the prose capture is not a number (never NaN)", () => {
    expect(retryHintMs(new Headers(), '{"detail":"Your rate limit resets in .s."}')).toBeNull();
    expect(retryHintMs(new Headers(), '{"detail":"resets in 1.2.3s"}')).toBeNull();
  });
});

describe("rawFetch transport retry", () => {
  test("retries once when fetch throws (socket closed mid-stream) and returns the next reply", async () => {
    const { rawFetch } = await import("./gemini-tts");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("The socket connection was closed unexpectedly.");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const res = await rawFetch("https://example.test/x", { method: "GET" }, 3);
      expect(res.status).toBe(200);
      expect(res.body).toBe("ok");
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("waits out the server's retry hint on 429 instead of the fixed 500ms backoff", async () => {
    const { rawFetch } = await import("./gemini-tts");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("throttled", { status: 429, headers: { "retry-after": "0.6" } });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const start = Date.now();
      const res = await rawFetch("https://example.test/x", { method: "GET" }, 3);
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
      // 600ms hint honored; the old fixed backoff would have slept only 500ms.
      expect(Date.now() - start).toBeGreaterThanOrEqual(550);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("does not wait on a stalled error body when a Retry-After header is present", async () => {
    const { rawFetch } = await import("./gemini-tts");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        // A body that never ends: reading it would hang forever.
        const stalled = new ReadableStream({ start() {} });
        return new Response(stalled, { status: 429, headers: { "retry-after": "0.05" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const start = Date.now();
      const res = await rawFetch("https://example.test/x", { method: "GET" }, 3);
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      globalThis.fetch = original;
    }
  });
});
