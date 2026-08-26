import type { AudioOutputFormat, ChunkAudio } from "./audio";
import { concatPcm, SAMPLE_RATE_DEFAULT, transcode } from "./audio";
import { config } from "./config";
import { rawFetch } from "./gemini-tts";
import type { ChunkLimits, PrepChunk, PrepResult } from "./gemini-tts-core";
import { detectLanguage, enforceChunkLimits, parsePrepResponse, synthConcurrent } from "./gemini-tts-core";
import { iuHeaders, iuReplicateUrl, iuUrl } from "./iu";
import { log } from "./log";
import { recordUsage } from "./usage";

// Replicate TTS lane: ElevenLabs models (flash-v2.5, turbo-v2.5, v3) served
// through the IU gateway's Replicate route. Unlike Gemini, the upstream call
// is a "create prediction, poll if not done, fetch the delivery URL" flow, and
// the delivered audio is already an MP3 — no PCM to synthesize, only to decode
// when concatenation or a non-mp3 output format is needed.

/** ElevenLabs' fixed voice enum (identical input schema across flash/turbo/v3). */
const VOICES = new Set([
  "Rachel", "Drew", "Clyde", "Paul", "Aria", "Domi", "Dave", "Roger", "Fin", "Sarah",
  "James", "Jane", "Juniper", "Arabella", "Hope", "Bradford", "Reginald", "Gaming",
  "Austin", "Kuon", "Blondie", "Priyanka", "Alexandra", "Monika", "Mark", "Grimblewood",
]);

/** ElevenLabs v3 audio tags — inline, English-only, sparse, at most one per chunk. */
const V3_TAGS = ["[sighs]", "[laughs]", "[whispers]", "[curious]", "[excited]", "[thoughtful]"];

/** ISO-639-1/-3 code with optional region, e.g. `de`, `en-GB`; anything else falls back to detection. */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const CREATE_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 500;

/** Per-chunk ceilings for this lane — smaller than Gemini's, purely for parallelism (see config). */
const CHUNK_LIMITS: ChunkLimits = {
  targetWords: config.ttsReplicateChunkTargetWords,
  maxWords: config.ttsReplicateChunkMaxWords,
  maxBytes: config.ttsChunkMaxBytes,
};

/** No-LLM char ceiling for prep-off models: split at sentence boundaries only, no rewriting. */
const NO_PREP_SPLIT_THRESHOLD = 4000;

export interface ReplicateSpeechRequest {
  model: string;
  input: string;
  voice: string;
  responseFormat: AudioOutputFormat;
  summarize: boolean;
  speed?: number;
  instructions?: string;
  language?: string;
  stability?: number;
  style?: number;
  similarityBoost?: number;
}

/**
 * Prep prompt variant for ElevenLabs: same JSON contract as Gemini's prep
 * (parsePrepResponse is reused), but the tag vocabulary is v3's own English
 * audio tags instead of Gemini's German/English bracket tags, and `style` is
 * returned only to satisfy the shared contract — this lane has no prose-
 * directive channel and ignores it.
 */
const PREP_SYSTEM_PROMPT_ELEVENLABS = `You prepare text for ElevenLabs v3 text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) summarizing the content, IN the transcript's language, suitable as a filename/label: plain words, no quotes, no trailing punctuation, no emoji.
3. Rewrite numbers, times, dates, units and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language.
4. Split the text into short chunks of about ${config.ttsReplicateChunkTargetWords} words each (never more than ${config.ttsReplicateChunkMaxWords}). Break at paragraph boundaries first, then at sentence boundaries; never split in the middle of a sentence. Short text stays a single chunk.
5. For each chunk, write a short "style" field (one sentence, IN the transcript's language) describing the intended delivery — it is not spoken and mainly documents intent. Embed AT MOST ONE of these English audio tags per chunk, placed at the start of the sentence it colours, and only where it genuinely fits: ${V3_TAGS.join(" ")}. Most chunks should have NO tag at all — be sparse. Never translate a tag, never invent a new one.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"<directive>","text":"<transcript with at most one tag per chunk>"}]}`;

/** Detected language, falling back to the configured household default when the text isn't decisive. */
function resolveLanguage(input: string): "de" | "en" {
  return detectLanguage(input) ?? config.ttsDefaultLanguage;
}

