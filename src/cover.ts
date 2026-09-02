import { config } from "./config";
import { recordUsage } from "./usage";
import { withSpan } from "./otel";

// Thin client for the image-gen gateway's `/generate` endpoint — the source of
// podcast episode cover art. Slow (10–60s per image) and billed, so every call
// is a client-kind span plus a usage row, mirroring the Replicate TTS lane's
// pattern (see replicate-tts.ts's synthReplicateChunk).

const REQUEST_TIMEOUT_MS = 180_000;

/** Any non-2xx response, network failure, or malformed body from the image-gen gateway. */
export class CoverError extends Error {}

/** Whether both the gateway URL and API key are set — unset disables cover generation entirely. */
export function coverConfigured(): boolean {
  return config.imageGenUrl !== "" && config.imageGenApiKey !== "";
}

interface GenerateResponse {
  id?: string;
  model?: string;
  images?: Array<{ b64_json: string; format: string }>;
  usage?: unknown;
  cost?: { usd: number | null; source: "computed" | "none" };
  latency_ms?: number;
}

interface GenerateError {
  error: { message: string; type: string };
}

export interface CoverResult {
  png: Uint8Array;
  costUsd: number | null;
  model: string;
}

/**
 * Generate a 1024x1024 PNG cover via the image-gen gateway. Throws
 * {@link CoverError} on any failure (unconfigured, non-2xx, malformed
 * response) — callers decide whether a missing cover blocks publishing or is
 * skipped.
 */
export async function generateCover(prompt: string): Promise<CoverResult> {
  if (!coverConfigured()) {
    throw new CoverError("image-gen gateway not configured (IMAGE_GEN_URL/IMAGE_GEN_API_KEY unset)");
  }

  return withSpan(
    "audio.cover",
    { "audio.cover.prompt_chars": prompt.length },
    async (span) => {
      const start = Date.now();
      let res: Response;
      try {
        res = await fetch(`${config.imageGenUrl}/generate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.imageGenApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            prompt,
            size: "1024x1024",
            quality: "medium",
            output_format: "png",
            n: 1,
            moderation: "auto",
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const latencyMs = Date.now() - start;
        const errorText = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        recordUsage({ endpoint: "podcast-cover", model: "image-gen", status: 0, latencyMs, inputChars: prompt.length, errorText });
        throw new CoverError(`image-gen request failed: ${errorText}`);
      }

      const latencyMs = Date.now() - start;
      span.setAttributes({ "http.status_code": res.status });
      const bodyText = await res.text();

      if (res.status < 200 || res.status >= 300) {
        const errorText = bodyText.slice(0, 500);
        let message = errorText;
        try {
          message = (JSON.parse(bodyText) as GenerateError).error?.message ?? errorText;
        } catch {
          // fall through with the raw body
        }
        recordUsage({ endpoint: "podcast-cover", model: "image-gen", status: res.status, latencyMs, inputChars: prompt.length, errorText });
        throw new CoverError(`image-gen failed: HTTP ${res.status} ${message}`);
      }

      let json: GenerateResponse;
      try {
        json = JSON.parse(bodyText) as GenerateResponse;
      } catch {
        recordUsage({ endpoint: "podcast-cover", model: "image-gen", status: res.status, latencyMs, inputChars: prompt.length, errorText: "malformed JSON response" });
        throw new CoverError("image-gen returned malformed JSON");
      }

      const image = json.images?.[0];
      if (!image?.b64_json) {
        recordUsage({ endpoint: "podcast-cover", model: json.model ?? "image-gen", status: res.status, latencyMs, inputChars: prompt.length, errorText: "no image in response" });
        throw new CoverError("image-gen response contained no image");
      }

      const png = new Uint8Array(Buffer.from(image.b64_json, "base64"));
      const model = json.model ?? "image-gen";
      const costUsd = json.cost?.usd ?? null;

      recordUsage({
        endpoint: "podcast-cover",
        model,
        status: res.status,
        latencyMs,
        inputChars: prompt.length,
        bytesOut: png.byteLength,
        usageJson: { cost_usd: costUsd, cost_source: json.cost?.source, ...(typeof json.usage === "object" && json.usage ? json.usage : {}) },
      });

      return { png, costUsd, model };
    },
    "client",
  );
}
