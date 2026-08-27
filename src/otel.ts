import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config";

// ---------------------------------------------------------------------------
// OpenTelemetry traces + logs, exported as OTLP/HTTP JSON — no SDK, `fetch`
// only. One root span per HTTP request (kind SERVER), child spans per
// pipeline stage. Disabled (a total no-op on the network path) unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set; span/log record CONSTRUCTION always
// happens (cheap bookkeeping, and what makes this module testable without a
// live endpoint) — only the queue-and-fetch step is gated.
//
// The trace id for a request is DERIVED from its request id (usage.ts's
// AsyncLocalStorage-carried UUID, dashes stripped to 32 hex) — see
// `traceIdFromRequestId` — so a trace and its usage_record/Argo rows join on
// the same value with no extra correlation column.
// ---------------------------------------------------------------------------

const ENABLED = config.otelEndpoint !== "";

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

/** Read `version` out of package.json once at module load — never throws. */
function readPackageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVICE_VERSION = readPackageVersion();

// ---------------------------------------------------------------------------
// Attribute values
// ---------------------------------------------------------------------------

type AttrValue = string | number | boolean;
export type SpanAttributes = Record<string, AttrValue | null | undefined>;

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function toOtlpValue(v: AttrValue): OtlpValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

/** Drop null/undefined; stringify anything that isn't already string/number/boolean. */
function normalizeAttrValue(raw: unknown): AttrValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function toOtlpAttributes(attrs: Record<string, unknown>): Array<{ key: string; value: OtlpValue }> {
  const out: Array<{ key: string; value: OtlpValue }> = [];
  for (const [key, raw] of Object.entries(attrs)) {
    const value = normalizeAttrValue(raw);
    if (value === undefined) continue;
    out.push({ key, value: toOtlpValue(value) });
  }
  return out;
}

/**
 * Parse the standard `OTEL_RESOURCE_ATTRIBUTES` env var (`key=value,key=value`,
 * per the OTel resource SDK spec) so a compose file can override any default
 * below without a code change. Malformed pairs (no `=`) are skipped. Exported
 * (pure, no env read) so otel.test.ts can exercise the parsing directly.
 */
export function parseResourceAttributesEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

const RESOURCE = {
  attributes: toOtlpAttributes({
    "service.name": config.otelServiceName,
    "service.version": SERVICE_VERSION,
    "deployment.environment": config.deploymentEnvironment,
    "host.name": config.machine,
    ...parseResourceAttributesEnv(process.env["OTEL_RESOURCE_ATTRIBUTES"] ?? ""),
  }),
};

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive a 32-hex OTel trace id from a request UUID (dashes stripped) — the
 * join key between usage_record.request_id / Argo rows and this trace. Falls
 * back to a fresh random trace id if `requestId` isn't UUID-shaped.
 */
export function traceIdFromRequestId(requestId: string): string {
  const hex = requestId.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function newTraceId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function newSpanId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

function nowNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

// ---------------------------------------------------------------------------
// Span kind / status codes (OTLP proto enums)
// ---------------------------------------------------------------------------

export type SpanKind = "internal" | "server" | "client";
const KIND_CODE: Record<SpanKind, number> = { internal: 1, server: 2, client: 3 };

export type StatusCode = "unset" | "ok" | "error";
const STATUS_CODE: Record<StatusCode, number> = { unset: 0, ok: 1, error: 2 };

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttributes(attrs: SpanAttributes): void;
  setStatus(code: StatusCode, message?: string): void;
  recordException(err: unknown): void;
  end(attrs?: SpanAttributes): void;
}

interface SpanEventData {
  name: string;
  timeUnixNano: string;
  attributes: SpanAttributes;
}

interface InternalSpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: bigint;
  attributes: SpanAttributes;
  statusCode: StatusCode;
  statusMessage: string | undefined;
  events: SpanEventData[];
  ended: boolean;
}

const currentSpan = new AsyncLocalStorage<InternalSpanData>();

const NOOP_SPAN: Span = {
  traceId: "",
  spanId: "",
  setAttributes() {},
  setStatus() {},
  recordException() {},
  end() {},
};