/** First few words of the input as a fallback title for the no-LLM path. */
function fallbackTitle(input: string, de: boolean): string {
  const words = input.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const trimmed = words.replace(/[.,;:!?]+$/, "").trim();
  return trimmed || (de ? "Sprachnachricht" : "Voice memo");
}

/** Split raw sentences via the shared limits splitter, no LLM rewriting, no tags. */
function splitNoPrep(input: string): PrepResult {
  const de = resolveLanguage(input) === "de";
  const chunks = enforceChunkLimits([{ style: "", text: input.trim() }], CHUNK_LIMITS);
  return { lang: de ? "de" : "en", title: fallbackTitle(input, de), chunks };
}

/** Whether `model` (or a listed prefix of it) is in `config.ttsReplicatePrepModels`. */
function wantsPrep(model: string): boolean {
  const listed = config.ttsReplicatePrepModels.split(",").map((s) => s.trim()).filter(Boolean);
  return listed.some((entry) => model === entry || model.startsWith(entry));
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Run the prep LLM for the Replicate lane. Skipped entirely (single chunk, no
 * LLM call, no title) unless `model` is listed in `config.ttsReplicatePrepModels`
 * or `summarize` forces it — the fast path for chat replies on flash/turbo.
 * `instructions`, when present, is appended as a delivery hint to the user
 * message; it has no other use in this lane.
 */
async function runReplicatePrep(
  model: string,
  input: string,
  summarize: boolean,
  instructions: string | undefined,
): Promise<{ prep: PrepResult; ran: boolean }> {
  const usageEndpoint = summarize ? "speech-summary" : "speech-prep";

  if (!summarize && !wantsPrep(model)) {
    if (input.length > NO_PREP_SPLIT_THRESHOLD) return { prep: splitNoPrep(input), ran: false };
    const de = resolveLanguage(input) === "de";
    return {
      prep: { lang: de ? "de" : "en", title: fallbackTitle(input, de), chunks: [{ style: "", text: input.trim() }] },
      ran: false,
    };
  }

  const userContent = instructions ? `${input}\n\n[delivery hint: ${instructions}]` : input;

  const start = Date.now();
  const res = await rawFetch(iuUrl("/chat/completions"), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: config.ttsPrepModel,
      messages: [
        { role: "system", content: PREP_SYSTEM_PROMPT_ELEVENLABS },
        { role: "user", content: userContent },
      ],
      max_completion_tokens: Math.min(32000, Math.max(2000, input.length + 1000)),
    }),
  });
  const latencyMs = Date.now() - start;

  if (res.status < 200 || res.status >= 300) {
    const errorText = res.body.slice(0, 500);
    log.error("elevenlabs tts prep error", { endpoint: usageEndpoint, model: config.ttsPrepModel, status: res.status, latencyMs, error: errorText });
    recordUsage({ endpoint: usageEndpoint, model: config.ttsPrepModel, status: res.status, latencyMs, inputChars: input.length, errorText });
    throw new Error(`TTS prep failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }

  const json = JSON.parse(res.body) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenAiUsage;
  };
  recordUsage({ endpoint: usageEndpoint, model: config.ttsPrepModel, status: res.status, latencyMs, inputChars: input.length, usageJson: json.usage });

  const content = json.choices?.[0]?.message?.content ?? "";
  return { prep: parsePrepResponse(content), ran: true };
}

interface ReplicatePrediction {
  id?: string;
  status: string;
  output?: string | string[];
  error?: string | null;
  metrics?: { predict_time?: number };
}

/** Any Replicate-side synth failure (create/poll/failed-status/delivery) — mapped to 502, never 500. */
export class ReplicateSynthError extends Error {}

async function createPrediction(model: string, input: Record<string, unknown>): Promise<ReplicatePrediction> {
  const [owner, name] = model.split("/");
  const res = await rawFetch(iuReplicateUrl(`/models/${owner}/${name}/predictions`), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json", Prefer: "wait" }),
    body: JSON.stringify({ input }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new ReplicateSynthError(`Replicate create failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body) as ReplicatePrediction;
}

