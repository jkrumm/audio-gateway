const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

/**
 * Parse a numeric env var. Falls back when unset/empty; fails fast on a
 * non-numeric value so a typo (`PORT=abc`) surfaces at boot rather than as a
 * NaN that silently breaks listening / concurrency / chunk math at runtime.
 */
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env var ${name}: "${raw}"`);
  return parsed;
};

/** Parse an enum env var against a whitelist; fail fast on an out-of-set value. */
const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(`Invalid env var ${name}: "${raw}" (expected one of: ${allowed.join(", ")})`);
  }
  return raw as T;
};

export const config = {
  port: num("PORT", 7714),
  iuApiKey: required("IU_API_KEY"),
  iuBaseUrl: required("IU_OPENAI_BASE_URL").replace(/\/+$/, ""),
  /**
   * IU Gemini (native `generateContent`) base, e.g. `.../gemini/v1beta`. Optional
   * at startup — only a Gemini TTS request needs it, so STT-only deployments boot
   * without it. `gemini-tts.ts` fails loudly when it is missing at request time.
   */
  iuGeminiBaseUrl: (process.env["IU_GEMINI_BASE_URL"] ?? "").replace(/\/+$/, ""),
  usageDb: process.env["USAGE_DB"] ?? "./data/usage.db",
  /** When set, callers must send `Authorization: Bearer <proxyApiKey>`. */
  proxyApiKey: process.env["PROXY_API_KEY"] ?? "",
  /**
   * Default TTS output model injected when a `/audio/speech` request omits `model`.
   * A model matching /gemini.*tts/i routes to the native expressive pipeline;
   * anything else proxies IU `/audio/speech`. Must stay a Gemini TTS model — the
   * non-Gemini fallback forwards the raw (model-less) body to IU, which 400s.
   * Gateway owns this default so callers (Argo dashboard, Hermes) need not know
   * model names. Requires IU_GEMINI_BASE_URL to be set for synthesis to succeed.
   */
  ttsModel: process.env["TTS_MODEL"] ?? "gemini-3.1-flash-tts-preview",
  /** Default STT `language` (ISO-639-1, e.g. `de`) injected when the client sends none. */
  sttLanguage: process.env["STT_LANGUAGE"] ?? "",
  /** Default STT `prompt` injected when the client sends none — steers expected language. */
  sttPrompt: process.env["STT_PROMPT"] ?? "",
  /** Gemini TTS prep model (OpenAI dialect) that rewrites text into Hermes-styled chunks. */
  ttsPrepModel: process.env["TTS_PREP_MODEL"] ?? "DeepSeek-V4-Pro",
  /**
   * Output bitrates (kbps) for the transcoded Gemini TTS audio, tuned for SPEECH
   * rather than music: the source is mono 24 kHz expressive narration, so these
   * low bitrates stay transparent for voice while keeping Hermes/Slack
   * attachments small. MP3 is the default (reliable inline playback); Opus is far
   * more efficient for voice but less universally previewable.
   */
  ttsBitrateKbps: num("TTS_MP3_BITRATE", 48),
  ttsOpusBitrateKbps: num("TTS_OPUS_BITRATE", 32),
  /** Below this input length the prep step short-circuits to a single chunk (~45 s of speech). */
  ttsChunkCharThreshold: num("TTS_CHUNK_THRESHOLD", 700),
  /**
   * Per-chunk size ceilings enforced AFTER prep, independent of what the prep LLM
   * returns. Gemini TTS quality drifts once a single generation runs past ~60 s of
   * speech, so chunks are kept to ~45 s. `targetWords` is the preferred size when
   * regrouping; `maxWords`/`maxBytes` are hard ceilings that trigger a re-split at
   * natural boundaries (paragraphs → sentences → last-resort word split). The byte
   * ceiling stays well under Gemini's 4000-byte text-field limit.
   */
  ttsChunkTargetWords: num("TTS_CHUNK_TARGET_WORDS", 110),
  ttsChunkMaxWords: num("TTS_CHUNK_MAX_WORDS", 150),
  ttsChunkMaxBytes: num("TTS_CHUNK_MAX_BYTES", 1800),
  /**
   * Prep behaviour for Gemini TTS:
   * - `always` (default): run the LLM prep for every request (short input → one cheap call).
   * - `long`: only run the LLM prep when input >= threshold; short input uses a default style.
   * - `off`: never call the LLM; speak the raw text with a default persona style directive.
   */
  ttsPrep: oneOf("TTS_PREP", ["always", "long", "off"] as const, "always"),
  /**
   * Maximum number of Gemini TTS chunks synthesized concurrently (Decision 1).
   * Clamped to [1, 8]; value of 1 = sequential (matches the original audio-proxy behaviour).
   */
  ttsConcurrency: Math.min(8, Math.max(1, num("TTS_CONCURRENCY", 4))),
  /** Usage sink selection: which adapter records audio usage rows. */
  usageSink: oneOf("USAGE_SINK", ["sqlite", "http", "both"] as const, "sqlite"),
  /** Base URL for the HTTP usage sink (Phase-3 seam; unused while sink is `sqlite`). */
  usageHttpUrl: process.env["USAGE_HTTP_URL"] ?? "",
  /** Label stamped on usage rows by the HTTP sink to identify this instance. */
  usageSourceLabel: process.env["USAGE_SOURCE_LABEL"] ?? "audio-gateway",
  /** Graceful-shutdown drain budget in milliseconds (Decision 5). */
  shutdownDrainMs: num("SHUTDOWN_DRAIN_MS", 10000),
} as const;
