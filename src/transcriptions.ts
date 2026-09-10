import { audioDuration } from "./audio";
import { config } from "./config";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { resolveSttModel } from "./model-resolution";
import { getActiveSpan, traceIdFromRequestId, withRootSpan, withSpan } from "./otel";
import { extractTextAndUsage, PartFailure, stripPromptEcho, transcribeParts } from "./stt-dispatch";
import { prepareSttInput, SttChunkLimitError, SttChunkTooLargeError } from "./stt-input";
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

/** Same success range as `Response.ok`, applied to a plain status number. */
const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * The parsed request body's own type — `Request["formData"]`'s resolved
 * FormData, NOT the bare global `FormData` identifier (that ambient also
 * exists, for building outgoing bodies via `new FormData()`, but is a
 * structurally different declaration; without the DOM lib the two are not
 * assignable to one another).
 */
type IncomingForm = Awaited<ReturnType<Request["formData"]>>;

/** One upstream request/response, decided down to `{ text, usage, language }`. */
interface AttemptResult {
  status: number;
  body: string;
  contentType: string;
  text: string;
  usage: unknown;
  language: string | null;
}

/**
 * Build a fresh upstream form for a given model + part. Called once per part
 * per attempt so a fallback retry never reuses an already-consumed multipart
 * body, and so `synth` (format downgrade) is decided per the model actually
 * being sent. `filePart` overrides the client-supplied "file" field — used
 * when stt-input.ts had to compress/split the upload; omitted, the original
 * "file" form entry passes through untouched.
 */
function buildUpstreamForm(form: IncomingForm, clientFormat: string, model: string, filePart?: File, forceJson = false): FormData {
  const synth = forceJson || (SYNTH_MODEL.test(model) && RICH_FORMATS.has(clientFormat));
  const upstream = new FormData();
  for (const [key, value] of form.entries()) {
    if (key === "model" || key === "response_format" || key === "timestamp_granularities[]") continue;
    if (key === "file" && filePart) continue; // replaced below with the prepared part
    upstream.append(key, value);
  }
  if (filePart) upstream.append("file", filePart);
  upstream.append("model", model);
  upstream.append("response_format", synth ? "json" : clientFormat);
  // Inject language steering when the client provided none. `language` is a hard
  // single-language lock; `prompt` is a softer bias (use it for "de or en").
  if (!form.has("language") && config.sttLanguage) upstream.append("language", config.sttLanguage);
  if (!form.has("prompt") && config.sttPrompt) upstream.append("prompt", config.sttPrompt);
  return upstream;
}

/**
 * One upstream request for a single, unsplit upload — used for the common
 * single-part path and its whole-model fallback retry. Records the one usage
 * row for the HTTP call it makes (success or failure), so the caller never
 * needs to know whether the response was ok.
 */
async function attemptSingle(model: string, filePart: File | undefined, form: IncomingForm, clientFormat: string): Promise<AttemptResult> {
  return withSpan(
    "audio.stt.upstream",
    { "audio.model": model },
    async (span) => {
      const start = Date.now();
      const res = await fetch(iuUrl("/audio/transcriptions"), {
        method: "POST",
        headers: iuHeaders(),
        body: buildUpstreamForm(form, clientFormat, model, filePart),
      });
      const latencyMs = Date.now() - start;
      span.setAttributes({ "http.status_code": res.status });
      const body = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        span.setStatus("error");
        recordUsage({ endpoint: "transcriptions", model, status: res.status, latencyMs, responseFormat: clientFormat, errorText: body.slice(0, 500) });
        return { status: res.status, body, contentType, text: "", usage: null, language: null };
      }
      const { text, usage, language } = extractTextAndUsage(body, contentType);
      recordUsage({ endpoint: "transcriptions", model, status: res.status, latencyMs, responseFormat: clientFormat, usageJson: usage });
      return { status: res.status, body, contentType, text, usage, language };
    },
    "client",
  );
}

