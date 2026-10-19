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

/**
 * Parse a Messages response returned as an SSE stream (`stream: true`) into the
 * concatenated `text` blocks, stop reason and usage. Tolerates a plain
 * non-stream JSON body too (a proxy that ignores `stream`). Exported for tests.
 */
export function parseAnthropicStream(body: string): AnthropicMessageResult {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:") && !trimmed.startsWith(":")) {
    const json = JSON.parse(body) as {
      content?: Array<{ type: string; text?: string | null }>;
      stop_reason?: string | null;
      usage?: AnthropicUsage;
    };
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { text, stopReason: json.stop_reason ?? null, usage: json.usage ?? {} };
  }

  const textBlocks = new Set<number>();
  let text = "";
  let stopReason: string | null = null;
  const usage: AnthropicUsage = {};
  let streamError: AnthropicMessageResult["streamError"];
  const mergeUsage = (u: AnthropicUsage | undefined): void => {
    if (!u) return;
    for (const key of Object.keys(u) as Array<keyof AnthropicUsage>) {
      if (typeof u[key] === "number") usage[key] = u[key];
    }
  };

  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload) continue;
    const event = JSON.parse(payload) as {
      type?: string;
      index?: number;
      message?: { usage?: AnthropicUsage };
      content_block?: { type?: string; text?: string };
      delta?: { type?: string; text?: string; stop_reason?: string | null };
      usage?: AnthropicUsage;
      error?: { type?: string; message?: string };
    };
    switch (event.type) {
      case "message_start":
        mergeUsage(event.message?.usage);
        break;
      case "content_block_start":
        if (event.content_block?.type === "text" && event.index !== undefined) {
          textBlocks.add(event.index);
          text += event.content_block.text ?? "";
        }
        break;
      case "content_block_delta":
        if (event.delta?.type === "text_delta" && event.index !== undefined && textBlocks.has(event.index)) {
          text += event.delta.text ?? "";
        }
        break;
      case "message_delta":
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        mergeUsage(event.usage);
        break;
      case "error":
        streamError = { type: event.error?.type ?? "unknown", message: event.error?.message ?? "" };
        break;
    }
  }
  return { text, stopReason, usage, streamError };
}

export type AnthropicCallResult =
  | ({ ok: true; status: number } & AnthropicMessageResult)
  | { ok: false; status: number; errorText: string };

/**
 * One Messages call with adaptive thinking. A non-2xx response comes back as
 * `{ok: false}` (the caller records usage and throws); a transient failure — 500/502/504,
 * or a retryable stream `error` event — is repeated up to three times with backoff
 * (0.5s, 1.5s). 429/503 and transport errors are retried by `rawFetch`.
 */
export async function callAnthropicMessages(params: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<AnthropicCallResult> {
  const body = JSON.stringify({
    model: params.model,
    max_tokens: Math.max(ANTHROPIC_MIN_MAX_TOKENS, params.maxTokens),
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: params.system,
    messages: [{ role: "user", content: params.user }],
    stream: true,
  });

  for (let attempt = 1; ; attempt++) {
    const res = await rawFetch(iuAnthropicUrl("/v1/messages"), {
      method: "POST",
      headers: iuHeaders({ "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION }),
      body,
    });
    const last = attempt >= ATTEMPTS;

    if (res.status < 200 || res.status >= 300) {
      // IU wraps an upstream 400 as a 503/5xx; a body naming `invalid_request_error` is deterministic.
      const retryable = RETRYABLE_STATUS.has(res.status) && !res.body.includes("invalid_request_error");
      if (retryable && !last) {
        log.warn("anthropic messages transient error, retrying", { model: params.model, status: res.status, attempt });
        await Bun.sleep(500 * 3 ** (attempt - 1));
        continue;
      }
      return { ok: false, status: res.status, errorText: res.body.slice(0, 500) };
    }

    const parsed = parseAnthropicStream(res.body);
    if (parsed.streamError) {
      if (RETRYABLE_STREAM_ERRORS.has(parsed.streamError.type) && !last) {
        log.warn("anthropic messages stream error, retrying", { model: params.model, ...parsed.streamError, attempt });
        await Bun.sleep(500 * 3 ** (attempt - 1));
        continue;
      }
      return { ok: false, status: 502, errorText: `${parsed.streamError.type}: ${parsed.streamError.message}`.slice(0, 500) };
    }
    return { ok: true, status: res.status, ...parsed };
  }
}
