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
 * Resolve the STT model to use.
 *
 * If `requested` matches /(transcribe|whisper)/i it is a recognized STT model
 * and is honoured as-is. Anything else is replaced with `config.sttModel`.
 * `overridden` is true only when the caller sent a non-empty but unrecognized
 * value.
 */
export function resolveSttModel(requested: string): ModelResolution {
  if (/(transcribe|whisper)/i.test(requested)) {
    return { model: requested, requested, overridden: false };
  }
  return {
    model: config.sttModel,
    requested,
    overridden: requested.length > 0,
  };
}
