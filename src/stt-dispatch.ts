// Multi-part STT orchestration, split out of transcriptions.ts so the request
// handler stays a thin dispatcher: concurrent per-part upstream calls (via
// gemini-tts-core's synthConcurrent — order-preserving, fail-fast, the same
// runner the TTS chunk pipeline uses), per-part model fallback (B3), and
// per-part usage recording all live here.

import { config } from "./config";
import { synthConcurrent } from "./gemini-tts-core";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { recordUsage } from "./usage";

/** Carries a failed part's upstream response through synthConcurrent's fail-fast throw. */
export class PartFailure extends Error {
  constructor(
    public readonly res: Response,
    public readonly body: string,
    public readonly contentType: string,
  ) {
    super(`stt chunk failed: ${res.status}`);
  }
}

/**
 * Pull `{ text, usage, language }` out of an upstream transcription response
 * body, shared by the single-part and per-part paths so the parsing logic
 * exists exactly once. Non-JSON bodies (whisper's rich formats) pass `text`
 * through as the raw body and leave `usage`/`language` unset.
 */
export function extractTextAndUsage(
  body: string,
  contentType: string,
): { text: string; usage: unknown; language: string | null } {
  if (!contentType.includes("application/json")) {
    return { text: body, usage: null, language: null };
  }
  const json = JSON.parse(body) as Record<string, unknown>;
  return {
    text: typeof json["text"] === "string" ? json["text"] : "",
    usage: json["usage"] ?? null,
    language: typeof json["language"] === "string" ? json["language"] : null,
  };
}

export interface TranscribePartsOptions {
  parts: File[];
  /** The requested model; each part tries this first. */
  model: string;
  /** Model a part retries on when its own attempt hits `isModelUnavailable`. */
  fallbackModel: string;
  /** Which upstream statuses signal a transient backend outage worth a per-part retry. */
  isModelUnavailable: (status: number) => boolean;
  /** Build the upstream multipart body for one part attempt (always forced to plain json). */
  buildUpstream: (model: string, part: File) => FormData;
  endpoint: "transcriptions";
  caller: string;
}

export interface TranscribePartsResult {
  text: string;
  /** True when at least one part had to fall back off the requested model. */
  usedFallback: boolean;
}

/**
 * Transcribe every part concurrently (`config.sttChunkConcurrency`-wide).
 * Each part attempts `model` and, on an `isModelUnavailable` status, retries
 * THAT PART ALONE on `fallbackModel` (B3) — a transient outage on one part
 * must never re-send, re-bill or re-record parts that already succeeded,
 * which an outer whole-set retry would do. Every HTTP call actually made
 * (including a per-part fallback retry) gets its own `recordUsage` row, so an
 * outage stays visible. Throws `PartFailure` when a part (and its fallback
 * attempt, if one was made) both fail — the caller decides how to surface
 * that to the client.
 */
export async function transcribeParts(opts: TranscribePartsOptions): Promise<TranscribePartsResult> {
  let usedFallback = false;

  const requestPart = async (
    model: string,
    part: File,
  ): Promise<{ res: Response; body: string; contentType: string; latencyMs: number }> => {
    const start = Date.now();
    const res = await fetch(iuUrl("/audio/transcriptions"), {
      method: "POST",
      headers: iuHeaders(),
      body: opts.buildUpstream(model, part),
    });
    const latencyMs = Date.now() - start;
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    return { res, body, contentType, latencyMs };
  };

  const texts = await synthConcurrent(config.sttChunkConcurrency, opts.parts, async (part) => {
    let attemptModel = opts.model;
    let result = await requestPart(attemptModel, part);

    if (!result.res.ok && opts.isModelUnavailable(result.res.status) && attemptModel !== opts.fallbackModel) {
      log.warn("stt chunk upstream unavailable; retrying this part on fallback", {
        endpoint: opts.endpoint,
        model: attemptModel,
        fallback: opts.fallbackModel,
        status: result.res.status,
        caller: opts.caller,
      });
      recordUsage({
        endpoint: opts.endpoint,
        model: attemptModel,
        status: result.res.status,
        latencyMs: result.latencyMs,
        responseFormat: "json",
        errorText: result.body.slice(0, 500),
      });
      attemptModel = opts.fallbackModel;
      usedFallback = true;
      result = await requestPart(attemptModel, part);
    }

    const { res, body, contentType, latencyMs } = result;
    if (!res.ok) {
      recordUsage({
        endpoint: opts.endpoint,
        model: attemptModel,
        status: res.status,
        latencyMs,
        responseFormat: "json",
        errorText: body.slice(0, 500),
      });
      throw new PartFailure(res, body, contentType);
    }

    const { text, usage } = extractTextAndUsage(body, contentType);
    recordUsage({ endpoint: opts.endpoint, model: attemptModel, status: res.status, latencyMs, responseFormat: "json", usageJson: usage });
    return text;
  });

  return { text: texts.join(" "), usedFallback };
}