/**
 * Transcribe every part (the multi-part case only exists when stt-input.ts
 * had to time-slice an oversize/overlong upload) via stt-dispatch.ts's
 * `transcribeParts`, which runs parts concurrently with per-part model
 * fallback (B3), then joins each part's text with a single space into a
 * synthesized `{ text }` body — the caller re-derives rich envelopes
 * (verbose_json/srt/vtt) from that joined text, since a joined transcript
 * carries no real upstream segment timing.
 */
async function attemptMultiPart(
  model: string,
  parts: File[],
  form: IncomingForm,
  clientFormat: string,
  caller: string,
): Promise<AttemptResult & { servedModel: string }> {
  return withSpan(
    "audio.stt.upstream",
    { "audio.model": model },
    async (span) => {
      try {
        const { text, usedFallback } = await transcribeParts({
          parts,
          model,
          fallbackModel: FALLBACK_MODEL,
          isModelUnavailable,
          buildUpstream: (m, part) => buildUpstreamForm(form, clientFormat, m, part, true),
          endpoint: "transcriptions",
          caller,
        });
        span.setAttributes({ "http.status_code": 200 });
        // Per B3: report the model that actually served the request — the
        // fallback model if any part had to use it, since a joined transcript
        // has no per-part model breakdown for the client to see otherwise.
        return { status: 200, body: JSON.stringify({ text }), contentType: "application/json", text, usage: null, language: null, servedModel: usedFallback ? FALLBACK_MODEL : model };
      } catch (err) {
        if (!(err instanceof PartFailure)) throw err;
        span.setAttributes({ "http.status_code": err.res.status });
        span.setStatus("error");
        return { status: err.res.status, body: err.body, contentType: err.contentType, text: "", usage: null, language: null, servedModel: model };
      }
    },
    "client",
  );
}

/** A `prepareSttInput` rejection that must 413 rather than fall through to the original upload, or `null` for a genuine ffmpeg failure. */
function oversizeUploadMessage(err: unknown): string | null {
  if (err instanceof SttChunkLimitError) return err.message;
  // A chunk still over the upload limit after slicing must not fall through
  // to sending the original (already known to be oversize) upload unchanged
  // — that would just reproduce the empty-bodied 500 the feature prevents.
  if (err instanceof SttChunkTooLargeError) return err.message;
  return null;
}

interface FinishContext {
  requestStart: number;
  clientFormat: string;
  language: string | null;
  resolvedModel: string;
  inflight: number;
  caller: string;
}

/**
 * Build the `finish` closure: records the one "transcription-request" summary
 * row for this request and enriches the root span (audio.transcription) the
 * same way, then returns the given `response` unchanged.
 */
function makeFinish(ctx: FinishContext) {
  return (response: Response, opts: { model: string; status: number; audioSeconds?: number | null; outputText?: string }): Response => {
    const latencyMs = Date.now() - ctx.requestStart;
    recordUsage({
      endpoint: "transcription-request",
      model: opts.model,
      status: opts.status,
      latencyMs,
      responseFormat: ctx.clientFormat,
      audioSeconds: opts.audioSeconds ?? null,
      text: { output: opts.outputText },
    });

    const meta = getRequestMeta();
    const span = getActiveSpan();
    span.setAttributes({
      "audio.model": opts.model,
      "audio.requested_model": ctx.resolvedModel,
      "audio.language_hint": ctx.language ?? undefined,
      "audio.response_format": ctx.clientFormat,
      "audio.fallback": opts.model !== ctx.resolvedModel,
      "audio.retries": meta.retries ?? 0,
      "audio.inflight": ctx.inflight,
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
        caller: ctx.caller,
        latencyMs,
        responseFormat: ctx.clientFormat,
        audioSeconds: opts.audioSeconds ?? null,
        inflight: ctx.inflight,
      });
    }
    return response;
  };
}

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

/**
 * Fit the upload to the upstream's ~25 MiB hard limit before the first
 * attempt. Short clips (the common case) skip this entirely inside
 * prepareSttInput — no ffmpeg, no extra allocation. `null` means no file was
 * uploaded at all; the caller sends an empty part through untouched, same as
 * before. Returns `{ rejected }` — a fully-built 413 response — when the
 * upload must be turned away; the caller returns that as-is.
 */
