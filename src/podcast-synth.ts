import { SAMPLE_RATE_DEFAULT } from "./audio";
import { synthConcurrent } from "./gemini-tts-core";
import type { PodcastHost, ScriptSegment } from "./podcast-script";
import { log } from "./log";
import { ReplicateSynthError, synthReplicateChunk, type ReplicateChunkParams } from "./replicate-tts";

// One voice per host, one Replicate prediction per turn. Flattens a script's
// segments into a flat turn list (turnsForSynthesis) and synthesizes each on
// the Replicate/ElevenLabs lane (synthesizeTurns), reusing the shared
// bounded-concurrency runner and the lane's own per-chunk synth+decode
// (synthReplicateChunk) — no new upstream call shape.
// Pacing lives here too: a turn thick with numbers is unlistenable at the
// host's normal rate, so it is synthesized a notch slower (numberDensity +
// TurnPacingOptions). ElevenLabs v3 has no SSML breaks; `speed` (0.7–1.2, per
// request) and the writer's own "…" are the only pacing controls we have.

/** Per-speaker prosody continuity is what previous/nextText is for — the other host's line in between isn't useful context. */
const CONTEXT_MAX_CHARS = 600;

/** ElevenLabs' per-request speed range. */
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;

/**
 * Whole tokens that ARE a number (or a unit that always travels with one).
 * "ein/eine/einer" are articles and deliberately absent; English "one" and
 * "point" are dropped too — both are common outside a number ("one of the
 * things", "I want to point out") and would otherwise false-positive.
 */
const NUMBER_WORDS = new Set([
  // German 0-12 plus the units that only ever appear alongside a figure
  "null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf",
  "komma", "prozent", "euro", "cent",
  // English 0-12 (minus "one", see above)
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  // English teens and tens, spelled out rather than matched by suffix ("-ty" also ends "pretty", "party")
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "million", "billion", "percent",
]);

/**
 * A German compound numeral is the WHOLE token built from a concatenation of
 * these stems (e.g. "einundzwanzig" = ein+und+zwanzig, "eintausenddreihundert-
 * dreiundsiebzig" = ein+tausend+drei+hundert+drei+und+siebzig) — matched in
 * full, never as a substring, so "einzig"/"regelmäßig"/"jetzig" (which merely
 * CONTAIN "zig"/"ßig") don't false-positive the way a `.includes()` check did.
 * "ein" and "und" alone are excluded below: an article and a conjunction, not
 * numbers by themselves.
 */
const GERMAN_COMPOUND_NUMERAL =
  /^(?:eins?|zwei|drei|vier|fünf|sechs?|sieb(?:en)?|acht|neun|zehn|elf|zwölf|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|hundert|tausend|million(?:en)?|milliarden?|und)+$/;

/**
 * Share of a turn's tokens that are numeric — digits, spelled-out German and
 * English numerals, and the units that always travel with a figure. Used to
 * spot the turns that read like a spreadsheet ("zwölf Euro fünfzig … hundert-
 * fünfzigtausend Euro mal drei Komma neun neun Prozent") and slow them down.
 * Pure; exported for tests.
 */
export function numberDensity(text: string): number {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return 0;
  const numeric = tokens.filter((token) => {
    if (/\d/.test(token)) return true;
    if (NUMBER_WORDS.has(token)) return true;
    if (token === "ein" || token === "und") return false;
    return GERMAN_COMPOUND_NUMERAL.test(token);
  }).length;
  return numeric / tokens.length;
}

export interface TurnPacingOptions {
  /** Number density above which a turn is synthesized slower (config.podcastDenseTurnThreshold). */
  denseThreshold: number;
  /** Speed delta applied to such a turn (config.podcastDenseTurnSlowdown). */
  denseSlowdown: number;
}

/** Mirrors the config defaults, so a caller that has not wired config through still gets the intended pacing. */
const DEFAULT_PACING: TurnPacingOptions = { denseThreshold: 0.12, denseSlowdown: 0.06 };

export interface SynthTurnInput {
  text: string;
  /** Which host speaks — the mux matches loudness per host, so the grouping key travels with the turn. */
  speaker: "A" | "B";
  voice: string;
  speed?: number;
  languageCode: string;
  previousText?: string;
  nextText?: string;
}

export interface SynthTurnOutput {
  pcm: Uint8Array;
  /** 24000 — the shared PCM sample rate every lane decodes to. */
  sampleRate: number;
  audioSeconds: number;
  inputChars: number;
}

