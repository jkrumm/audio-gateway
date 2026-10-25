import type { AudioOutputFormat, ChunkAudio } from "./audio";
import { concatPcm, SAMPLE_RATE_DEFAULT, silencePcm, transcode } from "./audio";
import { config } from "./config";
import type { ChunkLimits, PrepChunk, PrepResult } from "./gemini-tts-core";
import { detectLanguage, enforceChunkLimits, normalizeForSpeech, parsePrepResponse, synthConcurrent } from "./gemini-tts-core";
import { iuGeminiUrl, iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { resolveReasoningEffort } from "./model-resolution";
import { withSpan } from "./otel";
import { recordRetry, recordUsage, setRequestMeta } from "./usage";

// Gemini TTS pipeline. The OpenAI-compatible `/audio/speech` route 404s for
// Gemini voice models — TTS only answers on the native `generateContent`
// endpoint with an AUDIO response modality, returning base64 PCM (L16, 24 kHz,
// mono). We (1) rewrite the text into Hermes-styled chunks via a cheap prep LLM,
// (2) synthesize each chunk on Gemini concurrently (Decision 1), (3) concatenate
// the raw PCM, and (4) transcode to a compressed MP3/Opus via ffmpeg.

/** The 30 prebuilt Gemini voices (docs/gemini-tts.md). Requests outside this set fall back to Charon. */
const VOICES = new Set([
  // Male
  "Charon", "Schedar", "Iapetus", "Algieba", "Orus", "Puck", "Enceladus", "Sadachbia",
  "Rasalgethi", "Sadaltager", "Achird", "Umbriel", "Alnilam", "Fenrir", "Algenib", "Zubenelgenubi",
  // Female
  "Sulafat", "Kore", "Leda", "Callirrhoe", "Despina", "Laomedeia", "Gacrux", "Pulcherrima",
  "Vindemiatrix", "Zephyr", "Aoede", "Autonoe", "Erinome", "Achernar",
]);
const DEFAULT_VOICE = "Charon";

/** Hard per-chunk ceilings applied to the prep output before synthesis (see config). */
const CHUNK_LIMITS: ChunkLimits = {
  targetWords: config.ttsChunkTargetWords,
  maxWords: config.ttsChunkMaxWords,
  maxBytes: config.ttsChunkMaxBytes,
};

export interface GeminiSpeechRequest {
  model: string;
  input: string;
  voice: string;
  responseFormat: AudioOutputFormat;
  summarize: boolean;
}

/**
 * The one short `speechMetadata.style` string prep uses for every chunk of a request. 3.8 reads
 * direction placed in the text aloud; sustained delivery belongs in this field, kept identical
 * across chunks so the voice does not drift between requests (docs/gemini-tts.md §Style control).
 */
export const PREP_STYLE = "calm, warm, conversational";
/** A prep-supplied style longer than this is a sentence of direction, not a style string — replaced by {@link PREP_STYLE}. */
const MAX_STYLE_CHARS = 60;

export const SUMMARY_SYSTEM_PROMPT = `You turn an assistant reply into what should be SPOKEN aloud, in the persona of Hermes — a calm, warm, concise "sharp older friend". The user reads the written reply on screen; the spoken rendering is for the ear. There is no length limit: decide from the text how much deserves to be heard.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) IN that language: plain words, no quotes, no trailing punctuation, no emoji.
3. Decide what the listener needs, and write exactly that:
   - An action confirmation ("I created the todo…") → one short clause: "Todo Serverrechnung für morgen angelegt".
   - An answer to a question → the answer with the details that actually matter (the day, time, amount, condition), in flowing sentences; drop lists, headers, hedges and anything the user would only want to read, not hear.
   - Content that is meant to be listened to in full — a weather report, a briefing, a message the user asked to have spoken, a story — → keep ALL of its substance, rewritten as natural speech.
   Never pad, never add greetings or filler, never truncate a report to be brief.
4. Speak numbers, times, dates and units in spoken form (German: "achtzehn Uhr dreißig", "zweiundzwanzig Grad", "Samstag, der neunundzwanzigste"; English: "half past six", "twenty-two degrees"). No markdown, no bullet characters, no emoji, no tags.
5. Use exactly "${PREP_STYLE}" as the "style" value.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"${PREP_STYLE}","text":"<the spoken rendering>"}]}`;

const PREP_SYSTEM_PROMPT = `You prepare text for Gemini 3.8 text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first. The model speaks the "text" field VERBATIM: anything that is not meant to be heard must not be in it.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) summarizing the content, IN the transcript's language, suitable as a filename/label: plain words, no quotes, no trailing punctuation, no emoji.
3. Rewrite numbers, times, dates, units, symbols and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig", "zum Beispiel", "Millionen Euro"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language. No markdown, bullet characters or emoji.
4. Split the text into chunks of about 110 words each (never more than 150, roughly 1,000 characters), so each chunk is only about 50 seconds of speech — Gemini TTS drifts and drops words on longer generations. Break at paragraph boundaries first, then at sentence boundaries; never split in the middle of a sentence. Short text stays a single chunk.
5. Set every chunk's "style" to exactly "${PREP_STYLE}" — identical across chunks. Never put direction, emotion words or "Style:" prefixes inside "text"; they would be read aloud.
6. Embed SPARSE inline tags inside "text" at natural beats, in angle brackets, always in English even inside German text: <short pause> (about a quarter second), <long pause> (about a second), and — only where it genuinely fits — <laugh> or <sigh>. At most one or two tags per chunk, never two tags next to each other, none at all in most chunks. No square-bracket tags, no emotion tags, no other tag names.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"${PREP_STYLE}","text":"<transcript with sparse <tags>>"}]}`;

/** First few words of the input as a fallback title for the no-LLM path. */
function fallbackTitle(input: string, de: boolean): string {
  const words = input.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const trimmed = words.replace(/[.,;:!?]+$/, "").trim();
  return trimmed || (de ? "Sprachnachricht" : "Voice memo");
}

/** Build a single-chunk PrepResult with no style (the model's own delivery) — no LLM call. */
function defaultPrep(input: string): PrepResult {
  const de = (detectLanguage(input) ?? config.ttsDefaultLanguage) === "de";
  const lang = de ? "de" : "en";
  // Deterministic cleanup only (markdown, emoji, °C, "z. B.") — the model speaks what it is given.
  return { lang, title: fallbackTitle(input, de), chunks: [{ style: "", text: normalizeForSpeech(input, lang) }] };
}

/** Whether `model` is configured to run the prep LLM (`TTS_GEMINI_PREP_MODELS`, id or prefix). */
export function geminiWantsPrep(model: string): boolean {
  const listed = config.ttsGeminiPrepModels.split(",").map((s) => s.trim()).filter(Boolean);
  return listed.some((entry) => model === entry || model.startsWith(entry));
}

export interface RawResponse {
  status: number;
  body: string;
}

/**
 * Upper bound on a server-requested retry delay. A throttled request waits at
 * most this long, so a bogus or huge hint cannot stall a caller indefinitely.
 */
const MAX_RETRY_DELAY_MS = 15_000;

/** A delay in seconds as non-negative ms, or null when the scaled ms are not finite (an overflowing
 *  hint of either sign is nonsense input: no hint, so the caller falls back to its fixed backoff). */
function secondsToMs(value: unknown): number | null {
  if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") return null;
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Parse an RFC 9110 Retry-After value: delay-seconds or an HTTP-date. Blank is absent. */
function parseRetryAfter(value: string): number | null {
  if (value.trim() === "") return null;
  const seconds = secondsToMs(value);
  if (seconds !== null) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** The server's retry hint from the `Retry-After` header alone, in ms, or null. */
export function retryHintFromHeaders(headers: Headers): number | null {
  const header = headers.get("retry-after");
  return header === null ? null : parseRetryAfter(header);
}

/**
 * The server's retry hint from a 429/503 body alone, in ms — a `retry_after`
 * JSON field, else Replicate's documented "resets in ~30s" prose (it sends no
 * header, only that sentence). Null when the body carries no usable hint.
 */
export function retryHintFromBody(body: string): number | null {
  try {
    const field = (JSON.parse(body) as { retry_after?: unknown } | null)?.retry_after;
    if (field !== undefined && field !== null && field !== "") {
      const ms = secondsToMs(field);
      if (ms !== null) return ms;
    }
  } catch {
    // not JSON — fall through to the prose form below
  }
  const prose = /resets in\s*~?\s*([\d.]+)\s*s/i.exec(body);
  return secondsToMs(prose?.[1]);
}

/**
 * The server's own backoff hint for a 429/503, in ms — the standard
 * `Retry-After` header (delay-seconds or HTTP-date), else a `retry_after` JSON
 * field, else Replicate's "resets in ~30s" prose. Null when neither source
 * carries a usable hint. Kept for callers that already hold the body;
 * `rawFetch` checks the header first so it can skip reading the body at all.
 */
export function retryHintMs(headers: Headers, body: string): number | null {
  return retryHintFromHeaders(headers) ?? retryHintFromBody(body);
}

/**
 * Upper bound on how long the fallback body read may take. A stalled or
 * indefinitely-streaming error body must not delay a retry that the status
 * alone already justifies.
 */
const RETRY_HINT_BODY_TIMEOUT_MS = 2_000;

/**
 * Cap on the bytes of a 429/503 body read while looking for a retry hint.
 * Generous for any real throttle error (a few hundred bytes), small enough that
 * a fast upstream cannot exhaust memory. A body that does not end within the cap
 * is NOT parsed: its `retry_after` could sit past the cutoff or the JSON be cut
 * mid-token, and a guess from a fragment is worse than the fixed backoff.
 */
export const RETRY_HINT_BODY_MAX_BYTES = 65_536;

/**
 * Read a 429/503 body to extract its retry hint, bounded in time
 * ({@link RETRY_HINT_BODY_TIMEOUT_MS}) and bytes ({@link RETRY_HINT_BODY_MAX_BYTES}).
 * Only a body read to its end within both bounds is parsed; otherwise the stream
 * is cancelled and the result is null (the caller falls back to its fixed
 * backoff). Never throws.
 */
export async function readBodyHint(
  res: Response,
  timeoutMs = RETRY_HINT_BODY_TIMEOUT_MS,
  maxBytes = RETRY_HINT_BODY_MAX_BYTES,
): Promise<number | null> {
  const body = res.body;
  if (!body) return null;
  // A declared oversize body is refused up front; the per-chunk count below
  // covers chunked/undeclared ones (a runtime chunk is network-sized, not unbounded).
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void body.cancel().catch(() => {});
    return null;
  }
  const reader = (() => {
    try {
      return body.getReader();
    } catch {
      return null; // already locked or consumed — no hint, never a throw
    }
  })();
  if (!reader) return null;
  const decoder = new TextDecoder();
  const timedOut = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  const deadlineAt = Date.now() + timeoutMs;
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      // The timer is a macrotask: a source answering every read() with an empty
      // chunk could starve it, so the clock is checked on every pass too.
      if (Date.now() >= deadlineAt) break;
      const result = await Promise.race([reader.read(), deadline]);
      if (result === timedOut || Date.now() >= deadlineAt) break;
      if (result.done) {
        text += decoder.decode();
        return retryHintFromBody(text);
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) break;
      text += decoder.decode(result.value, { stream: true });
    }
  } catch {
    // unreadable body — fall through to the fixed backoff
  } finally {
    clearTimeout(timer);
  }
  // Fire and forget: a stream whose cancel() never settles must not hold the retry.
  void reader.cancel().catch(() => {});
  return null;
}