async function prepareParts(
  file: File | null,
  finish: ReturnType<typeof makeFinish>,
  resolvedModel: string,
  caller: string,
): Promise<{ parts: File[] } | { rejected: Response }> {
  if (!file) return { parts: [] };
  try {
    const prepared = await withSpan("audio.stt.prepare", {}, async (span) => {
      const result = await prepareSttInput(file);
      span.setAttributes({
        "audio.stt.input_bytes": file.size,
        "audio.stt.compressed": result.compressed,
        "audio.stt.parts": result.parts.length,
      });
      return result;
    });
    return { parts: prepared.parts };
  } catch (err) {
    const message = oversizeUploadMessage(err);
    if (message !== null) {
      log.warn("stt upload rejected", { endpoint: "transcriptions", caller, error: message });
      return {
        rejected: finish(Response.json({ error: { message, type: "invalid_request_error" } }, { status: 413 }), {
          model: resolvedModel,
          status: 413,
        }),
      };
    }
    // A broken ffmpeg must not turn a previously-working short request into
    // a failure — fall through with the original, unprepared upload.
    log.error("stt input preparation failed; sending the original upload unchanged", {
      endpoint: "transcriptions",
      caller,
      error: err instanceof Error ? err.message : String(err),
    });
    return { parts: [file] };
  }
}

/** The model + upstream result that ends up serving the request, and whether it came from the multi-part (joined) path. */
interface ResolvedTranscription {
  model: string;
  result: AttemptResult;
  joined: boolean;
}

/**
 * Decide how to reach the upstream for this upload: a single request for one
 * (unsplit) part, with a whole-request fallback retry on a transient outage;
 * or, for a time-sliced upload, the concurrent per-part path (B3's per-part
 * fallback lives inside `attemptMultiPart`/`transcribeParts`, not here).
 */
async function resolveTranscription(
  model: string,
  parts: File[],
  form: IncomingForm,
  clientFormat: string,
  caller: string,
): Promise<ResolvedTranscription> {
  if (parts.length > 1) {
    const attempted = await attemptMultiPart(model, parts, form, clientFormat, caller);
    return { model: attempted.servedModel, result: attempted, joined: true };
  }

  let result = await attemptSingle(model, parts[0], form, clientFormat);
  // Fallback: a transient upstream outage of the requested model (e.g. IU 404
  // "no backend") would otherwise surface as an unparseable error to the client.
  // Retry once on whisper, which is the most reliably-served IU STT model.
  if (!isOk(result.status) && isModelUnavailable(result.status) && model !== FALLBACK_MODEL) {
    log.warn("stt upstream unavailable; retrying on fallback", {
      endpoint: "transcriptions",
      model,
      fallback: FALLBACK_MODEL,
      status: result.status,
      caller,
    });
    result = await attemptSingle(FALLBACK_MODEL, parts[0], form, clientFormat);
    return { model: FALLBACK_MODEL, result, joined: false };
  }
  return { model, result, joined: false };
}

interface ResponseContext {
  joined: boolean;
  clientFormat: string;
  language: string | null;
  file: File | null;
  finish: ReturnType<typeof makeFinish>;
  caller: string;
}

/**
 * Turn a resolved upstream result into the client-facing `Response`: an
 * upstream failure passes through (with the empty-body special case),
 * otherwise a rich client format not natively supported by the serving model
 * (or any joined multi-part response, which carries no real segment timing)
 * gets its envelope synthesized; everything else passes through faithfully.
 */
