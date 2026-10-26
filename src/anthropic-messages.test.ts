/**
 * Hermetic tests for the native Anthropic Messages client. Stubs globalThis.fetch —
 * no network, no creds. See replicate-tts.test.ts for the shared env baseline.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";
process.env["TTS_CONCURRENCY"] ??= "4";

const { parseAnthropicStream, callAnthropicMessages, buildSystem } = await import("./anthropic-messages");

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

const PARAMS = { model: "claude-opus-5-5", system: "sys", user: "user", maxTokens: 1000 };

const OK_STREAM = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  "",
].join("\n");

describe("parseAnthropicStream", () => {
  test("skips [DONE] and non-JSON data payloads instead of throwing", () => {
    const body = `${OK_STREAM}\ndata: [DONE]\ndata: {not json\ndata: 42\n`;
    const parsed = parseAnthropicStream(body);
    expect(parsed).toEqual({
      ok: true,
      value: { text: "Hallo", stopReason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }, streamError: undefined },
    });
  });

  test("an SSE-shaped body with no valid event is unreadable, not an empty success", () => {
    expect(parseAnthropicStream("data: [DONE]\n")).toEqual({ ok: false, reason: "SSE body carried no valid events" });
    expect(parseAnthropicStream("data: {not json\ndata: 42\n: keepalive\n")).toEqual({
      ok: false,
      reason: "SSE body carried no valid events",
    });
  });

  test("a plain JSON message body yields its text blocks, stop reason and usage", () => {
    const body = JSON.stringify({
      content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    expect(parseAnthropicStream(body)).toEqual({
      ok: true,
      value: { text: "Hi", stopReason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } },
    });
  });

  test("a 200 JSON error envelope surfaces as a streamError, not empty text", () => {
    const body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(parseAnthropicStream(body)).toEqual({
      ok: true,
      value: { text: "", stopReason: null, usage: {}, streamError: { type: "overloaded_error", message: "Overloaded" } },
    });
  });

  test("empty, non-JSON and wrong-shape bodies are explicit failures", () => {
    expect(parseAnthropicStream("")).toEqual({ ok: false, reason: "empty body" });
    expect(parseAnthropicStream("<html>500</html>")).toEqual({ ok: false, reason: "body is not a JSON object" });
    expect(parseAnthropicStream("{}")).toEqual({ ok: false, reason: "JSON body has no content array" });
  });
});

describe("callAnthropicMessages — unreadable 2xx bodies", () => {
  test("an empty 200 body is retried and the next attempt's answer is used", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return calls === 1 ? new Response("", { status: 200 }) : new Response(OK_STREAM, { status: 200 });
    });
    const result = await callAnthropicMessages(PARAMS);
    expect(calls).toBe(2);
    expect(result.ok && result.text).toBe("Hallo");
  });

  test("an SSE body of only junk is retried like an empty body", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return calls === 1 ? new Response("data: [DONE]\n", { status: 200 }) : new Response(OK_STREAM, { status: 200 });
    });
    const result = await callAnthropicMessages(PARAMS);
    expect(calls).toBe(2);
    expect(result.ok && result.text).toBe("Hallo");
  });

  test("a persistently unparseable 200 body becomes ok:false with a body excerpt, not a SyntaxError", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return new Response("<html>The request timed out</html>", { status: 200 });
    });
    const result = await callAnthropicMessages(PARAMS);
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorText).toContain("unreadable response");
    expect(result.errorText).toContain("<html>The request timed out</html>");
  });

  test("a retryable 200 JSON error envelope is retried per RETRYABLE_STREAM_ERRORS", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return calls === 1
        ? new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 200 })
        : new Response(OK_STREAM, { status: 200 });
    });
    const result = await callAnthropicMessages(PARAMS);
    expect(calls).toBe(2);
    expect(result.ok && result.text).toBe("Hallo");
  });

  test("a non-retryable 200 JSON error envelope returns ok:false at once", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', { status: 200 });
    });
    const result = await callAnthropicMessages(PARAMS);
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, status: 502, errorText: "invalid_request_error: bad" });
  });
});

describe("callAnthropicMessages — per-attempt timeout", () => {
  /** A fetch that never answers on its own and rejects when its signal aborts, like the real one. */
  const stalled: FetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  test("a stalled attempt aborts and the retry's answer is used", async () => {
    let calls = 0;
    setFetch(async (url, init) => {
      calls++;
      return calls === 1 ? stalled(url, init) : new Response(OK_STREAM, { status: 200 });
    });
    const result = await callAnthropicMessages({ ...PARAMS, timeoutMs: 30 });
    expect(calls).toBe(2);
    expect(result.ok && result.text).toBe("Hallo");
  });

  test("every attempt timing out returns ok:false 504 instead of hanging or throwing", async () => {
    let calls = 0;
    setFetch((url, init) => {
      calls++;
      return stalled(url, init);
    });
    const result = await callAnthropicMessages({ ...PARAMS, timeoutMs: 30 });
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(504);
    expect(result.errorText).toContain("no complete response");
  });
});

describe("buildSystem — prompt-cache prefix", () => {
  test("splits a matching prefix into a cached block plus the remainder", () => {
    expect(buildSystem("BASE\n\nTAIL", "BASE")).toEqual([
      { type: "text", text: "BASE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "\n\nTAIL" },
    ]);
  });

  test("keeps a plain string without a prefix, or when the prefix does not lead the system prompt", () => {
    expect(buildSystem("BASE TAIL")).toBe("BASE TAIL");
    expect(buildSystem("BASE TAIL", "OTHER")).toBe("BASE TAIL");
  });

  test("a prefix that is the whole prompt yields a single cached block", () => {
    expect(buildSystem("BASE", "BASE")).toEqual([{ type: "text", text: "BASE", cache_control: { type: "ephemeral" } }]);
  });
});
