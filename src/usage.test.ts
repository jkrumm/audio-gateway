/**
 * Unit tests for usage.ts: the idempotent-migration boot path against a
 * legacy (pre-correlation) DB schema, the text truncation/gate, and the
 * request-correlation context (AsyncLocalStorage).
 *
 * Stubs no network — this exercises real bun:sqlite against temp files.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["TTS_PREP"] ??= "off";

const { buildSqliteSink, getRequestMeta, resolveText, runWithRequestContext, setRequestMeta } = await import(
  "./usage"
);
type UsageRow = import("./usage").UsageRow;

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "audio-gateway-usage-test-"));
  tempDirs.push(dir);
  return join(dir, "legacy.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Row shape of usage_record BEFORE the request-correlation columns landed. */
function createLegacySchema(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE usage_record (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL,
      endpoint        TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      status          INTEGER NOT NULL,
      latency_ms      INTEGER NOT NULL,
      response_format TEXT,
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      audio_tokens    INTEGER,
      audio_seconds   REAL,
      input_chars     INTEGER,
      bytes_out       INTEGER,
      usage_json      TEXT
    );
  `);
  db.close();
}

describe("buildSqliteSink — idempotent migration", () => {
  test("boots against a pre-existing DB missing error_text/request_id/caller/text_json", () => {
    const dbPath = tempDbPath();
    createLegacySchema(dbPath);

    // Must not throw — db.prepare() would fail at boot if a bind param
    // referenced a column that isn't there yet.
    expect(() => buildSqliteSink(dbPath)).not.toThrow();
  });

  test("a row written after migration carries request_id/caller/text_json", () => {
    const dbPath = tempDbPath();
    createLegacySchema(dbPath);
    const sink = buildSqliteSink(dbPath);

    runWithRequestContext({ requestId: "req-legacy-1", caller: "hermes" }, () => {
      sink.record({
        endpoint: "speech-request",
        model: "gemini-3.1-flash-tts-preview",
        status: 200,
        latencyMs: 42,
        text: { input: "hallo welt", output: "hallo welt gesprochen" },
      } satisfies UsageRow);
    });

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT * FROM usage_record ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    db.close();

    expect(row["request_id"]).toBe("req-legacy-1");
    expect(row["caller"]).toBe("hermes");
    expect(JSON.parse(String(row["text_json"]))).toEqual({ input: "hallo welt", output: "hallo welt gesprochen" });
  });
});

describe("resolveText", () => {
  const row: UsageRow = {
    endpoint: "speech-request",
    model: "m",
    status: 200,
    latencyMs: 1,
    text: { input: "a".repeat(700), output: "short" },
  };

  test("truncates input/output to 600 chars", () => {
    const text = resolveText(row, true);
    expect(text?.input).toHaveLength(600);
    expect(text?.output).toBe("short");
  });

  test("returns null when keepText is false", () => {
    expect(resolveText(row, false)).toBeNull();
  });

  test("returns null when the row carries no text", () => {
    expect(resolveText({ endpoint: "speech", model: "m", status: 200, latencyMs: 1 }, true)).toBeNull();
  });
});

describe("request-correlation context", () => {
  test("setRequestMeta/getRequestMeta round-trip inside runWithRequestContext", () => {
    runWithRequestContext({ requestId: "req-1", caller: "argo" }, () => {
      expect(getRequestMeta()).toEqual({});
      setRequestMeta({ mode: "prep", lane: "gemini" });
      setRequestMeta({ chunks: 3 });
      expect(getRequestMeta()).toEqual({ mode: "prep", lane: "gemini", chunks: 3 });
    });
  });

  test("setRequestMeta is a no-op outside a request context", () => {
    expect(() => setRequestMeta({ mode: "direct" })).not.toThrow();
    expect(getRequestMeta()).toEqual({});
  });

  test("survives an await boundary", async () => {
    await runWithRequestContext({ requestId: "req-async", caller: "hermes" }, async () => {
      await Promise.resolve();
      setRequestMeta({ title: "after await" });
      expect(getRequestMeta()).toEqual({ title: "after await" });
    });
  });
});
