/**
 * Unit tests for usage.ts: the idempotent-migration boot path against a
 * legacy (pre-correlation) DB schema, the text truncation/gate, the
 * request-correlation context (AsyncLocalStorage), rate/cache pricing, and
 * the argo HTTP sink's payload shape (stubs globalThis.fetch, no real network).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

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

const { buildHttpSink, buildSqliteSink, getRequestMeta, resolveText, runWithRequestContext, setRequestMeta } = await import(
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

describe("podcast model rates", () => {
  test("prices the writers' room models and passes the cover's own cost through", async () => {
    const { computeCost } = await import("./usage");
    const opus = computeCost("claude-opus-4-6", { inputTokens: 1_000_000, outputTokens: 100_000, audioTokens: null, audioSeconds: null, inputChars: null });
    expect(opus.costUsd).toBeCloseTo(7.5, 6);
    expect(computeCost("gpt-5.6-luna", { inputTokens: 1_000_000, outputTokens: 0, audioTokens: null, audioSeconds: null, inputChars: null }).costUsd).toBeCloseTo(0.2, 6);
    expect(computeCost("gemini-3.1-pro-preview", { inputTokens: 0, outputTokens: 1_000_000, audioTokens: null, audioSeconds: null, inputChars: null }).costUsd).toBeCloseTo(12, 6);
    // No `verified` flag on this rate — an unconfirmed vendor list price stamps 'assumed', not 'estimated'.
    expect(computeCost("claude-opus-4-6-eu".replace(/-eu$/, ""), { inputTokens: 1000, outputTokens: 0, audioTokens: null, audioSeconds: null, inputChars: null }).costSource).toBe("assumed");
  });

  test("prices deepseek-v4.1-flash (2026-09-13 rollout: outline/review/metadata/research/editorial) at the measured IU usage.cost rate", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("deepseek-v4.1-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000, audioTokens: null, audioSeconds: null, inputChars: null });
    expect(result.costUsd).toBeCloseTo(0.5 + 1.5, 6);
    expect(result.costSource).toBe("assumed");
  });

  test("glm-5.3-flash carries a rate now (was missing entirely)", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("glm-5.3-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000, audioTokens: null, audioSeconds: null, inputChars: null });
    expect(result.costUsd).toBeCloseTo(0.15 + 0.5, 6);
    expect(result.costSource).toBe("assumed");
  });
});

describe("prompt-cache pricing (cached_tokens is a subset of input_tokens, not additive)", () => {
  test("deepseek-v4.1-flash bills the cached portion at 0.05/1M, the remainder at 0.50/1M", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("deepseek-v4.1-flash", {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 0,
      audioTokens: null,
      audioSeconds: null,
      inputChars: null,
    });
    // 600k uncached @ $0.50/1M + 400k cached @ $0.05/1M
    expect(result.costUsd).toBeCloseTo(0.6 * 0.5 + 0.4 * 0.05, 6);
  });

  test("gpt-5.6-luna: a fully-cached call bills entirely at the cached rate", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("gpt-5.6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
      audioTokens: null,
      audioSeconds: null,
      inputChars: null,
    });
    expect(result.costUsd).toBeCloseTo(0.02, 6);
  });

  test("gpt-6-luna (TTS prep since 2026-09-23) prices at its own list rate; gpt-5.6-luna rows keep theirs", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("gpt-6-luna", {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 1_000_000,
      audioTokens: null,
      audioSeconds: null,
      inputChars: null,
    });
    // 600k uncached × $0.10 + 400k cached × $0.01 + 1M out × $0.50
    expect(result.costUsd).toBeCloseTo(0.06 + 0.004 + 0.5, 6);
    expect(computeCost("gpt-5.6-luna", { inputTokens: 0, outputTokens: 1_000_000, audioTokens: null, audioSeconds: null, inputChars: null }).costUsd).toBeCloseTo(1.2, 6);
  });

  test("a model with no cachedInput rate ignores cachedInputTokens and bills everything at the full input rate", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("claude-opus-4-6", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
      audioTokens: null,
      audioSeconds: null,
      inputChars: null,
    });
    expect(result.costUsd).toBeCloseTo(5, 6);
  });

  test("cachedInputTokens is clamped to inputTokens, never producing a negative uncached remainder", async () => {
    const { computeCost } = await import("./usage");
    const result = computeCost("gpt-5.6-luna", {
      inputTokens: 100,
      cachedInputTokens: 10_000, // bogus upstream figure larger than total input
      outputTokens: 0,
      audioTokens: null,
      audioSeconds: null,
      inputChars: null,
    });
    // Clamped to 100 cached, 0 uncached: 100 * 0.02 / 1e6
    expect(result.costUsd).toBeCloseTo((100 * 0.02) / 1_000_000, 9);
  });
});

describe("tokens() — prompt_tokens_details.cached_tokens extraction", () => {
  test("extracts cached_tokens from prompt_tokens_details alongside prompt/completion tokens", async () => {
    const { buildSqliteSink } = await import("./usage");
    const dbPath = tempDbPath();
    const sink = buildSqliteSink(dbPath);
    sink.record({
      endpoint: "podcast-outline",
      model: "deepseek-v4.1-flash",
      status: 200,
      latencyMs: 10,
      usageJson: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
    } satisfies UsageRow);

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT * FROM usage_record ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    db.close();
    // sqlite stores the raw total input_tokens (no cache_read_tokens column there);
    // the uncached-input convention only applies to the argo HTTP sink's payload.
    expect(row["input_tokens"]).toBe(1000);
  });
});

describe("buildHttpSink — argo payload uses the uncached-input convention", () => {
  type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  // config.ts's fields are inferred readonly; mirrors podcasts.test.ts's resolveNotifyChannel cast.
  const cfg = config as unknown as { argoApiSecret: string };

  afterEach(() => {
    delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
  });

  test("input_tokens is the uncached remainder, cache_read_tokens carries the cache hit", async () => {
    const saved = cfg.argoApiSecret;
    cfg.argoApiSecret = "test-secret";
    let sentBody: Record<string, unknown> | undefined;
    (globalThis as unknown as { fetch: FetchImpl }).fetch = (async (_url, init) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response("ok", { status: 200 });
    }) as FetchImpl;

    try {
      const sink = buildHttpSink("http://argo.test/usage/records", "audio-gateway");
      await sink.record({
        endpoint: "podcast-outline",
        model: "deepseek-v4.1-flash",
        status: 200,
        latencyMs: 5,
        usageJson: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
      } satisfies UsageRow);
    } finally {
      cfg.argoApiSecret = saved;
    }

    const record = (sentBody?.["records"] as Array<Record<string, unknown>>)?.[0];
    expect(record?.["input_tokens"]).toBe(600);
    expect(record?.["cache_read_tokens"]).toBe(400);
    expect(record?.["output_tokens"]).toBe(200);
  });

  test("no cached_tokens on the upstream usage object means cache_read_tokens stays 0", async () => {
    const saved = cfg.argoApiSecret;
    cfg.argoApiSecret = "test-secret";
    let sentBody: Record<string, unknown> | undefined;
    (globalThis as unknown as { fetch: FetchImpl }).fetch = (async (_url, init) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response("ok", { status: 200 });
    }) as FetchImpl;

    try {
      const sink = buildHttpSink("http://argo.test/usage/records", "audio-gateway");
      await sink.record({
        endpoint: "podcast-outline",
        model: "deepseek-v4.1-flash",
        status: 200,
        latencyMs: 5,
        usageJson: { prompt_tokens: 1000, completion_tokens: 200 },
      } satisfies UsageRow);
    } finally {
      cfg.argoApiSecret = saved;
    }

    const record = (sentBody?.["records"] as Array<Record<string, unknown>>)?.[0];
    expect(record?.["input_tokens"]).toBe(1000);
    expect(record?.["cache_read_tokens"]).toBe(0);
  });
});

describe("ElevenLabs pricing (per character at vendor list, contested unit)", () => {
  test("a v3 prediction bills per character at $0.10/1k and stamps 'assumed'", async () => {
    const { computeCost, normalizeModel } = await import("./usage");
    const result = computeCost(normalizeModel("elevenlabs/v3"), {
      inputTokens: null,
      outputTokens: null,
      audioTokens: null,
      audioSeconds: null,
      inputChars: 1000,
    });
    expect(result.costUsd).toBeCloseTo(0.1, 9);
    // Never 'verified': IU stated "$0.0001" in a chat message without naming a
    // unit, and per-prediction vs per-character differ by 200x. Only an actual
    // invoice line earns the verified flag.
    expect(result.costSource).toBe("assumed");
  });

  test("a v3 row with no character count is unpriced, not silently zero", async () => {
    const { computeCost, normalizeModel } = await import("./usage");
    const result = computeCost(normalizeModel("elevenlabs/v3"), {
      inputTokens: null,
      outputTokens: null,
      audioTokens: null,
      audioSeconds: null,
      inputChars: null,
    });
    expect(result.costUsd).toBeNull();
    expect(result.costSource).toBe("none");
  });

  test("turbo-v2.5 shares flash-v2.5's assumed rate", async () => {
    const { computeCost, normalizeModel } = await import("./usage");
    const result = computeCost(normalizeModel("elevenlabs/turbo-v2.5"), {
      inputTokens: null,
      outputTokens: null,
      audioTokens: null,
      audioSeconds: null,
      inputChars: 1000,
    });
    expect(result.costUsd).toBeCloseTo(0.05, 9);
    expect(result.costSource).toBe("assumed");
  });

  test("elevenlabs/v3 no longer collapses onto the bare key 'v3' (owner/name collision fix)", async () => {
    const { normalizeModel, computeCost } = await import("./usage");
    expect(normalizeModel("elevenlabs/v3")).toBe("elevenlabs/v3");
    expect(normalizeModel("elevenlabs/v3")).not.toBe("v3");
    // The bare 'v3' key no longer exists in RATES — a hypothetical future
    // `someowner/v3` must not silently inherit ElevenLabs' rate.
    expect(computeCost("v3", { inputTokens: null, outputTokens: null, audioTokens: null, audioSeconds: null, inputChars: null }).costSource).toBe("none");
  });

  test("non-slashed ids still normalize exactly as before (-eu / date-suffix stripping)", async () => {
    const { normalizeModel } = await import("./usage");
    expect(normalizeModel("claude-opus-4-6-eu")).toBe("claude-opus-4-6");
    expect(normalizeModel("whisper-20260101")).toBe("whisper");
  });
});
