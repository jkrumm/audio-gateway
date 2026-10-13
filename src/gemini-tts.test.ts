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

const { synthChunksConcurrent, handleGeminiSpeech, retryHintMs, readBodyHint, RETRY_HINT_BODY_MAX_BYTES } = await import("./gemini-tts");

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

describe("blank hints are absent, not zero", () => {
  test("empty or whitespace-only Retry-After header is no hint", () => {
    expect(retryHintMs(new Headers({ "retry-after": "" }), "")).toBeNull();
    expect(retryHintMs(new Headers({ "retry-after": "   " }), "")).toBeNull();
  });

  test("a blank header falls through to the body hint", () => {
    expect(retryHintMs(new Headers({ "retry-after": " " }), '{"retry_after":7}')).toBe(7000);
  });

  test("a retry_after that overflows when scaled to ms is no hint, never Infinity", () => {
    expect(retryHintMs(new Headers(), '{"retry_after":1e306}')).toBeNull();
    expect(retryHintMs(new Headers({ "retry-after": "1e306" }), "")).toBeNull();
    expect(retryHintMs(new Headers(), '{"retry_after":-1e306}')).toBeNull();
    expect(retryHintMs(new Headers({ "retry-after": "1e306" }), '{"retry_after":7}')).toBe(7000);
  });

  test("blank or non-numeric retry_after JSON field is no hint", () => {
    expect(retryHintMs(new Headers(), '{"retry_after":"  "}')).toBeNull();
    expect(retryHintMs(new Headers(), '{"retry_after":true}')).toBeNull();
    expect(retryHintMs(new Headers(), '{"retry_after":[]}')).toBeNull();
  });
});

describe("readBodyHint", () => {
  const enc = new TextEncoder();
  const chunked = (parts: string[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const p of parts) c.enqueue(enc.encode(p));
          c.close();
        },
      }),
      { status: 429 },
    );

  test("reads a hint from a small body split across chunks", async () => {
    expect(await readBodyHint(chunked(['{"retry_', 'after":4}']))).toBe(4000);
  });

  test("a body over the byte cap yields no hint, even with retry_after up front", async () => {
    const body = JSON.stringify({ retry_after: 3, pad: "x".repeat(RETRY_HINT_BODY_MAX_BYTES) });
    expect(await readBodyHint(new Response(body, { status: 429 }))).toBeNull();
  });

  test("a body over the cap whose JSON is cut mid-token yields no hint, not a wrong one", async () => {
    // Cut after "retry_after":1 of "retry_after":15 would parse as 1s if truncated.
    const head = `{"pad":"${"x".repeat(100)}","retry_after":1`;
    const res = chunked([head, "5" + " ".repeat(200)]);
    expect(await readBodyHint(res, 2000, head.length)).toBeNull();
  });

  test("a body that stalls past the timeout yields no hint", async () => {
    const stalled = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('{"retry_after":9'));
      },
    });
    const start = Date.now();
    expect(await readBodyHint(new Response(stalled, { status: 429 }), 100)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  test("an errored stream yields no hint", async () => {
    const broken = new ReadableStream({
      start(c) {
        c.error(new Error("socket closed"));
      },
    });
    expect(await readBodyHint(new Response(broken, { status: 429 }))).toBeNull();
  });

  test("a stream whose cancel() never settles does not hold the read", async () => {
    const stuck = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode("{"));
      },
      cancel: () => new Promise<void>(() => {}),
    });
    const start = Date.now();
    expect(await readBodyHint(new Response(stuck, { status: 429 }), 100)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  test("a declared Content-Length over the cap is refused without reading", async () => {
    const res = new Response('{"retry_after":3}', { status: 429, headers: { "content-length": String(RETRY_HINT_BODY_MAX_BYTES + 1) } });
    expect(await readBodyHint(res)).toBeNull();
  });

  test("a source of endless empty chunks cannot starve the timeout", async () => {
    const empties = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(0));
      },
    });
    const start = Date.now();
    expect(await readBodyHint(new Response(empties, { status: 429 }), 100)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  test("an already-consumed body yields no hint instead of throwing", async () => {
    const res = new Response('{"retry_after":3}', { status: 429 });
    await res.text();
    expect(await readBodyHint(res)).toBeNull();
  });

  test("no body yields no hint", async () => {
    expect(await readBodyHint(new Response(null, { status: 429 }))).toBeNull();
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

  test("honors a body-only hint (no header) on a 503", async () => {
    const { rawFetch } = await import("./gemini-tts");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('{"retry_after":0.6}', { status: 503 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const start = Date.now();
      const res = await rawFetch("https://example.test/x", { method: "GET" }, 3);
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
      expect(Date.now() - start).toBeGreaterThanOrEqual(550);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an empty Retry-After header does not cause an immediate retry", async () => {
    const { rawFetch } = await import("./gemini-tts");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("throttled", { status: 429, headers: { "retry-after": "" } });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const start = Date.now();
      const res = await rawFetch("https://example.test/x", { method: "GET" }, 3);
      expect(res.status).toBe(200);
      expect(Date.now() - start).toBeGreaterThanOrEqual(450); // fixed 500ms backoff, not 0
    } finally {
      globalThis.fetch = original;
    }
  });
});
