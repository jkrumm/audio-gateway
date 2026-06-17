import { config } from "./config";
import type { ChunkLimits, PrepChunk, PrepResult } from "./gemini-tts-core";
import { enforceChunkLimits, parsePrepResponse, SAMPLE_RATE_DEFAULT } from "./gemini-tts-core";
import { iuGeminiUrl, iuHeaders, iuUrl } from "./iu";
import { recordUsage } from "./usage";

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

const SILENCE_MS = 400;

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
  responseFormat: string;
  summarize: boolean;
}

const SUMMARY_SYSTEM_PROMPT = `You turn an assistant reply into ONE short spoken confirmation, in the persona of Hermes — a calm, warm, concise "sharp older friend". The user is in a hands-free voice conversation and only wants the gist spoken aloud, not the full reply.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) IN that language: plain words, no quotes, no trailing punctuation, no emoji.
3. Condense the reply into a SINGLE spoken confirmation of at most ~30 words, IN the same language, capturing only the key outcome or answer. Speak numbers, times, dates and units in spoken form (German: "achtzehn Uhr dreißig", "neunzig Kilo"; English: "half past six", "ninety kilos"). No greetings, no filler, no markdown, no lists. If the reply confirms an action, state plainly what was done (e.g. "Todo 'Staubsaugen' für morgen in Persönlich erstellt"). If the reply is a question or needs a real answer, give the answer in one sentence.
4. Write one short "style" directive IN that language describing the warm, calm Hermes delivery.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"<directive>","text":"<one short sentence>"}]}`;

const PREP_SYSTEM_PROMPT = `You prepare text for Gemini text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Write a short title (3–6 words) summarizing the content, IN the transcript's language, suitable as a filename/label: plain words, no quotes, no trailing punctuation, no emoji.
3. Rewrite numbers, times, dates, units and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language.
4. Split the text into short chunks of about 110 words each (never more than 150), so each chunk is only about 40–50 seconds of speech — Gemini TTS quality degrades once a single chunk runs past ~60 seconds. Break at paragraph boundaries first, then at sentence boundaries; never split in the middle of a sentence. Short text stays a single chunk.
5. For each chunk, write a "style" directive (one short sentence) IN the transcript's language describing the warm, calm Hermes delivery, and embed 1–2 SPARSE inline tags inside the chunk's "text" at natural points. Use only these tags: German [pause] [nachdenklich] [lacht] [seufzt] [begeistert] [bestimmt] [flüsternd]; English [pause] [thoughtful] [chuckles] [sigh] [excited] [firm] [whispers]. Do not over-tag — one or two per chunk. Tags are performance cues, never read aloud.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","title":"<short title>","chunks":[{"style":"<directive>","text":"<transcript with inline tags>"}]}`;

/** Crude German detection for the no-LLM default path (off / short+long-mode). */
function looksGerman(text: string): boolean {
  if (/[äöüßÄÖÜ]/.test(text)) return true;
  return /\b(der|die|das|und|nicht|ein|eine|ist|mit|für|auch|werden|heute)\b/i.test(text);
}

/** First few words of the input as a fallback title for the no-LLM path. */
function fallbackTitle(input: string, de: boolean): string {
  const words = input.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const trimmed = words.replace(/[.,;:!?]+$/, "").trim();
  return trimmed || (de ? "Sprachnachricht" : "Voice memo");
}

/** Build a single-chunk PrepResult with a default Hermes style directive — no LLM call. */
function defaultPrep(input: string): PrepResult {
  const de = looksGerman(input);
  const style = de
    ? "Lies als warmer, ruhiger Erzähler, ohne Begrüßung, sachlich und natürlich"
    : "Read as a warm, calm narrator, no greeting, natural and matter-of-fact";
  return { lang: de ? "de" : "en", title: fallbackTitle(input, de), chunks: [{ style, text: input.trim() }] };
}

interface RawResponse {
  status: number;
  body: string;
}

