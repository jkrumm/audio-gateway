// Pure, config-free transforms shared by both TTS lanes: prep-response
// parsing, chunk-size enforcement, language detection, and the bounded-
// concurrency synth runner. Kept separate from gemini-tts.ts/replicate-tts.ts
// (which boot config, fetch and ffmpeg) so these can be unit-tested without
// any environment. PCM/WAV framing and transcoding live in audio.ts instead —
// that's a real ffmpeg/ffprobe process boundary, not a pure transform.

export interface PrepChunk {
  /** Natural-language delivery directive, in the transcript's language. Spoken as direction, not aloud. */
  style: string;
  /** The transcript to speak, with sparse inline tags embedded. */
  text: string;
}

export interface PrepResult {
  lang: string;
  /** Short human label (3–6 words) for the audio, in the transcript's language. Used as a filename/Slack title. */
  title: string;
  chunks: PrepChunk[];
}

/** Crude German detection shared by both TTS lanes (no-LLM default path, and language steering). */
export function looksGerman(text: string): boolean {
  if (/[äöüßÄÖÜ]/.test(text)) return true;
  return /\b(der|die|das|und|nicht|ein|eine|ist|mit|für|auch|werden|heute)\b/i.test(text);
}

/**
 * Run `synth` over `items` with bounded concurrency, reassembling results in
 * original order regardless of completion order (Decision 1). Processes in
 * windows of `concurrency`; if any item in a window fails after its own
 * retries, the window is allowed to fully settle (so every item's outcome is
 * observable) but no further windows start — "no silent partial output": the
 * caller gets either every result in order, or the first error.
 */
export async function synthConcurrent<I, O>(
  concurrency: number,
  items: readonly I[],
  synth: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results: (O | Error)[] = new Array(items.length);

  for (let windowStart = 0; windowStart < items.length; windowStart += concurrency) {
    const windowEnd = Math.min(windowStart + concurrency, items.length);
    const batch = items.slice(windowStart, windowEnd);
    const settled = await Promise.allSettled(batch.map((item, i) => synth(item, windowStart + i)));
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
    if (results.some((r) => r instanceof Error)) break;
  }

  const out: O[] = [];
  for (const result of results) {
    if (result instanceof Error) throw result;
    if (result !== undefined) out.push(result);
  }
  return out;
}

/**
 * Parse the prep LLM's reply into a PrepResult. Tolerates markdown code fences
 * and leading/trailing prose by extracting the first balanced JSON object.
 * Throws if no usable `{lang, chunks:[{style,text}]}` shape is present.
 */
export function parsePrepResponse(raw: string): PrepResult {
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`prep returned no JSON object: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as {
    lang?: unknown;
    title?: unknown;
    chunks?: unknown;
  };
  if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
    throw new Error(`prep returned no chunks: ${raw.slice(0, 200)}`);
  }
  const chunks: PrepChunk[] = parsed.chunks.map((c) => {
    const obj = (c ?? {}) as { style?: unknown; text?: unknown };
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) throw new Error("prep chunk missing text");
    return { style: typeof obj.style === "string" ? obj.style.trim() : "", text };
  });
  const lang = typeof parsed.lang === "string" ? parsed.lang : "";
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  return { lang, title, chunks };
}

/** Per-chunk size ceilings for {@link enforceChunkLimits}. */
export interface ChunkLimits {
  /** Preferred words per chunk when regrouping smaller pieces. */
  targetWords: number;
  /** Hard ceiling: a chunk above this many words is re-split. */
  maxWords: number;
  /** Hard ceiling: a chunk whose text exceeds this many UTF-8 bytes is re-split. */
  maxBytes: number;
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length;

/** Whether a chunk's text sits within both hard ceilings (words and bytes). */
function withinHardLimits(text: string, limits: ChunkLimits): boolean {
  return wordCount(text) <= limits.maxWords && byteLength(text) <= limits.maxBytes;
}

/**
 * Split into sentences, keeping terminal punctuation. Breaks on `. ! ? …` (incl.
 * runs) followed by whitespace — good enough for spoken-text seams; an occasional
 * abbreviation mis-split only shifts a boundary, it never drops content.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Last resort: pack words into groups within the hard ceilings — only for a single over-long sentence. */
function splitWords(text: string, limits: ChunkLimits): string[] {
  const words = text.match(/\S+/g) ?? [];
  const out: string[] = [];
  let buf: string[] = [];
  for (const word of words) {
    const merged = buf.length > 0 ? `${buf.join(" ")} ${word}` : word;
    if (buf.length > 0 && (buf.length + 1 > limits.maxWords || byteLength(merged) > limits.maxBytes)) {
      out.push(buf.join(" "));
      buf = [word];
    } else {
      buf.push(word);
    }
  }
  if (buf.length > 0) out.push(buf.join(" "));
  return out;
}

/**
 * Break one over-long text into pieces each within the hard ceilings, always
 * preferring the largest natural boundary first: paragraphs, then sentences, and
 * only a single sentence that alone exceeds a ceiling is split between words.
 */
function atomize(text: string, limits: ChunkLimits): string[] {
  if (withinHardLimits(text, limits)) return [text];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.flatMap((p) => atomize(p, limits));
  const sentences = splitSentences(text);
  if (sentences.length > 1) return sentences.flatMap((s) => atomize(s, limits));
  return splitWords(text, limits);
}

/** Greedily pack natural-boundary pieces toward `targetWords` without crossing a hard ceiling. */
function pack(pieces: string[], style: string, limits: ChunkLimits): PrepChunk[] {
  const out: PrepChunk[] = [];
  let buf: string[] = [];
  for (const piece of pieces) {
    const merged = buf.length > 0 ? `${buf.join(" ")} ${piece}` : piece;
    if (buf.length > 0 && (wordCount(merged) > limits.targetWords || byteLength(merged) > limits.maxBytes)) {
      out.push({ style, text: buf.join(" ") });
      buf = [piece];
    } else {
      buf.push(piece);
    }
  }
  if (buf.length > 0) out.push({ style, text: buf.join(" ") });
  return out;
}

/**
 * Enforce per-chunk size ceilings on the prep output. Chunks already within the
 * hard limits pass through untouched (preserving the prep LLM's semantic chunking
 * and inline tags); over-long chunks are re-split at natural boundaries —
 * paragraphs, then sentences, then (only for a single giant sentence) words — and
 * regrouped toward `targetWords`. The point is to keep every Gemini generation
 * short enough that voice quality does not drift, without ever cutting
 * mid-sentence unless a lone sentence is itself too long to fit.
 */
export function enforceChunkLimits(chunks: PrepChunk[], limits: ChunkLimits): PrepChunk[] {
  const out: PrepChunk[] = [];
  for (const chunk of chunks) {
    if (withinHardLimits(chunk.text, limits)) {
      out.push(chunk);
      continue;
    }
    out.push(...pack(atomize(chunk.text, limits), chunk.style, limits));
  }
  return out;
}
