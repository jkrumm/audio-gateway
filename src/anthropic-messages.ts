import { rawFetch } from "./gemini-tts";
import { iuAnthropicUrl, iuHeaders } from "./iu";
import { log } from "./log";

// Native Anthropic Messages wire on the IU Anthropic route, for the podcast
// writer when it is a `claude-*` id. Mirrors agent-gateway's `anthropicComplete`
// (server/lib/single-shot.ts, verified live 2026-10-17): `claude-opus-5-5`
// rejects `thinking: {type: "enabled"}` with a 400, so thinking is
// `{type: "adaptive"}` plus `output_config: {effort: "high"}`. Reasoning tokens
// count against `max_tokens`, hence the 32k floor.
//
// STREAMED, unlike agent-gateway: the OpenAI route's non-streaming request
// timeout bit this pipeline once (an HTML "500 - The request timed out" on a
// multi-minute outline), and a thinking Opus segment call is slower still.
// The body is read to completion by `rawFetch` and stitched back together here,
// so callers see one string, exactly like the chat path.

const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_MIN_MAX_TOKENS = 32_000;
const ATTEMPTS = 3;
/** Per attempt, covering the fetch AND the body read: a stalled adaptive-thinking stream must not hang the episode. */
export const ATTEMPT_TIMEOUT_MS = 15 * 60_000;
/** 429/503 are retried inside `rawFetch`; these are the other transient upstream statuses. */
const RETRYABLE_STATUS = new Set([500, 502, 504]);
/** SSE `error` event types that are transient (the call can simply be repeated). */
const RETRYABLE_STREAM_ERRORS = new Set(["overloaded_error", "api_error", "rate_limit_error"]);

export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface AnthropicMessageResult {
  /** Concatenated `text` blocks only — thinking blocks are skipped. */
  text: string;
  stopReason: string | null;
  usage: AnthropicUsage;
  /** Streamed `error` event, when the stream carried one. */
  streamError?: { type: string; message: string };
}

/** A body that could not be read as a Messages response at all (empty, not JSON, wrong shape). */
export type AnthropicParseResult = { ok: true; value: AnthropicMessageResult } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

function mergeUsage(into: AnthropicUsage, from: unknown): void {
  if (!isRecord(from)) return;
  for (const key of USAGE_KEYS) {
    const n = asNumber(from[key]);
    if (n !== undefined) into[key] = n;
  }
}

function toStreamError(raw: unknown): AnthropicMessageResult["streamError"] {
  const error = isRecord(raw) ? raw : {};
  return { type: asString(error["type"]) ?? "unknown", message: asString(error["message"]) ?? "" };
}

/** A plain (non-SSE) JSON body: a message, or a `{"type":"error"}` envelope delivered with HTTP 200. */
function parseJsonMessage(body: string): AnthropicParseResult {
  const json = tryParseJson(body);
  if (!isRecord(json)) return { ok: false, reason: body.trim() === "" ? "empty body" : "body is not a JSON object" };
  if (json["type"] === "error") {
    return { ok: true, value: { text: "", stopReason: null, usage: {}, streamError: toStreamError(json["error"]) } };
  }
  const content = json["content"];
  if (!Array.isArray(content)) return { ok: false, reason: "JSON body has no content array" };
  const text = content
    .filter(isRecord)
    .filter((b) => b["type"] === "text")
    .map((b) => asString(b["text"]) ?? "")
    .join("");
  const usage: AnthropicUsage = {};
  mergeUsage(usage, json["usage"]);
  return { ok: true, value: { text, stopReason: asString(json["stop_reason"]) ?? null, usage } };
}

/**
 * Parse a Messages response returned as an SSE stream (`stream: true`) into the
 * concatenated `text` blocks, stop reason and usage. Tolerates a plain
 * non-stream JSON body too (a proxy that ignores `stream`), including an
 * `{"type":"error"}` envelope. Never throws: `[DONE]` and non-JSON `data:` lines
 * are skipped, and an unreadable body — non-SSE, or SSE-shaped with no valid event
 * at all — comes back as `{ok: false}`.
 * Exported for tests.
 */
export function parseAnthropicStream(body: string): AnthropicParseResult {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:") && !trimmed.startsWith(":")) {
    return parseJsonMessage(body);
  }

  const textBlocks = new Set<number>();
  let text = "";
  let stopReason: string | null = null;
  const usage: AnthropicUsage = {};
  let streamError: AnthropicMessageResult["streamError"];
  let sawEvent = false;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    const event = tryParseJson(payload);
    if (!isRecord(event)) continue;
    sawEvent = true;
    const index = asNumber(event["index"]);
    const delta = isRecord(event["delta"]) ? event["delta"] : undefined;
    switch (event["type"]) {
      case "message_start":
        if (isRecord(event["message"])) mergeUsage(usage, event["message"]["usage"]);
        break;
      case "content_block_start": {
        const block = isRecord(event["content_block"]) ? event["content_block"] : undefined;
        if (block?.["type"] === "text" && index !== undefined) {
          textBlocks.add(index);
          text += asString(block["text"]) ?? "";
        }
        break;
      }
      case "content_block_delta":
        if (delta?.["type"] === "text_delta" && index !== undefined && textBlocks.has(index)) {
          text += asString(delta["text"]) ?? "";
        }
        break;
      case "message_delta":
        stopReason = asString(delta?.["stop_reason"]) ?? stopReason;
        mergeUsage(usage, event["usage"]);
        break;
      case "error":
        streamError = toStreamError(event["error"]);
        break;
    }
  }
  if (!sawEvent) return { ok: false, reason: "SSE body carried no valid events" };
  return { ok: true, value: { text, stopReason, usage, streamError } };
}