/** fetch with backoff retry on 503/429 (mirrors modelpick's transient-failure handling). */
async function rawFetch(url: string, init: RequestInit, attempts = 3): Promise<RawResponse> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, init);
    if ((res.status === 503 || res.status === 429) && attempt < attempts) {
      await Bun.sleep(500 * attempt);
      continue;
    }
    return { status: res.status, body: await res.text() };
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
async function runPrep(input: string, summarize: boolean): Promise<PrepResult> {
  const usageEndpoint = summarize ? "speech-summary" : "speech-prep";

  if (!summarize) {
    const isLong = input.length >= config.ttsChunkCharThreshold;
    if (config.ttsPrep === "off") return defaultPrep(input);
    if (config.ttsPrep === "long" && !isLong) return defaultPrep(input);
  }

  const systemPrompt = summarize ? SUMMARY_SYSTEM_PROMPT : PREP_SYSTEM_PROMPT;

  const start = Date.now();
  const res = await rawFetch(iuUrl("/chat/completions"), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: config.ttsPrepModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      // Reasoning-capable OpenAI models reject `max_tokens`; the modern field works.
      max_completion_tokens: Math.min(32000, Math.max(2000, input.length + 1000)),
    }),
  });
  const latencyMs = Date.now() - start;

  if (res.status < 200 || res.status >= 300) {
    // Bug fix: record error usage BEFORE throwing so failures are visible in telemetry.
    recordUsage({
      endpoint: usageEndpoint,
      model: config.ttsPrepModel,
      status: res.status,
      latencyMs,
      inputChars: input.length,
    });
    throw new Error(`TTS prep failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }

  const json = JSON.parse(res.body) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenAiUsage;
  };
  recordUsage({
    endpoint: usageEndpoint,
    model: config.ttsPrepModel,
    status: res.status,
    latencyMs,
    inputChars: input.length,
    usageJson: json.usage,
  });

  const content = json.choices?.[0]?.message?.content ?? "";
  return parsePrepResponse(content);
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface ChunkAudio {
  pcm: Uint8Array;
  sampleRate: number;
}

/** Record a best-effort error usage row for a failed Gemini synth (bug fix §10.1). */
function recordSpeechError(model: string, status: number, latencyMs: number): void {
  recordUsage({ endpoint: "speech", model, status, latencyMs });
}

/**
 * Synthesize one chunk on Gemini and record a `speech` usage row.
 * Decision 2 / §10 bug fix: record a usage row (error status + latency) BEFORE
 * throwing on non-2xx or missing audio, so failures are visible in telemetry.
 */
async function synthChunk(model: string, voiceName: string, chunk: PrepChunk): Promise<ChunkAudio> {
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

  if (res.status < 200 || res.status >= 300) {
    // Bug fix: record error usage BEFORE throwing so failures are visible in telemetry.
    recordSpeechError(model, res.status, latencyMs);
    throw new Error(`Gemini TTS failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }

  const parsed = JSON.parse(res.body) as GeminiTtsResponse;
  const inline = parsed.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    // Bug fix: record error usage BEFORE throwing so failures are visible in telemetry.
    recordSpeechError(model, res.status, latencyMs);
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

  return { pcm, sampleRate };
}

/** Concatenate s16le PCM chunks with SILENCE_MS of silence between them. */
function concatPcm(parts: ChunkAudio[]): { pcm: Uint8Array; sampleRate: number } {
  const sampleRate = parts[0]?.sampleRate ?? SAMPLE_RATE_DEFAULT;
  const silenceBytes = Math.round((SILENCE_MS / 1000) * sampleRate) * 2; // 16-bit mono
  const gaps = Math.max(0, parts.length - 1);
  const total = parts.reduce((n, p) => n + p.pcm.byteLength, 0) + gaps * silenceBytes;
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((p, i) => {
    out.set(p.pcm, offset);
    offset += p.pcm.byteLength;
    if (i < parts.length - 1) offset += silenceBytes; // leave zeroed silence
  });
  return { pcm: out, sampleRate };
}

interface Encoded {
  bytes: ArrayBuffer;
  contentType: string;
}