/**
 * fetch with backoff retry on 503/429 (mirrors modelpick's transient-failure
 * handling). A 429/503 honors the server's own retry hint (`Retry-After` /
 * `retry_after` / Replicate's "resets in ~Ns") when it gives one — the fixed
 * 500·attempt ms backoff misses a throttled window entirely — capped at
 * {@link MAX_RETRY_DELAY_MS}. Exported — shared with the Replicate lane's
 * create/poll calls.
 */
export async function rawFetch(url: string, init: RequestInit, attempts = 3): Promise<RawResponse> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 503 || res.status === 429) && attempt < attempts) {
        recordRetry();
        // The header alone usually answers it; only when it does not do we touch
        // the body (bounded), so a stalled error stream cannot delay the retry.
        const headerHint = retryHintFromHeaders(res.headers);
        if (headerHint !== null) void res.body?.cancel().catch(() => {}); // release the unread body
        const hinted = headerHint ?? (await readBodyHint(res));
        await Bun.sleep(Math.min(MAX_RETRY_DELAY_MS, Math.max(500 * attempt, hinted ?? 0)));
        continue;
      }
      return { status: res.status, body: await res.text() };
    } catch (err) {
      // A transport failure — connection refused, reset, or the socket closed
      // in the middle of a streamed body ("The socket connection was closed
      // unexpectedly", which cost a 23-minute podcast job on 2026-09-02) — is
      // as transient as a 503 and gets the same backoff. The last attempt's
      // error propagates unchanged.
      // A caller-aborted signal (timeout) stays aborted — retrying would only burn the backoff.
      if (attempt >= attempts || init.signal?.aborted) throw err;
      recordRetry();
      await Bun.sleep(1000 * attempt);
    }
  }
  throw new Error("unreachable");
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Run the prep LLM (OpenAI dialect) and record a usage row.
 * Decision 2 / §10 bug fix: record a usage row (error status + latency) BEFORE
 * throwing on non-2xx, so failures are visible in telemetry.
 *
 * Prep runs only for models in `config.ttsGeminiPrepModels` (and then per `config.ttsPrep`).
 * When `summarize` is true, all gating is bypassed (summary
 * always calls the LLM) and the SUMMARY_SYSTEM_PROMPT is used instead. Usage is
 * recorded under `"speech-summary"` so summary calls are separable in telemetry.
 */