async function buildTranscriptionResponse(ctx: ResponseContext, model: string, result: AttemptResult): Promise<Response> {
  const { joined, clientFormat, file, finish, caller } = ctx;
  const { status, body, contentType, language: detectedLangFromUpstream } = result;
  const detectedLang = ctx.language ?? detectedLangFromUpstream ?? (config.sttLanguage || null);

  if (!isOk(status)) {
    const errorText = body.slice(0, 500);
    log.error("stt upstream error", { endpoint: "transcriptions", model, status, caller, error: errorText });
    // An empty upstream body (the IU 25 MiB-oversize 500) would otherwise
    // proxy through as an opaque, message-less error to the client.
    if (body.trim() === "") {
      const message = `upstream ${model} returned ${status} with an empty body`;
      return finish(Response.json({ error: { message, type: "upstream_error" } }, { status }), { model, status });
    }
    return finish(new Response(body, { status, headers: { "content-type": contentType } }), { model, status });
  }

  // A collapsed chunk can echo `config.sttPrompt` back verbatim (OpenAI treats
  // `prompt` as a preceding transcript segment). Strip it from the text we
  // build our own responses from; the raw-`body` passthrough below (whisper's
  // native rich formats) is left untouched on purpose — stripping inside an
  // already-framed SRT/VTT payload would corrupt its cue structure.
  const text = stripPromptEcho(result.text, config.sttPrompt);
  if (text !== result.text) {
    log.warn("stt transcript echoed the prompt verbatim; stripped", { endpoint: "transcriptions", caller });
  }

  // Recompute for the model that actually served the response: a whisper
  // fallback returns rich formats natively, so it takes the passthrough branch.
  // A joined multi-part response has no real upstream segment timing, so it
  // always goes through envelope synthesis for a rich client format too.
  const needsEnvelopeSynth = joined ? RICH_FORMATS.has(clientFormat) : SYNTH_MODEL.test(model) && RICH_FORMATS.has(clientFormat);
  if (needsEnvelopeSynth && file) {
    const duration = await withSpan("audio.stt.probe", {}, async () => audioDuration(file));
    const synthOpts = { model, status, audioSeconds: duration, outputText: text };
    if (clientFormat === "verbose_json") return finish(Response.json(verboseJson(text, duration, detectedLang)), synthOpts);
    if (clientFormat === "srt") {
      return finish(new Response(srt(text, duration), { headers: { "content-type": "text/plain; charset=utf-8" } }), synthOpts);
    }
    return finish(new Response(vtt(text, duration), { headers: { "content-type": "text/vtt; charset=utf-8" } }), synthOpts);
  }

  // Whisper rich formats and plain json/text pass through faithfully.
  if (clientFormat === "json") return finish(Response.json({ text }), { model, status, outputText: text });
  if (joined) {
    // The joined body is our own synthesized `{ text }` JSON, not the plain
    // text a "text"-format upstream response would be — render it as such.
    return finish(new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } }), { model, status, outputText: text });
  }
  // Raw-body passthrough (whisper's native rich formats: verbose_json/srt/vtt
  // framing, or plain "text"): deliberately untouched — never `text` here.
  return finish(new Response(body, { status, headers: { "content-type": contentType } }), { model, status, outputText: text });
}

async function dispatchTranscription(req: Request, caller: string, inflight: number): Promise<Response> {
  const requestStart = Date.now();
  const form = await req.formData();
  // Central model resolution: a wrong or absent model never reaches the upstream.
  // The default matches /transcribe/i so DE/EN prompt steering applies.
  const resolved = resolveSttModel(String(form.get("model") ?? ""));
  if (resolved.overridden) {
    log.warn("stt model overridden", { endpoint: "transcriptions", requested: resolved.requested, used: resolved.model, caller });
  }
  const clientFormat = String(form.get("response_format") ?? "json");
  const language = form.get("language") ? String(form.get("language")) : null;
  const file = form.get("file");
  const finish = makeFinish({ requestStart, clientFormat, language, resolvedModel: resolved.model, inflight, caller });

  const prepared = await prepareParts(file instanceof File ? file : null, finish, resolved.model, caller);
  if ("rejected" in prepared) return prepared.rejected;

  const { model, result, joined } = await resolveTranscription(resolved.model, prepared.parts, form, clientFormat, caller);

  return buildTranscriptionResponse(
    { joined, clientFormat, language, file: file instanceof File ? file : null, finish, caller },
    model,
    result,
  );
}
