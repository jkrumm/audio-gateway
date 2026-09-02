import { SAMPLE_RATE_DEFAULT } from "./audio";
import { synthConcurrent } from "./gemini-tts-core";
import type { PodcastHost, ScriptSegment } from "./podcast-script";
import { synthReplicateChunk, type ReplicateChunkParams } from "./replicate-tts";

// One voice per host, one Replicate prediction per turn. Flattens a script's
// segments into a flat turn list (turnsForSynthesis) and synthesizes each on
// the Replicate/ElevenLabs lane (synthesizeTurns), reusing the shared
// bounded-concurrency runner and the lane's own per-chunk synth+decode
// (synthReplicateChunk) — no new upstream call shape.

/** Per-speaker prosody continuity is what previous/nextText is for — the other host's line in between isn't useful context. */
const CONTEXT_MAX_CHARS = 600;

export interface SynthTurnInput {
  text: string;
  voice: string;
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
 */
export function turnsForSynthesis(
  segments: ScriptSegment[],
  hosts: [PodcastHost, PodcastHost],
  languageCode: string,
): SynthTurnInput[] {
  const voiceById = new Map<"A" | "B", string>(hosts.map((h) => [h.id, h.voice] as const));
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
    out[i] = {
      text: turn.text,
      voice: voiceById.get(turn.speaker) ?? hosts[0].voice,
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
    };
    const result = await synthReplicateChunk(params);
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