export interface SynthTurnsOptions {
  model: string;
  concurrency: number;
  stability: number;
  similarityBoost: number;
  style: number;
  onProgress?: (done: number, total: number) => void;
}

const cap = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length > CONTEXT_MAX_CHARS ? text.slice(0, CONTEXT_MAX_CHARS) : text;

/**
 * Flatten a script's segments into turn order, mapping each speaker to its
 * host's voice. `previousText`/`nextText` are filled from the SAME speaker's
 * neighbouring turn (not the other host's) — that's what ElevenLabs uses for
 * per-voice prosody continuity — and capped at {@link CONTEXT_MAX_CHARS}.
 * A turn whose {@link numberDensity} is over `pacing.denseThreshold` is
 * slowed by `pacing.denseSlowdown` (clamped to ElevenLabs' 0.7–1.2 range) —
 * figures need more room than prose does.
 */
export function turnsForSynthesis(
  segments: ScriptSegment[],
  hosts: [PodcastHost, PodcastHost],
  languageCode: string,
  pacing: TurnPacingOptions = DEFAULT_PACING,
): SynthTurnInput[] {
  const hostById = new Map<"A" | "B", PodcastHost>(hosts.map((h) => [h.id, h] as const));
  const flat = segments.flatMap((segment) => segment.turns);

  const lastTextBySpeaker = new Map<"A" | "B", string>();
  const previousTextByIndex: Array<string | undefined> = flat.map((turn) => {
    const previous = lastTextBySpeaker.get(turn.speaker);
    lastTextBySpeaker.set(turn.speaker, turn.text);
    return previous;
  });

  const nextTextBySpeaker = new Map<"A" | "B", string>();
  const out: SynthTurnInput[] = new Array(flat.length);
  for (let i = flat.length - 1; i >= 0; i--) {
    const turn = flat[i];
    if (!turn) continue; // required by noUncheckedIndexedAccess
    const nextText = nextTextBySpeaker.get(turn.speaker);
    nextTextBySpeaker.set(turn.speaker, turn.text);
    const host = hostById.get(turn.speaker) ?? hosts[0];
    const dense = numberDensity(turn.text) > pacing.denseThreshold;
    const speed = dense
      ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, (host.speed ?? 1) - pacing.denseSlowdown))
      : host.speed;
    out[i] = {
      text: turn.text,
      speaker: turn.speaker,
      voice: host.voice,
      ...(speed !== undefined && { speed }),
      languageCode,
      previousText: cap(previousTextByIndex[i]),
      nextText: cap(nextText),
    };
  }
  return out;
}

/**
 * Synthesize every turn on the Replicate/ElevenLabs lane, bounded by
 * `opts.concurrency`. Reuses `synthReplicateChunk` (one prediction per turn,
 * decoded to PCM, usage recorded inside it) — `onProgress` fires per
 * completion, not per input order. Lets `ReplicateSynthError` propagate.
 */
export async function synthesizeTurns(turns: SynthTurnInput[], opts: SynthTurnsOptions): Promise<SynthTurnOutput[]> {
  let completed = 0;
  return synthConcurrent(opts.concurrency, turns, async (turn, index) => {
    const params: ReplicateChunkParams = {
      model: opts.model,
      chunk: { style: "", text: turn.text },
      index,
      previousText: turn.previousText,
      nextText: turn.nextText,
      voice: turn.voice,
      languageCode: turn.languageCode,
      stability: opts.stability,
      style: opts.style,
      similarityBoost: opts.similarityBoost,
      ...(turn.speed !== undefined && { speed: turn.speed }),
    };
    let result: Awaited<ReturnType<typeof synthReplicateChunk>>;
    try {
      result = await synthReplicateChunk(params);
    } catch (err) {
      // rawFetch already retries 503/429; a failed/odd prediction or a delivery
      // hiccup surfaces as ReplicateSynthError. One more attempt for a single
      // turn is far cheaper than failing an episode of a hundred turns.
      if (!(err instanceof ReplicateSynthError)) throw err;
      log.warn("podcast turn synth failed, retrying once", { index, error: err.message });
      result = await synthReplicateChunk(params);
    }
    completed++;
    opts.onProgress?.(completed, turns.length);
    return {
      pcm: result.pcm,
      sampleRate: SAMPLE_RATE_DEFAULT,
      audioSeconds: result.audioSeconds,
      inputChars: result.inputChars,
    } satisfies SynthTurnOutput;
  });
}
