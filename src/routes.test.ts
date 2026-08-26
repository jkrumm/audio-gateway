/**
 * Mocked-route tests for audio-gateway.
 *
 * Stubs globalThis.fetch to avoid any real network calls. Exercises: bug
 * fixes (Decision 2), suffix routing, auth gate, and graceful-shutdown
 * /health → 503 (Decision 5).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { UsageRow } from "./usage";

// ---------------------------------------------------------------------------
// Set env before importing any gateway module (config.ts reads env at import).
// We set PROXY_API_KEY to a non-empty test key so the auth gate is exercisable.
// ---------------------------------------------------------------------------

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["TTS_PREP"] ??= "off"; // avoid LLM calls in dispatch path

// Now import gateway modules (env is already set).
const { handleRequest, setDraining } = await import("./index");

// ---------------------------------------------------------------------------
// Usage-row capture — intercepts the shared `_sink` singleton (usage.ts) at
// the `record()` boundary rather than reading a SQLite file. `config.usageDb`
// is a genuine process-wide singleton (bun test shares one module registry
// across ALL test files, and config.ts reads env exactly once, on whichever
// file's import chain resolves it first — NOT necessarily this file's own
// USAGE_DB assignment above). Intercepting the sink sidesteps that race
// entirely: it works regardless of which physical DB file ends up wired up.
// ---------------------------------------------------------------------------

const { _sink: usageSink } = await import("./usage");

let capturedRows: Array<Record<string, unknown>> = [];

/** Mirror the sqlite adapter's column shape so existing snake_case assertions keep working. */
function toRow(row: UsageRow): Record<string, unknown> {
  return {
    endpoint: row.endpoint,
    model: row.model,
    status: row.status,
    latency_ms: row.latencyMs,
    response_format: row.responseFormat ?? null,
    input_tokens: row.inputTokens ?? null,
    output_tokens: row.outputTokens ?? null,
    audio_tokens: row.audioTokens ?? null,
    audio_seconds: row.audioSeconds ?? null,
    input_chars: row.inputChars ?? null,
    bytes_out: row.bytesOut ?? null,
    usage_json: row.usageJson ? JSON.stringify(row.usageJson) : null,
    error_text: row.errorText ?? null,
  };
}

const originalSinkRecord = usageSink.record.bind(usageSink);
(usageSink as { record: typeof usageSink.record }).record = (row) => {
  capturedRows.push(toRow(row));
  return originalSinkRecord(row);
};

function getUsageRows(): Array<Record<string, unknown>> {
  return capturedRows;
}

function countUsageRows(): number {
  return capturedRows.length;
}

// ---------------------------------------------------------------------------
// fetch stub helpers
// ---------------------------------------------------------------------------

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
  (globalThis as any).fetch = mock(impl);
}

function restoreFetch(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
  delete (globalThis as any).fetch;
}

/** Build a request with the correct auth header for our test proxy key. */
function authed(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set("authorization", "Bearer test-proxy-secret");
  return new Request(req, { headers });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  restoreFetch();
  setDraining(false);
});

// Clear captured rows between tests so row counts are per-test.
beforeEach(() => {
  capturedRows = [];
});

// ---------------------------------------------------------------------------
// Helper: build a minimal multipart STT request (auth header included).
// ---------------------------------------------------------------------------

function sttRequest(path = "/v1/audio/transcriptions"): Request {
  const form = new FormData();
  form.append("model", "gpt-4o-transcribe");
  form.append("response_format", "json");
  form.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));
  return authed(new Request(`http://localhost${path}`, { method: "POST", body: form }));
}

// ---------------------------------------------------------------------------
// 1. Bug fix: Gemini error path records a usage row (Decision 2 / §10 bug 1)
// ---------------------------------------------------------------------------

