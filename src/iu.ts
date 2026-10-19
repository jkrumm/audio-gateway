import { config, deriveAnthropicBaseUrl } from "./config";

/** Absolute IU URL for an OpenAI-dialect path like `/audio/transcriptions`. */
export const iuUrl = (path: string): string => `${config.iuBaseUrl}${path}`;

/** Absolute IU URL for a native Gemini path like `/models/{id}:generateContent`. */
export const iuGeminiUrl = (path: string): string => `${config.iuGeminiBaseUrl}${path}`;

/** Absolute IU URL for a Replicate path like `/models/{owner}/{name}/predictions`. */
export const iuReplicateUrl = (path: string): string => `${config.iuReplicateBaseUrl}${path}`;

/**
 * Absolute IU URL for a native Anthropic Messages path like `/v1/messages`.
 * Derives the base on each call, so a non-derivable IU_OPENAI_BASE_URL fails
 * only the job that uses the Anthropic route, not the process at boot.
 */
export const iuAnthropicUrl = (path: string): string =>
  `${deriveAnthropicBaseUrl(config.iuAnthropicBaseUrlOverride, config.iuBaseUrl)}${path}`;

/** Upstream headers carrying the IU bearer token. */
export const iuHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${config.iuApiKey}`,
  ...extra,
});