function createSpanData(name: string, kind: SpanKind, attrs?: SpanAttributes, explicitTraceId?: string): InternalSpanData {
  const parent = currentSpan.getStore();
  return {
    traceId: explicitTraceId ?? parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.spanId,
    name,
    kind,
    startTimeUnixNano: nowNanos(),
    attributes: { ...attrs },
    statusCode: "unset",
    statusMessage: undefined,
    events: [],
    ended: false,
  };
}

function toPublicSpan(data: InternalSpanData): Span {
  return {
    traceId: data.traceId,
    spanId: data.spanId,
    setAttributes(attrs: SpanAttributes): void {
      Object.assign(data.attributes, attrs);
    },
    setStatus(code: StatusCode, message?: string): void {
      data.statusCode = code;
      if (message) data.statusMessage = message;
    },
    recordException(err: unknown): void {
      const message = err instanceof Error ? err.message : String(err);
      data.events.push({
        name: "exception",
        timeUnixNano: nowNanos().toString(),
        attributes: {
          "exception.type": err instanceof Error ? err.name : "Error",
          "exception.message": message,
          ...(err instanceof Error && err.stack ? { "exception.stacktrace": err.stack.slice(0, 2000) } : {}),
        },
      });
    },
    end(attrs?: SpanAttributes): void {
      if (data.ended) return;
      if (attrs) Object.assign(data.attributes, attrs);
      data.ended = true;
      exportSpan(data);
    },
  };
}

/** Start a span. Parent is whatever span is active on the AsyncLocalStorage; a root has none. */
export function startSpan(name: string, attrs?: SpanAttributes, kind: SpanKind = "internal"): Span {
  return toPublicSpan(createSpanData(name, kind, attrs));
}

/** The currently active span (via `withSpan`/`withRootSpan`), or a no-op span if none. */
export function getActiveSpan(): Span {
  const data = currentSpan.getStore();
  return data ? toPublicSpan(data) : NOOP_SPAN;
}

async function runInSpan<T>(data: InternalSpanData, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = toPublicSpan(data);
  return currentSpan.run(data, async () => {
    try {
      const result = await fn(span);
      if (data.statusCode === "unset") span.setStatus("ok");
      return result;
    } catch (err) {
      span.setStatus("error", err instanceof Error ? err.message : String(err));
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Run `fn` inside a new child span (parent = whatever span is currently
 * active). Ends the span on settle either way, marking error status +
 * recording the exception on a throw.
 */
export function withSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = "internal",
): Promise<T> {
  return runInSpan(createSpanData(name, kind, attrs), fn);
}

/**
 * Run `fn` inside a new ROOT span with an explicit trace id (derived from the
 * request id — see `traceIdFromRequestId`). Used once per HTTP request,
 * wrapping the dispatcher; the request handler enriches the span via
 * `getActiveSpan().setAttributes(...)` as request metadata becomes known
 * (mirrors the `setRequestMeta`/`getRequestMeta` pattern in usage.ts).
 */
export function withRootSpan<T>(
  params: { traceId: string; name: string; attrs?: SpanAttributes; kind?: SpanKind },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runInSpan(createSpanData(params.name, params.kind ?? "server", params.attrs, params.traceId), fn);
}

// ---------------------------------------------------------------------------
// OTLP JSON record shapes + payload builders (pure — no ENABLED gate, so
// otel.test.ts can exercise them directly)
// ---------------------------------------------------------------------------

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: OtlpValue }>;
  status: { code: number; message?: string };
  events?: Array<{ name: string; timeUnixNano: string; attributes: Array<{ key: string; value: OtlpValue }> }>;
}

export interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: Array<{ key: string; value: OtlpValue }>;
  traceId?: string;
  spanId?: string;
}

function spanRecord(data: InternalSpanData): SpanRecord {
  return {
    traceId: data.traceId,
    spanId: data.spanId,
    ...(data.parentSpanId ? { parentSpanId: data.parentSpanId } : {}),
    name: data.name,
    kind: KIND_CODE[data.kind],
    startTimeUnixNano: data.startTimeUnixNano.toString(),
    endTimeUnixNano: nowNanos().toString(),
    attributes: toOtlpAttributes(data.attributes),
    status: { code: STATUS_CODE[data.statusCode], ...(data.statusMessage ? { message: data.statusMessage } : {}) },
    ...(data.events.length
      ? {
          events: data.events.map((e) => ({
            name: e.name,
            timeUnixNano: e.timeUnixNano,
            attributes: toOtlpAttributes(e.attributes),
          })),
        }
      : {}),
  };
}