export type AnthropicCallResult =
  | ({ ok: true; status: number } & AnthropicMessageResult)
  | { ok: false; status: number; errorText: string };

/** `system` as one string, or as a cached prefix block plus the per-call remainder. */
export function buildSystem(system: string, cacheablePrefix?: string): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  if (!cacheablePrefix || !system.startsWith(cacheablePrefix)) return system;
  const rest = system.slice(cacheablePrefix.length);
  const blocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
    { type: "text", text: cacheablePrefix, cache_control: { type: "ephemeral" } },
  ];
  if (rest.trim()) blocks.push({ type: "text", text: rest });
  return blocks;
}

/**
 * One Messages call with adaptive thinking. A non-2xx response comes back as
 * `{ok: false}` (the caller records usage and throws); a transient failure — 500/502/504,
 * a retryable stream `error` event, an empty/unparseable 2xx body, or an attempt that
 * outlives `timeoutMs` (fetch AND body read) — is repeated up to three times with
 * backoff (0.5s, 1.5s). 429/503 and transport errors are retried by `rawFetch`.
 * `timeoutMs` is a test seam; production uses {@link ATTEMPT_TIMEOUT_MS}.
 */
export async function callAnthropicMessages(params: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /**
   * Leading part of `system` that is byte-identical across the calls of one episode (house
   * rules, show bible, brief). When set and `system` starts with it, it becomes its own system
   * block carrying a `cache_control` breakpoint, so repeat calls read it from the prompt cache
   * (5-minute TTL, refreshed on every hit) instead of paying full input price.
   */
  cacheablePrefix?: string;
  timeoutMs?: number;
}): Promise<AnthropicCallResult> {
  const body = JSON.stringify({
    model: params.model,
    max_tokens: Math.max(ANTHROPIC_MIN_MAX_TOKENS, params.maxTokens),
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: buildSystem(params.system, params.cacheablePrefix),
    messages: [{ role: "user", content: params.user }],
    stream: true,
  });
  const timeoutMs = params.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  if (params.cacheablePrefix && !params.system.startsWith(params.cacheablePrefix)) {
    // Silent otherwise: a prompt edit that drifts the prefix just stops caching, and that costs money.
    log.warn("anthropic cacheable prefix does not lead the system prompt, calling uncached", { model: params.model });
  }
  // Resolved before the loop: a non-derivable base is a config error, never worth retrying.
  const url = iuAnthropicUrl("/v1/messages");

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= ATTEMPTS;
    const retry = async (reason: string, fields: Record<string, unknown>): Promise<void> => {
      log.warn(`anthropic messages ${reason}, retrying`, { model: params.model, ...fields, attempt });
      await Bun.sleep(500 * 3 ** (attempt - 1));
    };

    const signal = AbortSignal.timeout(timeoutMs);
    let res: Awaited<ReturnType<typeof rawFetch>>;
    try {
      res = await rawFetch(url, {
        method: "POST",
        headers: iuHeaders({ "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION }),
        body,
        signal,
      });
    } catch (err) {
      if (!signal.aborted) throw err;
      if (!last) {
        await retry("attempt timed out", { timeoutMs });
        continue;
      }
      return { ok: false, status: 504, errorText: `no complete response within ${Math.round(timeoutMs / 1000)}s (attempt ${attempt}/${ATTEMPTS})` };
    }

    if (res.status < 200 || res.status >= 300) {
      // IU wraps an upstream 400 as a 503/5xx; a body naming `invalid_request_error` is deterministic.
      const retryable = RETRYABLE_STATUS.has(res.status) && !res.body.includes("invalid_request_error");
      if (retryable && !last) {
        await retry("transient error", { status: res.status });
        continue;
      }
      return { ok: false, status: res.status, errorText: res.body.slice(0, 500) };
    }

    const parsed = parseAnthropicStream(res.body);
    if (!parsed.ok) {
      if (!last) {
        await retry("unreadable 2xx body", { reason: parsed.reason });
        continue;
      }
      return { ok: false, status: 502, errorText: `unreadable response (HTTP ${res.status}, ${parsed.reason}): ${res.body.slice(0, 200)}` };
    }
    const { streamError } = parsed.value;
    if (streamError) {
      if (RETRYABLE_STREAM_ERRORS.has(streamError.type) && !last) {
        await retry("stream error", { ...streamError });
        continue;
      }
      return { ok: false, status: 502, errorText: `${streamError.type}: ${streamError.message}`.slice(0, 500) };
    }
    return { ok: true, status: res.status, ...parsed.value };
  }
}