async function runPrep(model: string, input: string, summarize: boolean): Promise<{ prep: PrepResult; ran: boolean }> {
  const usageEndpoint = summarize ? "speech-summary" : "speech-prep";
  const prepModel = summarize ? config.ttsSummaryModel : config.ttsPrepModel;

  if (!summarize) {
    if (!geminiWantsPrep(model)) return { prep: defaultPrep(input), ran: false };
    const isLong = input.length >= config.ttsChunkCharThreshold;
    if (config.ttsPrep === "off") return { prep: defaultPrep(input), ran: false };
    if (config.ttsPrep === "long" && !isLong) return { prep: defaultPrep(input), ran: false };
  }

  const systemPrompt = summarize ? SUMMARY_SYSTEM_PROMPT : PREP_SYSTEM_PROMPT;
  // Only the full prep call gets an effort — it has no tools, so gpt-6-luna's
  // tools+reasoning_effort 503 never applies here. The summary model
  // (gemini-3.5-flash-lite) never gets one: resolveReasoningEffort would omit
  // it anyway (outside the known reasoning-effort families), but not asking in
  // the first place keeps this call's intent explicit.
  const reasoningEffort = summarize ? undefined : resolveReasoningEffort(prepModel, config.ttsPrepEffort);

  return withSpan(
    "audio.prep",
    { "llm.model": prepModel, "audio.prep.kind": summarize ? "summary" : "prep", "audio.input_chars": input.length },
    async (span) => {
      const start = Date.now();
      const res = await rawFetch(iuUrl("/chat/completions"), {
        method: "POST",
        headers: iuHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: prepModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: input },
          ],
          // Reasoning-capable OpenAI models reject `max_tokens`; the modern field works.
          max_completion_tokens: Math.min(32000, Math.max(2000, input.length + 1000)),
          ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
        }),
      });
      const latencyMs = Date.now() - start;
      span.setAttributes({ "http.status_code": res.status });

      if (res.status < 200 || res.status >= 300) {
        // Bug fix: record error usage BEFORE throwing so failures are visible in telemetry.
        const errorText = res.body.slice(0, 500);
        log.error("tts prep error", {
          endpoint: usageEndpoint,
          model: prepModel,
          status: res.status,
          latencyMs,
          error: errorText,
        });
        recordUsage({
          endpoint: usageEndpoint,
          model: prepModel,
          status: res.status,
          latencyMs,
          inputChars: input.length,
          errorText,
        });
        throw new Error(`TTS prep failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
      }

      const json = JSON.parse(res.body) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: OpenAiUsage;
      };
      recordUsage({
        endpoint: usageEndpoint,
        model: prepModel,
        status: res.status,
        latencyMs,
        inputChars: input.length,
        usageJson: json.usage,
      });
      span.setAttributes({ "llm.output_tokens": json.usage?.completion_tokens ?? undefined });

      const content = json.choices?.[0]?.message?.content ?? "";
      const parsed = parsePrepResponse(content);
      const chunks = parsed.chunks.map((c) => (c.style && c.style.length <= MAX_STYLE_CHARS ? c : { ...c, style: PREP_STYLE }));
      return { prep: { ...parsed, chunks }, ran: true };
    },
    "client",
  );
}

/**
 * The 3.8 request body for one chunk (docs/gemini-tts.md §Request shapes). Style travels in
 * `parts[].speechMetadata.style` — never as a spoken prefix, never in `systemInstruction` or
 * `speechConfig` (both 400 on IU). `rawPcm` asks the unary route for headerless L16 instead of
 * WAV; the stream route is headerless L16 already.
 */
export function synthBody(voiceName: string, chunk: PrepChunk, opts: { rawPcm: boolean }): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text: chunk.text, ...(chunk.style && { speechMetadata: { style: chunk.style } }) }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(opts.rawPcm && { responseFormat: { audio: { mimeType: "AUDIO_L16" } } }),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  };
}

/** Drop a 44-byte RIFF/WAVE header if the upstream returned WAV despite the L16 request. */
function stripWavHeader(bytes: Uint8Array): Uint8Array {
  const riff = bytes.byteLength > 44 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  return riff ? bytes.subarray(44) : bytes;
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Record a best-effort error usage row for a failed Gemini synth (bug fix §10.1). */
function recordSpeechError(model: string, status: number, latencyMs: number, errorText?: string | null): void {
  recordUsage({ endpoint: "speech", model, status, latencyMs, errorText: errorText ?? null });
}

/**
 * Synthesize one chunk on Gemini and record a `speech` usage row.
 * Decision 2 / §10 bug fix: record a usage row (error status + latency) BEFORE
 * throwing on non-2xx or missing audio, so failures are visible in telemetry.
 */
async function synthChunk(model: string, voiceName: string, chunk: PrepChunk, index: number): Promise<ChunkAudio> {
  return withSpan(
    "audio.synth.chunk",
    { "audio.chunk_index": index, "gemini.model": model, "audio.input_chars": chunk.text.length },
    async (span) => {
      const start = Date.now();
      const res = await rawFetch(iuGeminiUrl(`/models/${model}:generateContent`), {
        method: "POST",
        headers: iuHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(synthBody(voiceName, chunk, { rawPcm: true })),
      });
      const latencyMs = Date.now() - start;
      span.setAttributes({ "http.status_code": res.status });

      if (res.status < 200 || res.status >= 300) {
        // Bug fix: record error usage BEFORE throwing so failures are visible in telemetry.
        const errorText = res.body.slice(0, 500);
        log.error("gemini tts synth error", { endpoint: "speech", model, status: res.status, latencyMs, error: errorText });
        recordSpeechError(model, res.status, latencyMs, errorText);
        throw new Error(`Gemini TTS failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
      }

      const parsed = JSON.parse(res.body) as GeminiTtsResponse;
      const inline = parsed.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) {
        // Bug fix: record error usage BEFORE throwing so failures are visible in telemetry.
        const errorText = `no audio in response: ${res.body.slice(0, 400)}`;
        log.error("gemini tts synth error", { endpoint: "speech", model, status: res.status, latencyMs, error: errorText });
        recordSpeechError(model, res.status, latencyMs, errorText);
        throw new Error(`Gemini TTS returned no audio: HTTP ${res.status} ${res.body.slice(0, 300)}`);
      }
      const pcm = stripWavHeader(Uint8Array.from(Buffer.from(inline.data, "base64")));
      const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1]) || SAMPLE_RATE_DEFAULT;

      recordUsage({
        endpoint: "speech",
        model,
        status: res.status,
        latencyMs,
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? null,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? null,
        audioSeconds: pcm.byteLength / (2 * sampleRate),
        bytesOut: pcm.byteLength,
      });
      span.setAttributes({ "audio.audio_seconds": pcm.byteLength / (2 * sampleRate) });

      return { pcm, sampleRate };
    },
    "client",
  );
}

