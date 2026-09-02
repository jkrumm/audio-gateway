import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface UsageRow {
  /** Drop the dead 'models' member (Decision 2 / §10 bug fix). */
  endpoint:
    | "transcriptions"
    | "speech"
    | "speech-prep"
    | "speech-summary"
    | "speech-request"
    | "transcription-request"
    | "podcast-cover"
    | "podcast-outline"
    | "podcast-segment"
    | "podcast-review"
    | "podcast-request";
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
  /**
   * Request/response text for quality review — only ever set on the
   * `*-request` summary rows, never on per-chunk rows. Truncated to 600 chars
   * and gated by `USAGE_KEEP_TEXT` inside the sink (see `resolveText`).
   */
  text?: { input?: string; output?: string } | null;
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
// Request correlation (AsyncLocalStorage)
// ---------------------------------------------------------------------------

/**
 * Metadata a lane handler (gemini-tts.ts, replicate-tts.ts) can enrich for the
 * CURRENT request without changing its own return type — the dispatcher
 * (speech.ts/transcriptions.ts) reads it back via `getRequestMeta()` right
 * after the lane call returns, to build the one `*-request` summary row.
 */
export interface RequestMeta {
  mode?: "direct" | "prep" | "summary" | "passthrough";
  lane?: "gemini" | "replicate" | "passthrough";
  chunks?: number;
  languageCode?: string;
  voice?: string;
  title?: string;
  outputText?: string;
  audioSeconds?: number;
  bytesOut?: number;
  /** Running total across every billing-relevant `recordUsage` call in this request (see `accumulateRequestCost`). */
  costUsd?: number;
  costSource?: string;
  /** Running total of `inputChars` across `endpoint: "speech"` rows — the char count ElevenLabs bills on. */
  charsBilled?: number;
  /** `rawFetch` 503/429 backoff attempts consumed anywhere in this request (see `recordRetry`). */
  retries?: number;
}

interface RequestContextValue {
  requestId: string;
  caller: string;
  meta: RequestMeta;
}

const requestContext = new AsyncLocalStorage<RequestContextValue>();

/**
 * Run `fn` inside a fresh request-correlation context. Every `recordUsage`
 * call made (directly or transitively, across awaits) while `fn` is running
 * is stamped with `requestId`/`caller` — no signature churn on `recordUsage`
 * or any of its call-sites across the TTS/STT lanes.
 */
export function runWithRequestContext<T>(ctx: { requestId: string; caller: string }, fn: () => T): T {
  return requestContext.run({ ...ctx, meta: {} }, fn);
}

/** Merge fields into the current request's metadata accumulator. No-op outside a request context. */
export function setRequestMeta(patch: RequestMeta): void {
  const store = requestContext.getStore();
  if (store) Object.assign(store.meta, patch);
}

/** Read the current request's accumulated metadata (used to build the `*-request` summary row). */
export function getRequestMeta(): RequestMeta {
  return requestContext.getStore()?.meta ?? {};
}

/** Increment the current request's retry counter. No-op outside a request context. */
export function recordRetry(): void {
  const store = requestContext.getStore();
  if (store) store.meta.retries = (store.meta.retries ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// In-flight request gauge — a single module-level counter of concurrently
// dispatching Server requests. Not request-scoped (there is nothing to read
// back via AsyncLocalStorage until the request itself starts), so it lives as
// plain module state; handleSpeech/handleTranscriptions pair start/end in a
// try/finally around the whole dispatch.
// ---------------------------------------------------------------------------

let inflightCount = 0;

/** Mark one more request in flight; returns the new count (including this one). */
export function inflightStart(): number {
  return ++inflightCount;
}

/** Mark one request as finished (success or failure). */
export function inflightEnd(): void {
  inflightCount = Math.max(0, inflightCount - 1);
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
  perInputChars1k?: number; // Replicate ElevenLabs TTS, USD per 1,000 input characters
}

// USD list prices used as ESTIMATES — IU's actual EU per-token rates may differ
// (same caveat as usage-tracker/src/pricing.ts). cost_source is stamped 'estimated'.
const RATES: Record<string, Rate> = {
  "gpt-4o-transcribe": { input: 2.5, audioInput: 6, output: 10 },
  // Published rates (platform.openai.com/docs/pricing, verified 2026-07-24): a
  // single $1.25/1M input rate covering BOTH audio and text — no split — and
  // $5/1M output. Both input fields carry the same number so the split logic
  // below lands on $1.25 either way.
  "gpt-4o-mini-transcribe": { input: 1.25, audioInput: 1.25, output: 5 },
  // INFERRED, not published: OpenAI lists no separate line item for the diarize
  // variant, so it inherits gpt-4o-transcribe's rates on the assumption that a
  // feature flag doesn't change billing. Re-check if diarization spend matters.
  "gpt-4o-transcribe-diarize": { input: 2.5, audioInput: 6, output: 10 },
  // Deliberately absent: `voxtral-mini-transcribe-realtime-2602`. Mistral
  // publishes no per-token or per-minute rate for it anywhere (checked
  // 2026-07-24 — pricing pages, La Plateforme, docs); it is listed as an open
  // model. Unpriced reports as `cost_source: 'none'`, which is the honest
  // answer. Don't invent a number to make the row look complete.
  "whisper": { perMinute: 0.006 },
  "gemini-3.1-flash-tts-preview": { input: 0.5, output: 10 }, // output tokens are audio tokens
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
  // Replicate pricing page, verified 2026-08-26: $0.05 per 1,000 input characters.
  "flash-v2.5": { perInputChars1k: 0.05 },
  // Not published as a separate line item by Replicate — assumed identical to
  // flash-v2.5 pending a dedicated rate. Re-check if turbo spend matters.
  "turbo-v2.5": { perInputChars1k: 0.05 }, // unverified
  // ElevenLabs' own API list price for Eleven v3 (elevenlabs.io/pricing/api,
  // verified 2026-09-02): $0.10 per 1,000 characters. Replicate publishes no
  // separate line for elevenlabs/v3, so this is the upstream price, not a
  // measured Replicate invoice — good enough to stop podcast episodes
  // reporting cost_usd = null.
  "v3": { perInputChars1k: 0.1 },
};

interface CostInputs {
  inputTokens: number | null;
  outputTokens: number | null;
  audioTokens: number | null;
  audioSeconds: number | null;
  inputChars: number | null;
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

  // Per-1k-input-chars models (Replicate ElevenLabs TTS): need input chars.
  if (rate.perInputChars1k != null) {
    if (c.inputChars == null) return { costUsd: null, costSource: "none" };
    return { costUsd: (c.inputChars / 1000) * rate.perInputChars1k, costSource: "estimated" };
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

/**
 * Compute cost for one usage row, deriving the same {@link CostInputs} shape
 * both the HTTP sink and the request-level accumulator (below) need — the
 * single place `computeCost`/`RATES` are applied to a `UsageRow`, so the sink
 * and the root-span attributes always report the same number.
 */
function costForRow(row: UsageRow): { costUsd: number | null; costSource: string } {
  const t = tokens(row.usageJson);
  return computeCost(normalizeModel(row.model), {
    inputTokens: row.inputTokens ?? t.input,
    outputTokens: row.outputTokens ?? t.output,
    audioTokens: row.audioTokens ?? t.audioTokens,
    audioSeconds: row.audioSeconds ?? t.audioSeconds,
    inputChars: row.inputChars ?? null,
  });
}

/**
 * The `*-request` summary rows are a correlation/reporting artifact, not a
 * billed call — costing them would double-count spend already carried by the
 * per-chunk rows they summarize (mirrors the HTTP sink's `isRequestSummary` gate).
 */
const isRequestSummaryEndpoint = (endpoint: UsageRow["endpoint"]): boolean =>
  endpoint === "speech-request" || endpoint === "transcription-request" || endpoint === "podcast-request";

/**
 * Fold one row's cost into the active request's running total (`RequestMeta.costUsd`/
 * `costSource`) and, for TTS `speech` rows, the char count ElevenLabs bills on
 * (`charsBilled`). No-op outside a request context or for summary rows.
 */
function accumulateRequestCost(row: UsageRow): void {
  const store = requestContext.getStore();
  if (!store || isRequestSummaryEndpoint(row.endpoint)) return;

  const cost = costForRow(row);
  if (cost.costUsd != null) {
    store.meta.costUsd = (store.meta.costUsd ?? 0) + cost.costUsd;
    store.meta.costSource = "estimated";
  } else if (store.meta.costSource !== "estimated") {
    store.meta.costSource = "none";
  }

  if (row.endpoint === "speech" && row.inputChars != null) {
    store.meta.charsBilled = (store.meta.charsBilled ?? 0) + row.inputChars;
  }
}

// ---------------------------------------------------------------------------
// Text handling — quality-review snippets, gated + truncated
// ---------------------------------------------------------------------------

const TEXT_MAX_CHARS = 600;

const truncate = (s: string | undefined): string | undefined =>
  s === undefined ? undefined : s.length > TEXT_MAX_CHARS ? s.slice(0, TEXT_MAX_CHARS) : s;

/**
 * Resolve the text object to persist for a row: `null` when `keepText` is off
 * or the row carries no text, otherwise the input/output truncated to
 * `TEXT_MAX_CHARS`. Centralised here so both sinks (sqlite text_json, http
 * raw.text) apply the exact same gate — personal data, opt-out by design.
 * Takes `keepText` as a parameter (rather than reading `config.usageKeepText`
 * directly) so it's unit-testable independent of the config singleton.
 */
export function resolveText(
  row: UsageRow,
  keepText: boolean = config.usageKeepText,
): { input?: string; output?: string } | null {
  if (!keepText || !row.text) return null;
  const input = truncate(row.text.input);
  const output = truncate(row.text.output);
  if (input === undefined && output === undefined) return null;
  return { ...(input !== undefined && { input }), ...(output !== undefined && { output }) };
}

// ---------------------------------------------------------------------------
// SQLite adapter (default)
// ---------------------------------------------------------------------------

// Exported so tests can build a sink against an arbitrary path directly —
// `config.usageDb` is a process-wide singleton (see routes.test.ts), which
// would make it impossible to test the idempotent-migration boot path
// against a temp DB file from within the same `bun test` process.
export function buildSqliteSink(dbPath: string): UsageSink {
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
      usage_json      TEXT,                       -- raw upstream usage object
      request_id      TEXT,                       -- correlates every row of one HTTP request
      caller          TEXT,                       -- x-audio-source header value
      text_json       TEXT                        -- {input?,output?} on *-request rows only (USAGE_KEEP_TEXT)
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_record (ts);");

  // Idempotent column migration: the prod DB predates error_text/request_id/
  // caller/text_json. If we reference their bind params in the prepared INSERT
  // (or index a column) without adding it first, db.prepare()/db.exec() throws
  // at boot time on the old schema — so add whichever are still missing BEFORE
  // anything else touches those columns.
  const cols = db.query("PRAGMA table_info(usage_record)").all() as Array<{ name: string }>;
  const existingCols = new Set(cols.map((c) => c.name));
  const newColumns = ["error_text", "request_id", "caller", "text_json"];
  for (const name of newColumns) {
    if (!existingCols.has(name)) db.exec(`ALTER TABLE usage_record ADD COLUMN ${name} TEXT`);
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_request_id ON usage_record (request_id);");

  const insert = db.prepare(`
    INSERT INTO usage_record
      (ts, endpoint, model, status, latency_ms, response_format,
       input_tokens, output_tokens, audio_tokens, audio_seconds,
       input_chars, bytes_out, usage_json, error_text,
       request_id, caller, text_json)
    VALUES
      ($ts, $endpoint, $model, $status, $latencyMs, $responseFormat,
       $inputTokens, $outputTokens, $audioTokens, $audioSeconds,
       $inputChars, $bytesOut, $usageJson, $errorText,
       $requestId, $caller, $textJson)
  `);

  return {
    record(row: UsageRow): void {
      const t = tokens(row.usageJson);
      const ctx = requestContext.getStore();
      const text = resolveText(row);
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
        $requestId: ctx?.requestId ?? null,
        $caller: ctx?.caller ?? null,
        $textJson: text ? JSON.stringify(text) : null,
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
      // The *-request summary rows are a correlation/reporting artifact — the
      // per-chunk rows (speech/speech-prep/speech-summary/transcriptions)
      // already carry the billed cost. Costing the summary row too would
      // double-count spend against the same request.
      const cost = isRequestSummaryEndpoint(row.endpoint) ? { costUsd: null, costSource: "none" as const } : costForRow(row);
      const now = new Date().toISOString();
      const ctx = requestContext.getStore();
      const text = resolveText(row);

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
          request_id: ctx?.requestId ?? null,
          caller: ctx?.caller ?? null,
          text: text ?? null,
        },
      };

      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.argoApiSecret}` },
        body: JSON.stringify({ records: [record] }),
      }).then((res) => {
        // A non-2xx response does NOT reject the fetch promise, so surface it
        // explicitly — otherwise an auth/schema rejection from Argo drops usage
        // silently. Network errors still bubble to safeRecord's .catch.
        if (!res.ok) console.error(`[usage] argo push rejected: ${res.status} ${res.statusText}`);
      });
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
  accumulateRequestCost(row);
  safeRecord(sink, row);
}

// ---------------------------------------------------------------------------
// Test helper — expose the underlying sink for assertions in route tests
// ---------------------------------------------------------------------------
export { sink as _sink };
