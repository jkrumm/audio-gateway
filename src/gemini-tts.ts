import type { AudioOutputFormat, ChunkAudio } from "./audio";
import { concatPcm, SAMPLE_RATE_DEFAULT, transcode } from "./audio";
import { config } from "./config";
import type { ChunkLimits, PrepChunk, PrepResult } from "./gemini-tts-core";
import { detectLanguage, enforceChunkLimits, parsePrepResponse, synthConcurrent } from "./gemini-tts-core";
import { iuGeminiUrl, iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
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

export const SUMMARY_SYSTEM_PROMPT = `You turn an assistant reply into what should be SPOKEN aloud, in the persona of Hermes — a calm, warm, concise "sharp older friend". The user reads the written reply on screen; the spoken rendering is for the ear. There is no length limit: decide from the text how much deserves to be heard.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) IN that language: plain words, no quotes, no trailing punctuation, no emoji.
3. Decide what the listener needs, and write exactly that:
   - An action confirmation ("I created the todo…") → one short clause: "Todo Serverrechnung für morgen angelegt".
   - An answer to a question → the answer with the details that actually matter (the day, time, amount, condition), in flowing sentences; drop lists, headers, hedges and anything the user would only want to read, not hear.
   - Content that is meant to be listened to in full — a weather report, a briefing, a message the user asked to have spoken, a story — → keep ALL of its substance, rewritten as natural speech.
   Never pad, never add greetings or filler, never truncate a report to be brief.
4. Speak numbers, times, dates and units in spoken form (German: "achtzehn Uhr dreißig", "zweiundzwanzig Grad", "Samstag, der neunundzwanzigste"; English: "half past six", "twenty-two degrees"). No markdown, no bullet characters, no emoji.
5. Write one short "style" directive IN that language describing the warm, calm Hermes delivery.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"<directive>","text":"<the spoken rendering>"}]}`;

const PREP_SYSTEM_PROMPT = `You prepare text for Gemini text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) summarizing the content, IN the transcript's language, suitable as a filename/label: plain words, no quotes, no trailing punctuation, no emoji.
3. Rewrite numbers, times, dates, units and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language.
4. Split the text into short chunks of about 110 words each (never more than 150), so each chunk is only about 40–50 seconds of speech — Gemini TTS quality degrades once a single chunk runs past ~60 seconds. Break at paragraph boundaries first, then at sentence boundaries; never split in the middle of a sentence. Short text stays a single chunk.
5. For each chunk, write a "style" directive (one short sentence) IN the transcript's language describing the warm, calm Hermes delivery, and embed 1–2 SPARSE inline tags inside the chunk's "text" at natural points. Use only these tags: German [pause] [nachdenklich] [lacht] [seufzt] [begeistert] [bestimmt] [flüsternd]; English [pause] [thoughtful] [chuckles] [sigh] [excited] [firm] [whispers]. Do not over-tag — one or two per chunk. Tags are performance cues, never read aloud.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"<directive>","text":"<transcript with inline tags>"}]}`;

/** First few words of the input as a fallback title for the no-LLM path. */
function fallbackTitle(input: string, de: boolean): string {
  const words = input.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const trimmed = words.replace(/[.,;:!?]+$/, "").trim();
  return trimmed || (de ? "Sprachnachricht" : "Voice memo");
}

/** Build a single-chunk PrepResult with a default Hermes style directive — no LLM call. */
function defaultPrep(input: string): PrepResult {
  const de = (detectLanguage(input) ?? config.ttsDefaultLanguage) === "de";
  const style = de
    ? "Lies als warmer, ruhiger Erzähler, ohne Begrüßung, sachlich und natürlich"
    : "Read as a warm, calm narrator, no greeting, natural and matter-of-fact";
  return { lang: de ? "de" : "en", title: fallbackTitle(input, de), chunks: [{ style, text: input.trim() }] };
}

export interface RawResponse {
  status: number;
  body: string;
}

/**
 * fetch with backoff retry on 503/429 (mirrors modelpick's transient-failure
 * handling). Exported — shared with the Replicate lane's create/poll calls.
 */
export async function rawFetch(url: string, init: RequestInit, attempts = 3): Promise<RawResponse> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 503 || res.status === 429) && attempt < attempts) {
        recordRetry();
        await Bun.sleep(500 * attempt);
        continue;
      }
      return { status: res.status, body: await res.text() };
    } catch (err) {
      // A transport failure — connection refused, reset, or the socket closed
      // in the middle of a streamed body ("The socket connection was closed
      // unexpectedly", which cost a 23-minute podcast job on 2026-09-02) — is
      // as transient as a 503 and gets the same backoff. The last attempt's
      // error propagates unchanged.
      if (attempt >= attempts) throw err;
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
 * When `summarize` is true, the `config.ttsPrep` gating is bypassed (summary
 * always calls the LLM) and the SUMMARY_SYSTEM_PROMPT is used instead. Usage is
 * recorded under `"speech-summary"` so summary calls are separable in telemetry.
 */
async function runPrep(input: string, summarize: boolean): Promise<{ prep: PrepResult; ran: boolean }> {
  const usageEndpoint = summarize ? "speech-summary" : "speech-prep";
  const prepModel = summarize ? config.ttsSummaryModel : config.ttsPrepModel;

  if (!summarize) {
    const isLong = input.length >= config.ttsChunkCharThreshold;
    if (config.ttsPrep === "off") return { prep: defaultPrep(input), ran: false };
    if (config.ttsPrep === "long" && !isLong) return { prep: defaultPrep(input), ran: false };
  }

  const systemPrompt = summarize ? SUMMARY_SYSTEM_PROMPT : PREP_SYSTEM_PROMPT;

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
      return { prep: parsePrepResponse(content), ran: true };
    },
    "client",
  );
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
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${chunk.style}: ${chunk.text}` }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 1.0,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          },
        }),
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
      const pcm = Uint8Array.from(Buffer.from(inline.data, "base64"));
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

export async function handleGeminiSpeech(reqBody: GeminiSpeechRequest): Promise<Response> {
  const { model, input, voice, responseFormat, summarize } = reqBody;
  if (!config.iuGeminiBaseUrl) {
    throw new Error("IU_GEMINI_BASE_URL is not configured — required for Gemini TTS");
  }
  if (!input.trim()) {
    return Response.json({ error: { message: "input is required", type: "invalid_request_error" } }, { status: 400 });
  }

  const voiceName = VOICES.has(voice) ? voice : DEFAULT_VOICE;
  const { prep, ran } = await runPrep(input, summarize);
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

  // Concurrent, order-preserving synth (Decision 1).
  const parts = await synthChunksConcurrent(model, voiceName, chunks);

  const { pcm, sampleRate } = concatPcm(parts);
  const { bytes, contentType } = await withSpan("audio.transcode", { "audio.output_format": responseFormat }, async () =>
    transcode(pcm, { kind: "pcm", sampleRate }, responseFormat),
  );
  setRequestMeta({ audioSeconds: pcm.byteLength / (2 * sampleRate), bytesOut: bytes.byteLength });

  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType, "x-audio-title": encodeURIComponent(title) },
  });
}