/**
 * Synthesize all chunks with bounded concurrency, preserving order (Decision 1).
 * Thin wrapper around the shared `synthConcurrent` runner (gemini-tts-core.ts),
 * binding it to this lane's model/voice and `config.ttsConcurrency`.
 */
export async function synthChunksConcurrent(
  model: string,
  voiceName: string,
  chunks: PrepChunk[],
): Promise<ChunkAudio[]> {
  return synthConcurrent(config.ttsConcurrency, chunks, (chunk, i) => synthChunk(model, voiceName, chunk, i));
}

/** Gemini audio tokens per second of audio (docs). Streamed `usageMetadata` reports 1 token — bill from duration. */
const AUDIO_TOKENS_PER_SECOND = 25;

/** Pull the base64 PCM out of one SSE `data:` payload; events without audio yield null, malformed or error events throw. */
export function sseAudio(data: string): Uint8Array | null {
  let event: GeminiTtsResponse & { error?: { message?: string } };
  try {
    event = JSON.parse(data) as typeof event;
  } catch {
    // A cut-off or garbled event would otherwise end the stream as a quietly shorter clip.
    throw new Error(`Gemini TTS stream sent an unparseable event: ${data.slice(0, 120)}`);
  }
  // An in-band error event ends the stream as a failure, never as a silently shorter clip.
  if (event.error) throw new Error(`Gemini TTS stream error event: ${(event.error.message ?? JSON.stringify(event.error)).slice(0, 300)}`);
  const b64 = event.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  return b64 ? Uint8Array.from(Buffer.from(b64, "base64")) : null;
}

