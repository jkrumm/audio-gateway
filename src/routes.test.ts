/**
 * Mocked-route tests for audio-gateway.
 *
 * Uses a temp SQLite DB and stubs globalThis.fetch to avoid any real network
 * calls. Exercises: bug fixes (Decision 2), suffix routing, auth gate, and
 * graceful-shutdown /health → 503 (Decision 5).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Set env before importing any gateway module (config.ts reads env at import).
// We set PROXY_API_KEY to a non-empty test key so the auth gate is exercisable.
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "audio-gateway-test-"));
const DB_PATH = join(tmpDir, "test-usage.db");

process.env["IU_API_KEY"] = "test-key";
process.env["IU_OPENAI_BASE_URL"] = "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] = "https://iu.example.com/gemini/v1beta";
process.env["USAGE_DB"] = DB_PATH;
process.env["PROXY_API_KEY"] = "test-proxy-secret";
process.env["TTS_PREP"] = "off"; // avoid LLM calls in dispatch path

// Now import gateway modules (env is already set).
const { handleRequest, setDraining } = await import("./index");

// ---------------------------------------------------------------------------
// DB helper — read rows directly to assert usage recording.
// ---------------------------------------------------------------------------

function getUsageRows(): Array<Record<string, unknown>> {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.query("SELECT * FROM usage_record ORDER BY id").all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

function countUsageRows(): number {
  return getUsageRows().length;
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

// Delete all rows between tests so row counts are per-test.
beforeEach(() => {
  try {
    const db = new Database(DB_PATH);
    db.exec("DELETE FROM usage_record;");
    db.close();
  } catch {
    // DB may not exist yet on the very first run — ignore.
  }
});

// No temp-dir cleanup: usage.ts opens a single process-lifetime SQLite connection
// (a module singleton). bun test shares one module registry across files, so all
// files write through this connection. Deleting its backing dir mid-run causes
// SQLITE_IOERR_VNODE in sibling test files. The few-KB temp DB is reaped by the OS.

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
  test("non-2xx upstream → records usage row with error status", async () => {
    stubFetch(async () =>
      new Response("upstream 503", { status: 503, headers: { "content-type": "text/plain" } }),
    );

    const res = await handleRequest(sttRequest());
    expect(res.status).toBe(503);

    const rows = getUsageRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.["endpoint"]).toBe("transcriptions");
    expect(rows[0]?.["status"]).toBe(503);
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