describe("Bug fix: Gemini error path records usage row", () => {
  test("synthChunk non-2xx → records an error usage row before 500", async () => {
    // TTS_PREP=off means no prep LLM call; only Gemini synth fetch happens.
    stubFetch(async () => new Response("upstream error", { status: 500 }));

    const req = authed(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-2.0-flash-tts", input: "Hello", voice: "Charon", response_format: "mp3" }),
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(500);

    // Must have recorded a usage row with error status.
    const rows = getUsageRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const speechRow = rows.find((r) => r["endpoint"] === "speech");
    expect(speechRow).toBeDefined();
    expect(speechRow?.["status"]).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 2. Bug fix: non-JSON speech body → 400, NO usage row (Decision 2 / §10 bug 3)
// ---------------------------------------------------------------------------

describe("Bug fix: non-JSON speech body → 400, no usage row", () => {
  test("returns 400 with invalid_request_error type", async () => {
    const req = authed(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      body: "not json at all",
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect((json["error"] as Record<string, unknown>)?.["type"]).toBe("invalid_request_error");
  });

  test("writes NO usage row", async () => {
    const req = authed(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      body: "not valid json {",
      headers: { "content-type": "application/json" },
    }));
    await handleRequest(req);
    expect(countUsageRows()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2b. Default TTS model: a speech body that omits `model` must route to the
// native Gemini pipeline via config.ttsModel — NOT fall through to the IU
// /audio/speech passthrough, which 400s with "Missing model name". This is the
// regression from the Argo thin-proxy refactor (dashboard sends text only).
// ---------------------------------------------------------------------------

describe("Default TTS model when `model` omitted", () => {
  test("routes to the Gemini generateContent pipeline with the default model", async () => {
    let calledUrl = "";
    stubFetch(async (url) => {
      calledUrl = String(url);
      return new Response("upstream error", { status: 500 });
    });

    const req = authed(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      // No `model` — mirrors the Argo dashboard, which sends text only.
      body: JSON.stringify({ input: "Hello", voice: "Charon", response_format: "mp3" }),
      headers: { "content-type": "application/json" },
    }));
    await handleRequest(req);

    // Defaulted to the Gemini TTS model → native :generateContent route, not the
    // IU /audio/speech passthrough that would reject the missing model.
    expect(calledUrl).toContain("gemini-3.1-flash-tts-preview");
    expect(calledUrl).toContain(":generateContent");
  });
});

// ---------------------------------------------------------------------------
// 2c. Default STT model: a transcription form that omits `model` must have
// config.sttModel injected into the upstream form — NOT forwarded model-less to
// IU, which 400s with "Missing model name". Same Argo thin-proxy regression.
// ---------------------------------------------------------------------------

describe("Default STT model when `model` omitted", () => {
  test("injects config.sttModel into the upstream transcription form", async () => {
    let sentModel = "";
    stubFetch(async (_url, init) => {
      sentModel = String((init?.body as FormData).get("model") ?? "");
      return Response.json({ text: "hello" });
    });

    const form = new FormData();
    // No `model` — mirrors the Argo dashboard, which uploads the recording only.
    form.append("response_format", "json");
    form.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));
    const req = authed(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form }));
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    expect(sentModel).toBe("gpt-4o-transcribe");
  });
});

// ---------------------------------------------------------------------------
// 3. Bug fix: /models writes no usage row (Decision 2 / §10 bug 2)
// ---------------------------------------------------------------------------

describe("Bug fix: /models writes no usage row", () => {
  test("GET /models passes through and records nothing", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const req = authed(new Request("http://localhost/v1/models", { method: "GET" }));
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    expect(countUsageRows()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Suffix routing
// ---------------------------------------------------------------------------

describe("Suffix routing", () => {
  test("/v1/audio/transcriptions and /audio/transcriptions both route", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ text: "hello", usage: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r1 = await handleRequest(sttRequest("/v1/audio/transcriptions"));
    expect(r1.status).toBe(200);

    stubFetch(async () =>
      new Response(JSON.stringify({ text: "hello", usage: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r2 = await handleRequest(sttRequest("/audio/transcriptions"));
    expect(r2.status).toBe(200);
  });

  test("/v1/models and /models both route", async () => {
    const modelBody = JSON.stringify({ object: "list", data: [] });
    stubFetch(async () =>
      new Response(modelBody, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const r1 = await handleRequest(authed(new Request("http://localhost/v1/models", { method: "GET" })));
    expect(r1.status).toBe(200);

    stubFetch(async () =>
      new Response(modelBody, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const r2 = await handleRequest(authed(new Request("http://localhost/models", { method: "GET" })));
    expect(r2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. Auth gate
// ---------------------------------------------------------------------------

describe("Auth gate", () => {
  test("401 when PROXY_API_KEY set and bearer mismatches", async () => {
    // config.proxyApiKey = "test-proxy-secret" (set before import).
    const req = new Request("http://localhost/v1/models", {
      method: "GET",
      headers: { authorization: "Bearer wrong-key" },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)?.["type"]).toBe("invalid_request_error");
  });

  test("401 when no authorization header", async () => {
    const req = new Request("http://localhost/v1/models", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(401);
  });

  test("200 when correct bearer token provided", async () => {
    stubFetch(async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const req = authed(new Request("http://localhost/v1/models", { method: "GET" }));
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. Graceful shutdown: /health → 503 when draining (Decision 5)
// ---------------------------------------------------------------------------

describe("Graceful shutdown", () => {
  test("/health returns 503 when draining (no auth needed)", async () => {
    setDraining(true);
    // /health is answered before auth gate.
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["service"]).toBe("audio-gateway");
  });

  test("/health returns 200 when not draining", async () => {
    setDraining(false);
    const req = new Request("http://localhost/health", { method: "GET" });
    const res = await handleRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["service"]).toBe("audio-gateway");
  });

  test("new authed requests get 503 when draining", async () => {
    setDraining(true);
    const req = authed(new Request("http://localhost/v1/models", { method: "GET" }));
    const res = await handleRequest(req);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// 7. STT: upstream error records a usage row
// ---------------------------------------------------------------------------

describe("STT: upstream error records usage row", () => {
  test("both primary and whisper fallback fail → 503, records both attempts", async () => {
    // sttRequest sends gpt-4o-transcribe; a 5xx is retryable, so the handler
    // retries on whisper. Stub fails both → final 503, one row per attempt.
    const sentModels: string[] = [];
    stubFetch(async (_url, init) => {
      sentModels.push(String((init?.body as FormData).get("model") ?? ""));
      return new Response("upstream 503", { status: 503, headers: { "content-type": "text/plain" } });
    });

    const res = await handleRequest(sttRequest());
    expect(res.status).toBe(503);
    expect(sentModels).toEqual(["gpt-4o-transcribe", "whisper"]);

    const rows = getUsageRows();
    expect(rows.length).toBe(2);
    expect(rows[0]?.["model"]).toBe("gpt-4o-transcribe");
    expect(rows[0]?.["status"]).toBe(503);
    expect(rows[1]?.["model"]).toBe("whisper");
    expect(rows[1]?.["status"]).toBe(503);
  });

  test("primary 404 → whisper fallback succeeds → 200 with fallback text", async () => {
    const sentModels: string[] = [];
    stubFetch(async (_url, init) => {
      const model = String((init?.body as FormData).get("model") ?? "");
      sentModels.push(model);
      // First attempt (the requested model) hits the transient IU "no backend" 404.
      if (model !== "whisper") {
        return new Response("No suitable backend server found for model 'gpt-4o-transcribe'.", {
          status: 404,
          headers: { "content-type": "text/plain" },
        });
      }
      return Response.json({ text: "from whisper" });
    });

    const res = await handleRequest(sttRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["text"]).toBe("from whisper");
    expect(sentModels).toEqual(["gpt-4o-transcribe", "whisper"]);

    // Failed primary + successful fallback are both recorded.
    const rows = getUsageRows();
    expect(rows.length).toBe(2);
    expect(rows[0]?.["model"]).toBe("gpt-4o-transcribe");
    expect(rows[0]?.["status"]).toBe(404);
    expect(rows[1]?.["model"]).toBe("whisper");
    expect(rows[1]?.["status"]).toBe(200);
  });

  test("client-error status (400) does not trigger the fallback", async () => {
    // A 400 is a malformed request, not an unavailable model — it would fail
    // identically on whisper, so the handler must not retry.
    const sentModels: string[] = [];
    stubFetch(async (_url, init) => {
      sentModels.push(String((init?.body as FormData).get("model") ?? ""));
      return new Response("bad request", { status: 400, headers: { "content-type": "text/plain" } });
    });

    const res = await handleRequest(sttRequest());
    expect(res.status).toBe(400);
    expect(sentModels).toEqual(["gpt-4o-transcribe"]);

    const rows = getUsageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.["status"]).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 8. 404 for unknown routes
// ---------------------------------------------------------------------------

describe("404 for unknown routes", () => {
  test("GET /unknown returns 404", async () => {
    const req = authed(new Request("http://localhost/unknown", { method: "GET" }));
    const res = await handleRequest(req);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 9. TTS model override: non-TTS model remapped to config.ttsModel (Gemini pipeline)
// ---------------------------------------------------------------------------

describe("TTS model override: non-TTS model routes to Gemini pipeline", () => {
  test("model 'gemini-3.1-flash' is remapped to gemini-3.1-flash-tts-preview", async () => {
    let calledUrl = "";
    stubFetch(async (url) => {
      calledUrl = String(url);
      // Return 500 to keep the test short (we only care about routing, not audio).
      return new Response("upstream error", { status: 500 });
    });

    const req = authed(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      // Non-TTS Gemini model — the incident model that triggered this change.
      body: JSON.stringify({ input: "Hi", model: "gemini-3.1-flash" }),
      headers: { "content-type": "application/json" },
    }));
    await handleRequest(req);

    // Must have been remapped to the TTS model and routed to :generateContent,
    // NOT the IU /audio/speech passthrough.
    expect(calledUrl).toContain("gemini-3.1-flash-tts-preview");
    expect(calledUrl).toContain(":generateContent");
  });
});

// ---------------------------------------------------------------------------
// 10. error_text: non-2xx upstream response body stored in usage row
// ---------------------------------------------------------------------------

describe("error_text: upstream error body captured in usage row", () => {
  test("TTS synth 500 → error_text stored in speech usage row", async () => {
    // TTS_PREP=off (set at top) → only one fetch: Gemini synth.
    // Return a body containing a recognizable token to assert on.
    stubFetch(async () => new Response("upstream boom", { status: 500 }));

    const req = authed(new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      body: JSON.stringify({ input: "Hello", model: "gemini-3.1-flash-tts-preview" }),
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(500);

    const rows = getUsageRows();
    const speechRow = rows.find((r) => r["endpoint"] === "speech");
    expect(speechRow).toBeDefined();
    expect(String(speechRow?.["error_text"] ?? "")).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// 11. STT model override: unrecognized model remapped to config.sttModel
// ---------------------------------------------------------------------------

describe("STT model override: unrecognized model replaced with config.sttModel", () => {
  test("model 'some-random-model' is replaced with gpt-4o-transcribe in upstream form", async () => {
    let sentModel = "";
    stubFetch(async (_url, init) => {
      sentModel = String((init?.body as FormData).get("model") ?? "");
      return Response.json({ text: "hello" });
    });

    const form = new FormData();
    form.append("model", "some-random-model");
    form.append("response_format", "json");
    form.append("file", new File(["audio"], "test.mp3", { type: "audio/mpeg" }));
    const req = authed(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form }));
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    expect(sentModel).toBe("gpt-4o-transcribe");
  });
});