async function pollPrediction(id: string): Promise<ReplicatePrediction> {
  const deadline = Date.now() + CREATE_DEADLINE_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    // Deliberately NOT iuReplicateUrl(`/models/.../predictions/${id}`) — the poll
    // path is flat under the Replicate base, keyed by prediction id alone.
    const res = await rawFetch(iuReplicateUrl(`/predictions/${id}`), { method: "GET", headers: iuHeaders() });
    if (res.status < 200 || res.status >= 300) {
      throw new ReplicateSynthError(`Replicate poll failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
    }
    const pred = JSON.parse(res.body) as ReplicatePrediction;
    if (pred.status !== "starting" && pred.status !== "processing") return pred;
  }
  throw new ReplicateSynthError(`Replicate prediction ${id} timed out after ${CREATE_DEADLINE_MS}ms`);
}

async function runPrediction(model: string, input: Record<string, unknown>): Promise<ReplicatePrediction> {
  let pred = await createPrediction(model, input);
  if (pred.status === "starting" || pred.status === "processing") {
    if (!pred.id) throw new ReplicateSynthError("Replicate prediction missing id for polling");
    pred = await pollPrediction(pred.id);
  }
  if (pred.status === "failed" || pred.status === "canceled") {
    throw new ReplicateSynthError(`Replicate prediction ${pred.status}: ${pred.error ?? "unknown error"}`);
  }
  if (pred.status !== "succeeded") {
    throw new ReplicateSynthError(`Replicate prediction ended in unexpected status: ${pred.status}`);
  }
  return pred;
}

/** Replicate serves prediction output from its own CDN only; anything else is refused (no open fetch). */
function isReplicateDeliveryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    return url.protocol === "https:" && (host === "replicate.delivery" || host.endsWith(".replicate.delivery"));
  } catch {
    return false;
  }
}

async function fetchDelivery(pred: ReplicatePrediction): Promise<Uint8Array> {
  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!url) throw new ReplicateSynthError("Replicate prediction succeeded with no output URL");
  if (!isReplicateDeliveryUrl(url)) throw new ReplicateSynthError("Replicate output URL is not a replicate.delivery URL");
  const res = await fetch(url);
  if (!res.ok) throw new ReplicateSynthError(`Failed to fetch Replicate output: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Clamp `speed` to ElevenLabs' 0.7–1.2 range; omit the field entirely at the neutral 1. */
function clampSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined) return undefined;
  const clamped = Math.min(1.2, Math.max(0.7, speed));
  return clamped === 1 ? undefined : clamped;
}

interface ReplicateChunkParams {
  model: string;
  chunk: PrepChunk;
  previousText?: string;
  nextText?: string;
  voice: string;
  languageCode: string;
  stability: number;
  style: number;
  similarityBoost: number;
  speed?: number;
}

interface ReplicateChunkResult {
  mp3: Uint8Array;
  /** The chunk decoded to s16le mono 24 kHz — the shape the shared concat/transcode stage consumes. */
  pcm: Uint8Array;
  audioSeconds: number;
  inputChars: number;
  latencyMs: number;
  predictTime: number | null;
}

/**
 * Synthesize one chunk on Replicate/ElevenLabs and decode it to PCM. Usage is
 * recorded HERE, right after the billed upstream call — never deferred behind
 * the shared concat/transcode stage, so an ffmpeg failure later can't lose a
 * paid row. On failure, a best-effort error usage row is recorded (mirrors
 * the Gemini lane's Decision-2 pattern) before rethrowing — the caller maps
 * `ReplicateSynthError` to a 502. Decoding inside this stage also keeps the
 * ffmpeg fan-out bounded by `config.ttsConcurrency`.
 */
async function synthReplicateChunk(params: ReplicateChunkParams): Promise<ReplicateChunkResult> {
  const speed = clampSpeed(params.speed);
  const input = {
    prompt: params.chunk.text,
    voice: params.voice,
    language_code: params.languageCode,
    stability: params.stability,
    style: params.style,
    similarity_boost: params.similarityBoost,
    ...(speed !== undefined && { speed }),
    ...(params.previousText && { previous_text: params.previousText }),
    ...(params.nextText && { next_text: params.nextText }),
  };

  const start = Date.now();
  let result: ReplicateChunkResult;
  try {
    const pred = await runPrediction(params.model, input);
    const mp3 = await fetchDelivery(pred);
    const latencyMs = Date.now() - start;
    const decoded = await transcode(mp3, { kind: "auto" }, "pcm");
    const pcm = new Uint8Array(decoded.bytes);
    result = {
      mp3,
      pcm,
      audioSeconds: pcm.byteLength / (2 * SAMPLE_RATE_DEFAULT),
      inputChars: params.chunk.text.length,
      latencyMs,
      predictTime: pred.metrics?.predict_time ?? null,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorText = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    log.error("replicate tts synth error", { endpoint: "speech", model: params.model, latencyMs, error: errorText });
    recordUsage({ endpoint: "speech", model: params.model, status: 502, latencyMs, inputChars: params.chunk.text.length, errorText });
    throw err;
  }
  // One usage row per chunk — Replicate bills per input character, not per token.
  recordUsage({
    endpoint: "speech",
    model: params.model,
    status: 200,
    latencyMs: result.latencyMs,
    inputChars: result.inputChars,
    audioSeconds: result.audioSeconds,
    bytesOut: result.mp3.byteLength,
    usageJson: { predict_time: result.predictTime, language_code: params.languageCode },
  });
  return result;
}

export async function handleReplicateSpeech(reqBody: ReplicateSpeechRequest): Promise<Response> {
  const { model, input, voice, responseFormat, summarize, speed, instructions, language, stability, style, similarityBoost } = reqBody;
  if (!input.trim()) {
    return Response.json({ error: { message: "input is required", type: "invalid_request_error" } }, { status: 400 });
  }

  const voiceName = VOICES.has(voice) ? voice : config.ttsElevenLabsVoice;
  const languageCode = language && LANGUAGE_CODE.test(language) ? language : resolveLanguage(input);
  const unit = (v: number | undefined, fallback: number): number =>
    v === undefined ? fallback : Math.min(1, Math.max(0, v));

  const { prep, ran: prepRan } = await runReplicatePrep(model, input, summarize, instructions);
  const chunks = enforceChunkLimits(prep.chunks, CHUNK_LIMITS);

  let parts: ReplicateChunkResult[];
  try {
    parts = await synthConcurrent(config.ttsConcurrency, chunks, (chunk, i) =>
      synthReplicateChunk({
        model,
        chunk,
        previousText: chunks[i - 1]?.text,
        nextText: chunks[i + 1]?.text,
        voice: voiceName,
        languageCode,
        stability: unit(stability, config.ttsElevenLabsStability),
        style: unit(style, config.ttsElevenLabsStyle),
        similarityBoost: unit(similarityBoost, config.ttsElevenLabsSimilarity),
        speed,
      }),
    );
  } catch (err) {
    if (err instanceof ReplicateSynthError) {
      return Response.json({ error: { message: err.message, type: "proxy_error" } }, { status: 502 });
    }
    throw err;
  }

  // Single chunk + mp3 requested → return the fetched bytes as-is (no re-encode).
  // Otherwise concat the already-decoded PCM and transcode once.
  let bytes: ArrayBuffer;
  let contentType: string;
  if (chunks.length === 1 && responseFormat === "mp3") {
    const only = parts[0];
    if (!only) throw new Error("Replicate synth produced no chunks");
    bytes = only.mp3.buffer.slice(only.mp3.byteOffset, only.mp3.byteOffset + only.mp3.byteLength) as ArrayBuffer;
    contentType = "audio/mpeg";
  } else {
    const pcmParts: ChunkAudio[] = parts.map((p) => ({ pcm: p.pcm, sampleRate: SAMPLE_RATE_DEFAULT }));
    const { pcm, sampleRate } = concatPcm(pcmParts);
    const encoded = await transcode(pcm, { kind: "pcm", sampleRate }, responseFormat);
    bytes = encoded.bytes;
    contentType = encoded.contentType;
  }

  const title = prep.title || fallbackTitle(input, prep.lang === "de");
  const headers: Record<string, string> = { "content-type": contentType };
  if (prepRan) headers["x-audio-title"] = encodeURIComponent(title);

  return new Response(bytes, { status: 200, headers });
}