/** No byte from upstream for this long means a wedged stream (idle rule — never a total-duration cap). */
const STREAM_IDLE_MS = 60_000;

async function readWithIdleGuard(reader: {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Gemini TTS stream idle for ${STREAM_IDLE_MS / 1000}s`)), STREAM_IDLE_MS);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}

/** Open the SSE stream for one chunk. 429/503 are retried before any body byte is read. */
async function openStream(model: string, voiceName: string, chunk: PrepChunk): Promise<Response> {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(iuGeminiUrl(`/models/${model}:streamGenerateContent?alt=sse`), {
        method: "POST",
        headers: iuHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(synthBody(voiceName, chunk, { rawPcm: false })),
      });
    } catch (err) {
      // A connection reset before the first byte is as transient as a 503 (rawFetch does the same).
      if (attempt >= attempts) throw err;
      recordRetry();
      await Bun.sleep(1000 * attempt);
      continue;
    }
    if ((res.status === 503 || res.status === 429) && attempt < attempts) {
      recordRetry();
      const headerHint = retryHintFromHeaders(res.headers);
      if (headerHint !== null) void res.body?.cancel().catch(() => {});
      const hint = headerHint ?? (await readBodyHint(res));
      await Bun.sleep(Math.min(MAX_RETRY_DELAY_MS, Math.max(500 * attempt, hint ?? 0)));
      continue;
    }
    return res;
  }
}

/**
 * Progressive PCM for one chunk: yields s16-aligned byte runs as the SSE events arrive.
 * A non-2xx or an audio-less stream throws (after recording an error usage row).
 */
async function* streamChunkPcm(model: string, voiceName: string, chunk: PrepChunk, started: number): AsyncGenerator<Uint8Array> {
  const res = await openStream(model, voiceName, chunk);
  if (res.status < 200 || res.status >= 300 || !res.body) {
    const errorText = (await res.text()).slice(0, 500);
    log.error("gemini tts stream error", { endpoint: "speech", model, status: res.status, error: errorText });
    recordSpeechError(model, res.status, Date.now() - started, errorText);
    throw new Error(`Gemini TTS stream failed: HTTP ${res.status} ${errorText.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let carry: Uint8Array | null = null; // a dangling odd byte — keeps every yielded run sample-aligned
  let yielded = false;
  const emit = (audio: Uint8Array): Uint8Array | null => {
    const joined = carry ? Uint8Array.from([...carry, ...audio]) : audio;
    const even = joined.byteLength - (joined.byteLength % 2);
    carry = even < joined.byteLength ? joined.slice(even) : null;
    return even > 0 ? joined.subarray(0, even) : null;
  };
  try {
    for (;;) {
      const { done, value } = await readWithIdleGuard(reader);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (events.pop() ?? "");
      for (const raw of events) {
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        const audio = data ? sseAudio(data) : null;
        const run = audio ? emit(audio) : null;
        if (run) {
          yielded = true;
          yield run;
        }
      }
      if (done) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (!yielded) {
    const errorText = "no audio in stream";
    log.error("gemini tts stream error", { endpoint: "speech", model, status: res.status, error: errorText });
    recordSpeechError(model, res.status, Date.now() - started, errorText);
    throw new Error(`Gemini TTS stream returned no audio: HTTP ${res.status}`);
  }
}

/** Settlement promises of streamed responses, so the dispatcher can record its summary row once the body ends. */
const streamSettlements = new WeakMap<Response, Promise<void>>();

/** For a streamed Gemini response: resolves when the body is fully written (or cancelled), rejects if it failed mid-stream. */
export function streamSettled(response: Response): Promise<void> | undefined {
  return streamSettlements.get(response);
}

/**
 * Stream the chunks as raw PCM (`response_format: pcm`): the first bytes leave as soon as Gemini
 * produces them, chunks run one after another with a silence join. The Response is returned only
 * once the first audio byte arrived, so an upstream failure is still a proper HTTP error. The
 * returned `settled` promise ends with the body (rejects on a mid-stream failure).
 */
async function streamGeminiSpeech(params: {
  model: string;
  voiceName: string;
  chunks: PrepChunk[];
  headers: Record<string, string>;
}): Promise<{ response: Response; settled: Promise<void> }> {
  const { model, voiceName, chunks, headers } = params;
  const sampleRate = SAMPLE_RATE_DEFAULT;
  const started = Date.now();
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let wake: (() => void) | null = null;
  // Pull-based backpressure: ~256 KiB (~5 s of audio) may queue ahead of the client; beyond that
  // synthesis waits for the consumer, and a cancelled stream stops requesting more audio.
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        wake?.();
      },
      cancel() {
        cancelled = true;
        wake?.();
      },
    },
    { highWaterMark: 262_144, size: (bytes) => bytes?.byteLength ?? 0 },
  );
  const push = async (bytes: Uint8Array): Promise<void> => {
    while (!cancelled && (controller.desiredSize ?? 1) <= 0) await new Promise<void>((resolve) => (wake = resolve));
    if (!cancelled) controller.enqueue(bytes);
  };

  let totalBytes = 0;
  let firstByteMs: number | null = null;
  let signalFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });

  // Started synchronously, so the request-correlation context (usage rows, meta) carries into it.
  const run = withSpan("audio.synth.stream", { "gemini.model": model, "audio.chunks": chunks.length }, async (span) => {
    try {
      for (let i = 0; i < chunks.length && !cancelled; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const chunkStart = Date.now();
        let chunkBytes = 0;
        let chunkStatus = 500; // stays 500 unless the chunk's stream ends cleanly
        try {
          if (i > 0 && firstByteMs !== null) {
            const gap = silencePcm(sampleRate);
            totalBytes += gap.byteLength;
            await push(gap);
          }
          for await (const bytes of streamChunkPcm(model, voiceName, chunk, chunkStart)) {
            if (cancelled) break;
            if (firstByteMs === null) {
              firstByteMs = Date.now() - started;
              signalFirst();
            }
            chunkBytes += bytes.byteLength;
            totalBytes += bytes.byteLength;
            await push(bytes);
          }
          if (!cancelled) chunkStatus = 200;
        } finally {
          if (chunkBytes > 0) {
            const seconds = chunkBytes / (2 * sampleRate);
            recordUsage({
              endpoint: "speech",
              model,
              status: chunkStatus,
              errorText: chunkStatus === 200 ? null : `${cancelled ? "client cancelled" : "stream failed"} after ${chunkBytes} bytes`,
              latencyMs: Date.now() - chunkStart,
              outputTokens: Math.round(seconds * AUDIO_TOKENS_PER_SECOND),
              audioSeconds: seconds,
              bytesOut: chunkBytes,
            });
          }
        }
      }
    } finally {
      const audioSeconds = totalBytes / (2 * sampleRate);
      span.setAttributes({ "audio.first_byte_ms": firstByteMs ?? undefined, "audio.audio_seconds": audioSeconds, "audio.bytes_out": totalBytes });
      setRequestMeta({ audioSeconds, bytesOut: totalBytes });
    }
  }, "client");

  const settled = run.then(
    () => {
      if (!cancelled) controller.close();
    },
    (err: unknown) => {
      if (!cancelled) controller.error(err);
      throw err;
    },
  );
  settled.catch(() => {}); // the dispatcher observes it; this keeps an unobserved rejection from crashing the process

  await Promise.race([first, settled]); // an upstream failure before the first byte rejects here
  if (firstByteMs !== null) log.info("tts.first_byte", { model, firstByteMs });
  return { response: new Response(body, { status: 200, headers }), settled };
}

