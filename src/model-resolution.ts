/**
 * Central model resolution for audio-gateway.
 *
 * Callers express intent via the endpoint (/audio/speech = TTS,
 * /audio/transcriptions = STT); the gateway owns model selection. A caller
 * sending a wrong or missing model id (e.g. "gemini-3.1-flash" instead of
 * "gemini-3.1-flash-tts-preview") is remapped here before it reaches any
 * upstream, so a bad model id never produces a confusing 503 at the wrong
 * upstream path. The correct model lives in ONE place (env TTS_MODEL /
 * STT_MODEL → config) and is never duplicated in call-sites.
 */

import { config } from "./config";
import { log } from "./log";

/** Models served by the native Gemini `generateContent` route, not OpenAI `/audio/speech`. */
export const GEMINI_TTS = /gemini.*tts/i;

/** A Replicate `owner/name` model id, e.g. "elevenlabs/flash-v2.5". */
// Each segment must start alphanumeric so a dot-segment (`foo/..`) can never
// reach the credentialed upstream URL builder.
export const REPLICATE_MODEL = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/;

export interface ModelResolution {
  model: string;
  requested: string;
  overridden: boolean;
}

export type TtsProvider = "gemini" | "replicate" | "passthrough";

export interface TtsRoute {
  provider: TtsProvider;
  model: string;
}

function classifyTtsModel(model: string): TtsProvider {
  if (GEMINI_TTS.test(model)) return "gemini";
  if (REPLICATE_MODEL.test(model)) return "replicate";
  return "passthrough";
}

/**
 * Resolve which TTS lane serves a request: the native Gemini `generateContent`
 * pipeline, the Replicate `owner/name` route (ElevenLabs models), or a
 * straight IU `/audio/speech` passthrough for anything else.
 *
 * An empty `requested` defaults to `config.ttsModel`. A non-empty value that
 * matches neither Gemini nor the Replicate id shape ALSO falls back to
 * `config.ttsModel` — deliberately: the gateway owns model choice, and a
 * caller's typo (`tts-1`, `gemini-3.1-flash`) must land on the configured
 * default rather than on an upstream that 400s. The passthrough lane is
 * therefore only reachable when `TTS_MODEL` itself names a plain IU
 * `/audio/speech` model.
 */
export function resolveTtsRoute(requested: string): TtsRoute {
  const candidate = requested.length > 0 ? requested : config.ttsModel;
  const provider = classifyTtsModel(candidate);
  if (provider !== "passthrough") return { provider, model: candidate };

  const fallback = config.ttsModel;
  return { provider: classifyTtsModel(fallback), model: fallback };
}

/**
 * IU STT models usable at the batch `/audio/transcriptions` endpoint. An earlier
 * /(transcribe|whisper)/i regex was too permissive: OpenAI names the IU endpoint
 * merely *lists* but does not serve at this path (or a typo) slipped through and
 * produced a raw `text/plain` 404 "No suitable backend server found" that clients
 * like MacWhisper cannot parse. Only these canonical ids are honoured as-is;
 * anything else is remapped to `config.sttModel`. `voxtral-*-transcribe-*` is
 * deliberately excluded — it only supports realtime, not this batch endpoint.
 */
export const STT_MODELS = new Set(["whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);

/**
 * Resolve the STT model to use.
 *
 * If `requested` is a known-good STT model (see `STT_MODELS`) it is honoured
 * as-is. Anything else is replaced with `config.sttModel`. `overridden` is true
 * only when the caller sent a non-empty but unrecognized value.
 */
export function resolveSttModel(requested: string): ModelResolution {
  if (STT_MODELS.has(requested)) {
    return { model: requested, requested, overridden: false };
  }
  return {
    model: config.sttModel,
    requested,
    overridden: requested.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Reasoning effort (2026-09-13 model rollout — rollout-brief-common.md)
// ---------------------------------------------------------------------------

/**
 * Reasoning-effort families reachable through the OpenAI-compat
 * `/chat/completions` leg, and the effort values each accepts (live-probed
 * 2026-09-13). Claude (the podcast voice owner) and Gemini (in the review
 * roster) are deliberately absent — neither has a probed `reasoning_effort`
 * contract on this leg — so both fall through to "no family" and get
 * the field omitted entirely rather than guessed at.
 */
const REASONING_EFFORT_ALLOWED = {
  "gpt-5": ["none", "low", "medium", "high", "xhigh", "max"],
  deepseek: ["low", "high", "xhigh", "max"],
  glm: ["low", "high", "max"],
} as const satisfies Record<string, readonly string[]>;

type ReasoningEffortFamily = keyof typeof REASONING_EFFORT_ALLOWED;

// Family matching is by PREFIX (a bare `gpt-5`/`deepseek`/`glm` string test) —
// every model whose id starts with one of these is assumed to share that
// family's probed effort set, not individually verified.
function reasoningEffortFamily(model: string): ReasoningEffortFamily | undefined {
  if (/^gpt-5/.test(model)) return "gpt-5";
  if (/^deepseek/.test(model)) return "deepseek";
  if (/^glm/.test(model)) return "glm";
  return undefined;
}

/**
 * Resolve the `reasoning_effort` value a call site should actually send for
 * `model`, given the configured `effort`, or `undefined` to omit the field
 * entirely. A model outside the three known reasoning-effort families (Claude,
 * Gemini, anything else) always omits it. An `effort` value outside the
 * model's own accepted set (e.g. "medium" for glm-5.3-flash, which the
 * upstream rejects) is dropped with a warning rather than sent — a stale or
 * typo'd env override should degrade to the model's own default, not break
 * the call. The one place this logic lives; callers never duplicate it.
 */
export function resolveReasoningEffort(model: string, effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const family = reasoningEffortFamily(model);
  if (!family) {
    // Not a silent no-op: a configured PODCAST_*_EFFORT that never lands
    // (e.g. pointed at claude/gemini, or a model id that doesn't match any
    // known prefix) should be visible, just not at warning level — this is
    // the expected outcome for Claude/Gemini, not a misconfiguration.
    log.info("reasoning_effort configured but model matches no known family, omitting", { model, effort });
    return undefined;
  }
  const allowed: readonly string[] = REASONING_EFFORT_ALLOWED[family];
  if (!allowed.includes(effort)) {
    log.warn("reasoning_effort not valid for this model family, omitting", { model, family, effort, allowed });
    return undefined;
  }
  return effort;
}
