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
