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

export interface ModelResolution {
  model: string;
  requested: string;
  overridden: boolean;
}

/**
 * Resolve the TTS model to use.
 *
 * If `requested` matches /gemini.*tts/i it is a recognized Gemini TTS model
 * and is honoured as-is. Any other value (empty, a chat model like
 * "gemini-3.1-flash", "tts-1", etc.) is replaced with `config.ttsModel`.
 * `overridden` is true only when the caller sent a non-empty but unrecognized
 * value — empty means omitted, which is the normal Argo/Hermes usage pattern.
 */
export function resolveTtsModel(requested: string): ModelResolution {
  if (GEMINI_TTS.test(requested)) {
    return { model: requested, requested, overridden: false };
  }
  return {
    model: config.ttsModel,
    requested,
    overridden: requested.length > 0,
  };
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