export async function handleGeminiSpeech(reqBody: GeminiSpeechRequest): Promise<Response> {
  const { model, input, voice, responseFormat, summarize } = reqBody;
  if (!config.iuGeminiBaseUrl) {
    throw new Error("IU_GEMINI_BASE_URL is not configured — required for Gemini TTS");
  }
  if (!input.trim()) {
    return Response.json({ error: { message: "input is required", type: "invalid_request_error" } }, { status: 400 });
  }

  const voiceName = VOICES.has(voice) ? voice : DEFAULT_VOICE;
  const { prep, ran } = await runPrep(model, input, summarize);
  // Enforce the per-chunk ceiling regardless of how the prep LLM split things —
  // long chunks are the cause of mid-audio voice drift. Re-splits at natural
  // boundaries; short inputs and well-behaved chunks pass through untouched.
  const chunks = enforceChunkLimits(prep.chunks, CHUNK_LIMITS);

  // Surface as much of the request-level summary meta as is known before synth
  // even starts, so a later synth failure still leaves lane/mode/chunks visible
  // on the "speech-request" row (see speech.ts).
  const title = prep.title || fallbackTitle(input, prep.lang === "de");
  setRequestMeta({
    mode: summarize ? "summary" : ran ? "prep" : "direct",
    lane: "gemini",
    chunks: chunks.length,
    languageCode: prep.lang,
    voice: voiceName,
    title,
    outputText: chunks.map((c) => c.text).join(" "),
  });
  const headers = { "x-audio-title": encodeURIComponent(title) };

  // Progressive path: a pcm client reads the body as it arrives.
  if (responseFormat === "pcm") {
    const { response, settled } = await streamGeminiSpeech({
      model,
      voiceName,
      chunks,
      headers: { ...headers, "content-type": "audio/pcm" },
    });
    streamSettlements.set(response, settled);
    return response;
  }

  // Concurrent, order-preserving synth (Decision 1).
  const parts = await synthChunksConcurrent(model, voiceName, chunks);

  const { pcm, sampleRate } = concatPcm(parts);
  const { bytes, contentType } = await withSpan("audio.transcode", { "audio.output_format": responseFormat }, async () =>
    transcode(pcm, { kind: "pcm", sampleRate }, responseFormat),
  );
  setRequestMeta({ audioSeconds: pcm.byteLength / (2 * sampleRate), bytesOut: bytes.byteLength });

  return new Response(bytes, {
    status: 200,
    headers: { ...headers, "content-type": contentType },
  });
}
