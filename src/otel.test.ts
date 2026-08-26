/**
 * Unit tests for otel.ts: trace-id derivation, span nesting/parent ids, OTLP
 * JSON payload shape, and the fetch-swallowing export primitive.
 *
 * OTEL_EXPORTER_OTLP_ENDPOINT stays UNSET in the shared config baseline below
 * (identical to every other config-touching test file) — `ENABLED` is false
 * for the whole `bun test` process, so the public API (`withSpan`, `emitLog`,
 * …) never calls `fetch`. Span/log record CONSTRUCTION still runs regardless
 * of ENABLED (see otel.ts), and `_test.onSpanExport`/`_test.onLogExport`
 * observe those real records without a live endpoint; `_test.postBatch` is
 * exercised directly against a stubbed `fetch` for the network-failure case.
 */
import { afterEach, describe, expect, test } from "bun:test";

// See usage.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["TTS_PREP"] ??= "off";

const { traceIdFromRequestId, withSpan, withRootSpan, buildTracesPayload, buildLogsPayload, emitLog, _test } =
  await import("./otel");
type SpanRecord = import("./otel").SpanRecord;
type LogRecord = import("./otel").LogRecord;

// Matches the fetch-stub pattern used across gemini-tts.test.ts/replicate-tts.test.ts.
type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = impl;
}
function restoreFetch(original: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = original;
}

afterEach(() => {
  _test.onSpanExport(null);
  _test.onLogExport(null);
});

describe("traceIdFromRequestId", () => {
  test("strips dashes from a UUID into 32 lowercase hex chars", () => {
    const requestId = "abcdef12-3456-7890-abcd-ef1234567890";
    expect(traceIdFromRequestId(requestId)).toBe("abcdef1234567890abcdef1234567890");
  });

  test("is deterministic for the same request id", () => {
    const requestId = crypto.randomUUID();
    expect(traceIdFromRequestId(requestId)).toBe(traceIdFromRequestId(requestId));
  });

  test("falls back to a fresh random trace id for a non-UUID-shaped input", () => {
    const a = traceIdFromRequestId("not-a-uuid");
    const b = traceIdFromRequestId("not-a-uuid");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("span nesting via withSpan/withRootSpan", () => {
  test("root span has no parent and carries the derived trace id", async () => {
    const captured: SpanRecord[] = [];
    _test.onSpanExport((r) => captured.push(r));

    const traceId = traceIdFromRequestId(crypto.randomUUID());
    await withRootSpan({ traceId, name: "audio.speech", attrs: { "audio.caller": "test" } }, async () => "ok");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.traceId).toBe(traceId);
    expect(captured[0]?.parentSpanId).toBeUndefined();
    expect(captured[0]?.name).toBe("audio.speech");
    expect(captured[0]?.kind).toBe(2); // SERVER
  });

  test("a child span started inside withRootSpan inherits the trace id and points parentSpanId at the root", async () => {
    const captured: SpanRecord[] = [];
    _test.onSpanExport((r) => captured.push(r));

    const traceId = traceIdFromRequestId(crypto.randomUUID());
    await withRootSpan({ traceId, name: "audio.speech" }, async () =>
      withSpan("audio.prep", { "audio.input_chars": 12 }, async () => "prepped", "client"),
    );

    expect(captured).toHaveLength(2);
    const child = captured.find((s) => s.name === "audio.prep");
    const root = captured.find((s) => s.name === "audio.speech");
    expect(child?.traceId).toBe(traceId);
    expect(child?.parentSpanId).toBe(root?.spanId);
    expect(child?.kind).toBe(3); // CLIENT
    expect(child?.attributes).toContainEqual({ key: "audio.input_chars", value: { intValue: "12" } });
  });

  test("marks error status and records an exception event when the wrapped fn throws", async () => {
    const captured: SpanRecord[] = [];
    _test.onSpanExport((r) => captured.push(r));

    await expect(
      withSpan("audio.synth.chunk", {}, async () => {
        throw new Error("upstream boom");
      }),
    ).rejects.toThrow("upstream boom");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toEqual({ code: 2, message: "upstream boom" });
    expect(captured[0]?.events?.[0]?.name).toBe("exception");
  });

  test("marks ok status on a settled span with no explicit setStatus call", async () => {
    const captured: SpanRecord[] = [];
    _test.onSpanExport((r) => captured.push(r));

    await withSpan("audio.decode", {}, async () => "done");

    expect(captured[0]?.status.code).toBe(1);
  });
});

describe("OTLP JSON payload shape", () => {
  const sampleSpan: SpanRecord = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "audio.speech",
    kind: 2,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: [{ key: "audio.caller", value: { stringValue: "hermes" } }],
    status: { code: 1 },
  };

  test("buildTracesPayload nests resourceSpans/scopeSpans/spans with string nanos", () => {
    const payload = buildTracesPayload([sampleSpan]) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: SpanRecord[] }> }>;
    };
    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans;
    expect(spans).toHaveLength(1);
    expect(spans?.[0]?.traceId).toBe(sampleSpan.traceId);
    expect(typeof spans?.[0]?.startTimeUnixNano).toBe("string");
    expect(typeof spans?.[0]?.endTimeUnixNano).toBe("string");
  });

  test("buildLogsPayload nests resourceLogs/scopeLogs/logRecords", () => {
    const sampleLog: LogRecord = {
      timeUnixNano: "1000000000",
      severityNumber: 9,
      severityText: "INFO",
      body: { stringValue: "hello" },
      attributes: [],
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
    };
    const payload = buildLogsPayload([sampleLog]) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: LogRecord[] }> }>;
    };
    const records = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords;
    expect(records).toHaveLength(1);
    expect(records?.[0]?.body).toEqual({ stringValue: "hello" });
    expect(typeof records?.[0]?.timeUnixNano).toBe("string");
  });
});

