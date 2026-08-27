import { audioDuration } from "./audio";
import { config } from "./config";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { resolveSttModel } from "./model-resolution";
import { getActiveSpan, traceIdFromRequestId, withRootSpan, withSpan } from "./otel";
import { getRequestMeta, inflightEnd, inflightStart, recordUsage, runWithRequestContext } from "./usage";

/** Attribute values gated by USAGE_KEEP_TEXT — same 600-char cap as the usage sink (usage.ts). */
const TEXT_ATTR_MAX = 600;
const textAttr = (s: string | undefined): string | undefined =>
  config.usageKeepText && s ? s.slice(0, TEXT_ATTR_MAX) : undefined;

/**
 * gpt-4o(-mini)-transcribe and -diarize only support `json`/`text` on IU —
 * `verbose_json`/`srt`/`vtt` and timestamp_granularities are rejected (503).
 * For those models we ask IU for plain `json` and synthesize the richer
 * envelope the client asked for. `whisper` supports the rich formats natively
 * (real segment timing), so it is passed through untouched.
 */
const SYNTH_MODEL = /transcribe/i;
const RICH_FORMATS = new Set(["verbose_json", "srt", "vtt"]);

export const srtTime = (s: number): string => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const sec = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  const milli = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${sec},${milli}`;
};

export const verboseJson = (text: string, duration: number, language: string | null) => ({
  task: "transcribe",
  language: language ?? "unknown",
  duration,
  text,
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0,
      end: duration,
      text,
      tokens: [] as number[],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 1,
      no_speech_prob: 0,
    },
  ],
});

export const srt = (text: string, duration: number): string =>
  `1\n${srtTime(0)} --> ${srtTime(duration)}\n${text}\n`;

export const vtt = (text: string, duration: number): string =>
  `WEBVTT\n\n${srtTime(0).replace(",", ".")} --> ${srtTime(duration).replace(",", ".")}\n${text}\n`;

/** The rock-solid IU STT model we fall back to when the requested model fails. */
const FALLBACK_MODEL = "whisper";

/**
 * Upstream failure statuses worth retrying with the fallback model. These signal
 * the *model/backend* is unavailable (a transient IU 404 "No suitable backend
 * server found", or a 5xx), not that the client's request is malformed — a 4xx
 * like 400/413/415 would fail identically on the fallback, so those pass through.
 */
const isModelUnavailable = (status: number): boolean => status === 404 || status >= 500;

/**
 * Request correlation: every recordUsage call made while handling one
 * transcription (including a fallback retry) is stamped with the same
 * request_id/caller via runWithRequestContext, and a single
 * "transcription-request" summary row is recorded once the response is
 * decided so a whole request can be reviewed as one timeline entry.
 */
export async function handleTranscriptions(req: Request, tokenCaller?: string): Promise<Response> {
  // Explicit x-audio-source wins; otherwise fall back to the caller identified
  // by a mapped AUDIO_CALLER_TOKENS bearer token (index.ts's callerFromToken),
  // for clients that cannot set headers (Hermes' stock OpenAI client, MacWhisper).
  const caller = req.headers.get("x-audio-source") ?? tokenCaller ?? "unknown";
  const requestId = crypto.randomUUID();
  const inflight = inflightStart();
  try {
    return await runWithRequestContext({ requestId, caller }, () =>
      withRootSpan(
        {
          traceId: traceIdFromRequestId(requestId),
          name: "audio.transcription",
          kind: "server",
          attrs: { "audio.request_id": requestId, "audio.caller": caller, "audio.inflight": inflight },
        },
        () => dispatchTranscription(req, caller, inflight),
      ),
    );
  } finally {
    inflightEnd();
  }
}

async function dispatchTranscription(req: Request, caller: string, inflight: number): Promise<Response> {
  const requestStart = Date.now();
  const form = await req.formData();
  // Central model resolution: a wrong or absent model never reaches the upstream.
  // The default matches /transcribe/i so DE/EN prompt steering applies.
  const resolved = resolveSttModel(String(form.get("model") ?? ""));
  if (resolved.overridden) {
    log.warn("stt model overridden", {
      endpoint: "transcriptions",
      requested: resolved.requested,
      used: resolved.model,
      caller,
    });
  }
  const clientFormat = String(form.get("response_format") ?? "json");
  const language = form.get("language") ? String(form.get("language")) : null;
  const file = form.get("file");

  // Build a fresh upstream form for a given model. Called once per attempt so the
  // fallback never reuses an already-consumed multipart body, and so `synth`
  // (format downgrade) is decided per the model actually being sent.
  const buildUpstream = (model: string): FormData => {
    const synth = SYNTH_MODEL.test(model) && RICH_FORMATS.has(clientFormat);
    const upstream = new FormData();
    for (const [key, value] of form.entries()) {
      if (key === "model" || key === "response_format" || key === "timestamp_granularities[]") continue;
      upstream.append(key, value);
    }
    upstream.append("model", model);
    upstream.append("response_format", synth ? "json" : clientFormat);
    // Inject language steering when the client provided none. `language` is a hard
    // single-language lock; `prompt` is a softer bias (use it for "de or en").
    if (!form.has("language") && config.sttLanguage) upstream.append("language", config.sttLanguage);
    if (!form.has("prompt") && config.sttPrompt) upstream.append("prompt", config.sttPrompt);
    return upstream;
  };

  const attempt = async (model: string) => {
    return withSpan(
      "audio.stt.upstream",
      { "audio.model": model },
      async (span) => {
        const start = Date.now();
        const res = await fetch(iuUrl("/audio/transcriptions"), {
          method: "POST",
          headers: iuHeaders(),
          body: buildUpstream(model),
        });
        const latencyMs = Date.now() - start;
        span.setAttributes({ "http.status_code": res.status });
        if (!res.ok) span.setStatus("error");
        return { res, latencyMs, body: await res.text(), contentType: res.headers.get("content-type") ?? "" };
      },
      "client",
    );
  };

  /**
   * Record the one "transcription-request" summary row for this request and
   * enrich the root span (audio.transcription) the same way, then return `response`.
   */
  const finish = (
    response: Response,
    opts: { model: string; status: number; audioSeconds?: number | null; outputText?: string },
  ): Response => {
    const latencyMs = Date.now() - requestStart;
    recordUsage({
      endpoint: "transcription-request",
      model: opts.model,
      status: opts.status,
      latencyMs,
      responseFormat: clientFormat,
      audioSeconds: opts.audioSeconds ?? null,
      text: { output: opts.outputText },
    });

    const meta = getRequestMeta();
    const span = getActiveSpan();
    span.setAttributes({
      "audio.model": opts.model,
      "audio.requested_model": resolved.requested,
      "audio.language_hint": language ?? undefined,
      "audio.response_format": clientFormat,
      "audio.fallback": opts.model !== resolved.model,
      "audio.retries": meta.retries ?? 0,
      "audio.inflight": inflight,
      "audio.audio_seconds": opts.audioSeconds ?? undefined,
      "http.status_code": opts.status,
      "audio.text.output": textAttr(opts.outputText),
      "audio.cost_usd": meta.costUsd != null ? Number(meta.costUsd.toFixed(6)) : undefined,
      "audio.cost_source": meta.costSource ?? "none",
    });
    if (opts.status >= 500) span.setStatus("error");
    if (opts.status < 400) {
      log.info("stt.done", {
        model: opts.model,
        caller,
        latencyMs,
        responseFormat: clientFormat,
        audioSeconds: opts.audioSeconds ?? null,
        inflight,
      });
    }
    return response;
  };

  let model = resolved.model;
  let { res, latencyMs, body, contentType } = await attempt(model);

  // Fallback: a transient upstream outage of the requested model (e.g. IU 404
  // "no backend") would otherwise surface as an unparseable error to the client.
  // Retry once on whisper, which is the most reliably-served IU STT model.
  if (!res.ok && isModelUnavailable(res.status) && model !== FALLBACK_MODEL) {
    log.warn("stt upstream unavailable; retrying on fallback", {
      endpoint: "transcriptions",
      model,
      fallback: FALLBACK_MODEL,
      status: res.status,
      caller,
    });
    // Record the failed primary attempt so the requested model's outage is visible.
    recordUsage({ endpoint: "transcriptions", model, status: res.status, latencyMs, responseFormat: clientFormat, errorText: body.slice(0, 500) });
    model = FALLBACK_MODEL;
    ({ res, latencyMs, body, contentType } = await attempt(model));
  }

  if (!res.ok) {
    const errorText = body.slice(0, 500);
    log.error("stt upstream error", {
      endpoint: "transcriptions",
      model,
      status: res.status,
      latencyMs,
      caller,
      error: errorText,
    });
    recordUsage({ endpoint: "transcriptions", model, status: res.status, latencyMs, responseFormat: clientFormat, errorText });
    return finish(new Response(body, { status: res.status, headers: { "content-type": contentType } }), {
      model,
      status: res.status,
    });
  }

  let text = body;
  let usage: unknown = null;
  let detectedLang = language ?? (config.sttLanguage || null);
  if (contentType.includes("application/json")) {
    const json = JSON.parse(body) as Record<string, unknown>;
    text = typeof json["text"] === "string" ? json["text"] : "";
    usage = json["usage"] ?? null;
    if (typeof json["language"] === "string") detectedLang = json["language"];
  }

  recordUsage({
    endpoint: "transcriptions",
    model,
    status: res.status,
    latencyMs,
    responseFormat: clientFormat,
    usageJson: usage,
  });

  // Recompute for the model that actually served the response: a whisper
  // fallback returns rich formats natively, so it takes the passthrough branch.
  const synth = SYNTH_MODEL.test(model) && RICH_FORMATS.has(clientFormat);
  if (synth && file instanceof File) {
    const duration = await withSpan("audio.stt.probe", {}, async () => audioDuration(file));
    const synthOpts = { model, status: res.status, audioSeconds: duration, outputText: text };
    if (clientFormat === "verbose_json") return finish(Response.json(verboseJson(text, duration, detectedLang)), synthOpts);
    if (clientFormat === "srt") {
      return finish(new Response(srt(text, duration), { headers: { "content-type": "text/plain; charset=utf-8" } }), synthOpts);
    }
    return finish(new Response(vtt(text, duration), { headers: { "content-type": "text/vtt; charset=utf-8" } }), synthOpts);
  }

  // Whisper rich formats and plain json/text pass through faithfully.
  if (clientFormat === "json") return finish(Response.json({ text }), { model, status: res.status, outputText: text });
  return finish(new Response(body, { status: res.status, headers: { "content-type": contentType } }), {
    model,
    status: res.status,
    outputText: text,
  });
}
