// Pure, config-free transforms for the Gemini TTS pipeline: PCM/WAV framing and
// prep-response parsing. Kept separate from gemini-tts.ts (which boots config,
// fetch and ffmpeg) so these can be unit-tested without any environment.

export const SAMPLE_RATE_DEFAULT = 24000;

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

/**
 * Wrap raw s16le PCM in a 44-byte WAV header (mono, 16-bit). Not used by the
 * ffmpeg path (which consumes raw `-f s16le`), but kept as a documented
 * single-chunk fallback and exercised by the header unit test.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE_DEFAULT, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
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
