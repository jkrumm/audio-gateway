import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface UsageRow {
  /** Drop the dead 'models' member (Decision 2 / §10 bug fix). */
  endpoint: "transcriptions" | "speech" | "speech-prep" | "speech-summary";
  model: string;
  status: number;
  latencyMs: number;
  responseFormat?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  audioTokens?: number | null;
  audioSeconds?: number | null;
  inputChars?: number | null;
  bytesOut?: number | null;
  usageJson?: unknown;
  /** Truncated upstream error body for non-2xx responses (max 500 chars). */
  errorText?: string | null;
}

// ---------------------------------------------------------------------------
// Ports & adapters (Decision 3)
// ---------------------------------------------------------------------------

/**
 * Single method a usage sink must implement. An adapter MAY throw (or reject);
 * the public `recordUsage` boundary and the composite "both" sink isolate and
 * swallow failures so a sink error never breaks or delays an audio/STT response.
 */
export interface UsageSink {
  record(row: UsageRow): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared token-extraction helper
// ---------------------------------------------------------------------------

/** Extract OpenAI/Voxtral token counts from an upstream usage object. */
function tokens(usage: unknown): {
  input: number | null;
  output: number | null;
  audioTokens: number | null;
  audioSeconds: number | null;
} {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u["input_token_details"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    input: num(u["input_tokens"]) ?? num(u["prompt_tokens"]),
    output: num(u["output_tokens"]) ?? num(u["completion_tokens"]),
    audioTokens: num(details["audio_tokens"]),
    audioSeconds: num(u["prompt_audio_seconds"]),
  };
}

// ---------------------------------------------------------------------------
// Model normalisation
// ---------------------------------------------------------------------------

/**
 * Lowercase, keep the segment after the last `/`, strip a trailing `-eu`,
 * strip a trailing `-YYYYMMDD` date suffix.
 */
function normalizeModel(raw: string): string {
  let m = raw.toLowerCase().trim();
  if (m.includes("/")) m = m.split("/").pop() ?? m;
  return m.replace(/-eu$/, "").replace(/-\d{8}$/, "");
}

// ---------------------------------------------------------------------------
// Rate table + cost function
// ---------------------------------------------------------------------------

interface Rate {
  input?: number; // text input, USD per 1M tokens
  audioInput?: number; // audio input tokens, USD per 1M (STT split)
  output?: number; // output tokens, USD per 1M
  perMinute?: number; // whisper-style, USD per minute of audio
}

// USD list prices used as ESTIMATES — IU's actual EU per-token rates may differ
// (same caveat as usage-tracker/src/pricing.ts). cost_source is stamped 'estimated'.
const RATES: Record<string, Rate> = {
  "gpt-4o-transcribe": { input: 2.5, audioInput: 6, output: 10 },
  "whisper": { perMinute: 0.006 },
  "gemini-3.1-flash-tts-preview": { input: 0.5, output: 10 }, // output tokens are audio tokens
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
};

interface CostInputs {
  inputTokens: number | null;
  outputTokens: number | null;
  audioTokens: number | null;
  audioSeconds: number | null;
}

function computeCost(
  modelNorm: string,
  c: CostInputs,
): { costUsd: number | null; costSource: string } {
  const rate = RATES[modelNorm];
  if (!rate) return { costUsd: null, costSource: "none" };

  // Per-minute models (whisper): need audio duration.
  if (rate.perMinute != null) {
    if (c.audioSeconds == null) return { costUsd: null, costSource: "none" };
    return { costUsd: (c.audioSeconds / 60) * rate.perMinute, costSource: "estimated" };
  }

  const input = c.inputTokens ?? 0;
  const output = c.outputTokens ?? 0;
  // STT split: when a model has a distinct audio-input rate, charge audio_tokens at
  // it and the remainder at the text rate. If the split is missing, bill all input as
  // audio (conservative — STT input is audio-dominated).
  const audioIn = rate.audioInput != null ? (c.audioTokens ?? input) : 0;
  const textIn = rate.audioInput != null ? input - audioIn : input;
  const cost =
    (textIn * (rate.input ?? 0) + audioIn * (rate.audioInput ?? 0) + output * (rate.output ?? 0)) /
    1_000_000;
  return { costUsd: cost, costSource: "estimated" };
}

// ---------------------------------------------------------------------------
// SQLite adapter (default)
// ---------------------------------------------------------------------------

function buildSqliteSink(dbPath: string): UsageSink {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_record (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL,
      endpoint        TEXT    NOT NULL,          -- 'transcriptions' | 'speech' | 'speech-prep' | 'speech-summary'
      model           TEXT    NOT NULL,
      status          INTEGER NOT NULL,          -- upstream HTTP status
      latency_ms      INTEGER NOT NULL,
      response_format TEXT,                       -- requested format (STT)
      input_tokens    INTEGER,
      output_tokens   INTEGER,
      audio_tokens    INTEGER,
      audio_seconds   REAL,
      input_chars     INTEGER,                    -- TTS input length
      bytes_out       INTEGER,                    -- TTS audio size
      usage_json      TEXT                        -- raw upstream usage object
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_record (ts);");

  // Idempotent column migration: the prod DB was created without error_text.
  // If we reference $errorText in the prepared INSERT without adding the column
  // first, db.prepare() throws at boot time on the old schema.
  const cols = db.query("PRAGMA table_info(usage_record)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "error_text")) {
    db.exec("ALTER TABLE usage_record ADD COLUMN error_text TEXT");
  }

  const insert = db.prepare(`
    INSERT INTO usage_record
      (ts, endpoint, model, status, latency_ms, response_format,
       input_tokens, output_tokens, audio_tokens, audio_seconds,
       input_chars, bytes_out, usage_json, error_text)
    VALUES
      ($ts, $endpoint, $model, $status, $latencyMs, $responseFormat,
       $inputTokens, $outputTokens, $audioTokens, $audioSeconds,
       $inputChars, $bytesOut, $usageJson, $errorText)
  `);

  return {
    record(row: UsageRow): void {
      const t = tokens(row.usageJson);
      insert.run({
        $ts: new Date().toISOString(),
        $endpoint: row.endpoint,
        $model: row.model,
        $status: row.status,
        $latencyMs: row.latencyMs,
        $responseFormat: row.responseFormat ?? null,
        $inputTokens: row.inputTokens ?? t.input,
        $outputTokens: row.outputTokens ?? t.output,
        $audioTokens: row.audioTokens ?? t.audioTokens,
        $audioSeconds: row.audioSeconds ?? t.audioSeconds,
        $inputChars: row.inputChars ?? null,
        $bytesOut: row.bytesOut ?? null,
        $usageJson: row.usageJson ? JSON.stringify(row.usageJson) : null,
        $errorText: row.errorText ?? null,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP adapter — Phase-3 (Decision 3)
// ---------------------------------------------------------------------------

function buildHttpSink(url: string, sourceLabel: string): UsageSink {
  // No-op guard: HTTP sink is optional; both URL and auth secret must be set.
  if (!url || !config.argoApiSecret) {
    return { record(_row: UsageRow): void {} };
  }

  return {
    record(row: UsageRow): Promise<void> {
      const t = tokens(row.usageJson);
      const inputTokens = row.inputTokens ?? t.input;
      const outputTokens = row.outputTokens ?? t.output;
      const audioTokens = row.audioTokens ?? t.audioTokens;
      const audioSeconds = row.audioSeconds ?? t.audioSeconds;

      const modelNorm = normalizeModel(row.model);
      const cost = computeCost(modelNorm, { inputTokens, outputTokens, audioTokens, audioSeconds });
      const now = new Date().toISOString();

      const record = {
        source: sourceLabel,
        source_id: crypto.randomUUID(),
        grain: "request",
        ts: now,
        ingested_at: now,
        model: row.model,
        model_norm: modelNorm,
        project: "audio-gateway",
        workspace: "private",
        sub_tool: row.endpoint,
        machine: config.machine,
        billing: "iu",
        outcome: row.status < 400 ? "ok" : "error",
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        duration_ms: row.latencyMs,
        cost_usd: cost.costUsd,
        cost_source: cost.costSource,
        raw: {
          audio_tokens: audioTokens,
          audio_seconds: audioSeconds,
          input_chars: row.inputChars ?? null,
          bytes_out: row.bytesOut ?? null,
          response_format: row.responseFormat ?? null,
          error_text: row.errorText ?? null,
        },
      };

      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.argoApiSecret}` },
        body: JSON.stringify({ records: [record] }),
      }).then(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Sink factory — select by USAGE_SINK
// ---------------------------------------------------------------------------

function buildSink(): UsageSink {
  const sqlite = buildSqliteSink(config.usageDb);
  if (config.usageSink === "sqlite") return sqlite;

  const http = buildHttpSink(config.usageHttpUrl, config.usageSourceLabel);
  if (config.usageSink === "http") return http;

  // "both" — isolate each adapter so a failure in one never drops the other's write.
  return {
    record(row: UsageRow): void {
      safeRecord(sqlite, row);
      safeRecord(http, row);
    },
  };
}

const sink = buildSink();

// ---------------------------------------------------------------------------
// Fail-safe public record path (Decision 3)
// ---------------------------------------------------------------------------

/**
 * Invoke a sink, swallowing both synchronous throws and async rejections. Never
 * throws — a usage-sink failure MUST NEVER break or delay an audio/STT response.
 */
function safeRecord(target: UsageSink, row: UsageRow): void {
  try {
    const result = target.record(row);
    if (result instanceof Promise) {
      result.catch((err: unknown) => console.error("[usage] sink write failed:", err));
    }
  } catch (err) {
    console.error("[usage] sink write failed:", err);
  }
}

/** Record a usage row via the active sink (fail-safe — see {@link safeRecord}). */
export function recordUsage(row: UsageRow): void {
  safeRecord(sink, row);
}

// ---------------------------------------------------------------------------
// Test helper — expose the underlying sink for assertions in route tests
// ---------------------------------------------------------------------------
export { sink as _sink };
