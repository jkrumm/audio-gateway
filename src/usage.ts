import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface UsageRow {
  /** Drop the dead 'models' member (Decision 2 / §10 bug fix). */
  endpoint: "transcriptions" | "speech" | "speech-prep";
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
      endpoint        TEXT    NOT NULL,          -- 'transcriptions' | 'speech' | 'speech-prep'
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

  const insert = db.prepare(`
    INSERT INTO usage_record
      (ts, endpoint, model, status, latency_ms, response_format,
       input_tokens, output_tokens, audio_tokens, audio_seconds,
       input_chars, bytes_out, usage_json)
    VALUES
      ($ts, $endpoint, $model, $status, $latencyMs, $responseFormat,
       $inputTokens, $outputTokens, $audioTokens, $audioSeconds,
       $inputChars, $bytesOut, $usageJson)
  `);

  /** Extract OpenAI/Voxtral token counts from an upstream usage object. */
  const tokens = (usage: unknown) => {
    const u = (usage ?? {}) as Record<string, unknown>;
    const details = (u["input_token_details"] ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      input: num(u["input_tokens"]) ?? num(u["prompt_tokens"]),
      output: num(u["output_tokens"]) ?? num(u["completion_tokens"]),
      audioTokens: num(details["audio_tokens"]),
      audioSeconds: num(u["prompt_audio_seconds"]),
    };
  };

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
      });
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP adapter — Phase-3 seam (Decision 3)
// ---------------------------------------------------------------------------

function buildHttpSink(_url: string, _sourceLabel: string): UsageSink {
  return {
    record(_row: UsageRow): void {
      // TODO(phase-3): POST to Argo /usage/records
      // Body shape TBD once Argo's /usage endpoint is defined.
      // Fields: endpoint, model, status, latencyMs, ..., source: _sourceLabel
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