export function buildTracesPayload(spans: SpanRecord[]): object {
  return {
    resourceSpans: [
      { resource: RESOURCE, scopeSpans: [{ scope: { name: config.otelServiceName }, spans }] },
    ],
  };
}

export function buildLogsPayload(logs: LogRecord[]): object {
  return {
    resourceLogs: [
      { resource: RESOURCE, scopeLogs: [{ scope: { name: config.otelServiceName }, logRecords: logs }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Export — batched, fire-and-forget, never throws
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 2000;
const BATCH_MAX = 100;
const FETCH_TIMEOUT_MS = 5000;
const FAILURE_LOG_INTERVAL_MS = 60_000;

const spanQueue: SpanRecord[] = [];
const logQueue: LogRecord[] = [];

/** Test-only observers — fire on every span/log record built, independent of ENABLED. */
let spanHook: ((record: SpanRecord) => void) | null = null;
let logHook: ((record: LogRecord) => void) | null = null;

let lastFailureLogAt = 0;

/**
 * POST one OTLP JSON batch. Never throws — a non-ok response or a network
 * failure is rate-limited (at most once/minute) to `console.error` directly,
 * deliberately bypassing `log.ts` (which itself feeds `emitLog`) so an
 * export failure can never route back through the exporter it's reporting on.
 */
async function postBatch(url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) reportExportFailure(`export rejected: ${res.status} ${res.statusText}`);
  } catch (err) {
    reportExportFailure(`export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function reportExportFailure(message: string): void {
  const now = Date.now();
  if (now - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLogAt = now;
  console.error(`[otel] ${message}`);
}

async function flush(): Promise<void> {
  if (!ENABLED) return;
  const spans = spanQueue.splice(0, spanQueue.length);
  const logs = logQueue.splice(0, logQueue.length);
  const tasks: Promise<void>[] = [];
  if (spans.length) tasks.push(postBatch(`${config.otelEndpoint}/v1/traces`, buildTracesPayload(spans)));
  if (logs.length) tasks.push(postBatch(`${config.otelEndpoint}/v1/logs`, buildLogsPayload(logs)));
  if (tasks.length) await Promise.allSettled(tasks);
}

function exportSpan(data: InternalSpanData): void {
  const record = spanRecord(data);
  spanHook?.(record);
  if (!ENABLED) return;
  spanQueue.push(record);
  if (spanQueue.length >= BATCH_MAX) void flush();
}

export type LogSeverity = "info" | "warn" | "error";
const SEVERITY_NUMBER: Record<LogSeverity, number> = { info: 9, warn: 13, error: 17 };

/** Emit one OTLP log record, stamped with the active span's trace/span id if any. */
export function emitLog(severity: LogSeverity, message: string, fields?: Record<string, unknown>): void {
  const active = currentSpan.getStore();
  const record: LogRecord = {
    timeUnixNano: nowNanos().toString(),
    severityNumber: SEVERITY_NUMBER[severity],
    severityText: severity.toUpperCase(),
    body: { stringValue: message },
    attributes: toOtlpAttributes(fields ?? {}),
    ...(active ? { traceId: active.traceId, spanId: active.spanId } : {}),
  };
  logHook?.(record);
  if (!ENABLED) return;
  logQueue.push(record);
  if (logQueue.length >= BATCH_MAX) void flush();
}

/** Final flush — call from the SIGTERM/SIGINT drain path before exit. */
export async function flushOtel(): Promise<void> {
  await flush();
}

if (ENABLED) {
  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// Test-only seam — otel.test.ts observes real span/log records built by the
// real code path without a live endpoint (ENABLED stays false across the
// whole `bun test` process; see the shared config baseline in every
// config-touching test file) and exercises the network primitive directly
// against a stubbed `fetch`.
// ---------------------------------------------------------------------------
export const _test = {
  onSpanExport(hook: ((record: SpanRecord) => void) | null): void {
    spanHook = hook;
  },
  onLogExport(hook: ((record: LogRecord) => void) | null): void {
    logHook = hook;
  },
  postBatch,
};