describe("disabled mode (OTEL_EXPORTER_OTLP_ENDPOINT unset)", () => {
  test("withSpan/emitLog never call fetch", async () => {
    const originalFetch = globalThis.fetch as FetchImpl;
    let calls = 0;
    setFetch(async (url, init) => {
      calls++;
      return originalFetch(url, init);
    });

    try {
      await withSpan("audio.decode", {}, async () => {
        emitLog("info", "no-op log", { foo: "bar" });
        return "done";
      });
      expect(calls).toBe(0);
    } finally {
      restoreFetch(originalFetch);
    }
  });
});

describe("log records carry trace/span ids", () => {
  test("emitLog inside a span is stamped with that span's ids", async () => {
    const capturedLogs: LogRecord[] = [];
    _test.onLogExport((r) => capturedLogs.push(r));

    const capturedSpans: SpanRecord[] = [];
    _test.onSpanExport((r) => capturedSpans.push(r));

    await withSpan("audio.prep", {}, async () => {
      emitLog("warn", "prep retry", { attempt: 2 });
      return null;
    });

    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]?.traceId).toBe(capturedSpans[0]?.traceId);
    expect(capturedLogs[0]?.spanId).toBe(capturedSpans[0]?.spanId);
    expect(capturedLogs[0]?.severityText).toBe("WARN");
    expect(capturedLogs[0]?.attributes).toContainEqual({ key: "attempt", value: { intValue: "2" } });
  });

  test("emitLog outside any span carries no trace/span id", () => {
    const captured: LogRecord[] = [];
    _test.onLogExport((r) => captured.push(r));

    emitLog("error", "no active span", {});

    expect(captured[0]?.traceId).toBeUndefined();
    expect(captured[0]?.spanId).toBeUndefined();
  });
});

describe("_test.postBatch — the network primitive, independent of ENABLED", () => {
  test("swallows a fetch rejection without throwing", async () => {
    const originalFetch = globalThis.fetch as FetchImpl;
    setFetch(async () => {
      throw new Error("network down");
    });

    try {
      await expect(_test.postBatch("http://fake.invalid/v1/traces", { resourceSpans: [] })).resolves.toBeUndefined();
    } finally {
      restoreFetch(originalFetch);
    }
  });

  test("swallows a non-ok response without throwing", async () => {
    const originalFetch = globalThis.fetch as FetchImpl;
    setFetch(async () => new Response("nope", { status: 500 }));

    try {
      await expect(_test.postBatch("http://fake.invalid/v1/traces", { resourceSpans: [] })).resolves.toBeUndefined();
    } finally {
      restoreFetch(originalFetch);
    }
  });
});