/**
 * Transcode raw s16le mono PCM to a compressed, speech-tuned MP3 (default) or
 * Opus/OGG via ffmpeg. Bitrates are intentionally low — this is TTS narration,
 * not music — and Opus uses libopus's `voip` mode, optimized for voice.
 */
async function transcode(pcm: Uint8Array, sampleRate: number, opus: boolean): Promise<Encoded> {
  const codec = opus
    ? ["-c:a", "libopus", "-b:a", `${config.ttsOpusBitrateKbps}k`, "-application", "voip", "-f", "ogg"]
    : ["-c:a", "libmp3lame", "-b:a", `${config.ttsBitrateKbps}k`, "-f", "mp3"];
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0", ...codec, "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  // Read stdout/stderr concurrently with the write so the output pipe never deadlocks.
  const stdout = new Response(proc.stdout).arrayBuffer();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(pcm);
  await proc.stdin.end();
  const [bytes, errText, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg transcode failed (${exitCode}): ${errText.slice(0, 300)}`);
  }
  return { bytes, contentType: opus ? "audio/ogg" : "audio/mpeg" };
}

/**
 * Synthesize all chunks with bounded concurrency, preserving order (Decision 1).
 *
 * Runs up to `config.ttsConcurrency` chunks in parallel. Results are reassembled
 * by index. If any chunk fails after its retries, all other in-flight chunks are
 * allowed to settle (best-effort usage rows recorded) before the error is thrown
 * to preserve "no silent partial output" semantics.
 */
export async function synthChunksConcurrent(
  model: string,
  voiceName: string,
  chunks: PrepChunk[],
): Promise<ChunkAudio[]> {
  const concurrency = config.ttsConcurrency;
  const results: (ChunkAudio | Error)[] = new Array(chunks.length);

  // Process in windows of `concurrency` to stay within the bounded pool.
  // Each window fans out, waits for all, then moves to the next.
  for (let windowStart = 0; windowStart < chunks.length; windowStart += concurrency) {
    const windowEnd = Math.min(windowStart + concurrency, chunks.length);
    const batch = chunks.slice(windowStart, windowEnd);
    const settled = await Promise.allSettled(
      batch.map((chunk) => synthChunk(model, voiceName, chunk)),
    );
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome === undefined) continue; // required by noUncheckedIndexedAccess
      if (outcome.status === "fulfilled") {
        results[windowStart + i] = outcome.value;
      } else {
        results[windowStart + i] = outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
      }
    }
    // A chunk in this window failed after its retries. The window has settled
    // (above), but do NOT launch further windows — they'd burn upstream quota on
    // output the 500 discards (Decision 1: don't abort in-flight, but don't start
    // new batches once a failure is known).
    if (results.some((r) => r instanceof Error)) break;
  }

  // Check for failures; already-settled error rows were recorded inside synthChunk.
  const parts: ChunkAudio[] = [];
  for (const result of results) {
    if (result instanceof Error) throw result;
    if (result !== undefined) parts.push(result);
  }
  return parts;
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
  const prep = await runPrep(input, summarize);
  // Enforce the per-chunk ceiling regardless of how the prep LLM split things —
  // long chunks are the cause of mid-audio voice drift. Re-splits at natural
  // boundaries; short inputs and well-behaved chunks pass through untouched.
  const chunks = enforceChunkLimits(prep.chunks, CHUNK_LIMITS);

  // Concurrent, order-preserving synth (Decision 1).
  const parts = await synthChunksConcurrent(model, voiceName, chunks);

  const { pcm, sampleRate } = concatPcm(parts);
  const { bytes, contentType } = await transcode(pcm, sampleRate, responseFormat === "opus");

  // Surface the prep-LLM title so OpenAI-compatible clients (e.g. Hermes) can
  // name the file / Slack attachment. URL-encoded because HTTP header values
  // are ASCII-only and titles are often German (umlauts). Clients decode it.
  const title = prep.title || fallbackTitle(input, prep.lang === "de");

  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType, "x-audio-title": encodeURIComponent(title) },
  });
}
