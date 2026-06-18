import { handleGeminiSpeech } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { GEMINI_TTS, resolveTtsModel } from "./model-resolution";
import { recordUsage } from "./usage";

// Re-export GEMINI_TTS so any existing importers of the old location still work.
export { GEMINI_TTS };

/**
 * TTS dispatcher. Gemini TTS models route to the native synth pipeline
 * (`gemini-tts.ts`); everything else is a straight proxy of OpenAI's
 * `/audio/speech`, returning the audio stream unchanged.
 *
 * Decision 2 / §10 bug fix: if the request body is not valid JSON, respond with
 * 400 immediately — do NOT forward the raw body and do NOT write a blank-model
 * usage row.
 *
 * Change A: model resolution is centralised in model-resolution.ts — a caller
 * sending a wrong or missing model is remapped here, never at the upstream.
 * Change B: non-2xx upstream bodies are captured and emitted as structured logs.
 * Change C: caller identity is read from x-audio-source and included in logs.
 */
export async function handleSpeech(req: Request): Promise<Response> {
  const caller = req.headers.get("x-audio-source") ?? "unknown";
  const body = await req.text();

  let requestedModel: string;
  let inputChars: number;
  let input: string;
  let voice: string;
  let responseFormat: string;
  let summarize: boolean;

  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    requestedModel = typeof json["model"] === "string" ? json["model"] : "";
    input = typeof json["input"] === "string" ? json["input"] : "";
    inputChars = input.length;
    voice = typeof json["voice"] === "string" ? json["voice"] : "";
    responseFormat = typeof json["response_format"] === "string" ? json["response_format"] : "";
    summarize = json["summarize"] === true;
  } catch {
    // Bug fix: non-JSON body → 400 JSON, no blank-model usage row.
    return Response.json(
      { error: { message: "request body must be valid JSON", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Central model resolution: a wrong or absent model never reaches the upstream.
  const resolved = resolveTtsModel(requestedModel);
  if (resolved.overridden) {
    log.warn("tts model overridden", {
      endpoint: "speech",
      requested: resolved.requested,
      used: resolved.model,
      caller,
    });
  }

  if (GEMINI_TTS.test(resolved.model)) {
    return handleGeminiSpeech({ model: resolved.model, input, voice, responseFormat, summarize });
  }

  // IU OpenAI passthrough — build body from parsed fields so the resolved model
  // is used, not whatever the caller sent (which may be wrong or absent).
  const upstreamBody = JSON.stringify({
    model: resolved.model,
    input,
    ...(voice && { voice }),
    ...(responseFormat && { response_format: responseFormat }),
  });

  const start = Date.now();
  const res = await fetch(iuUrl("/audio/speech"), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body: upstreamBody,
  });
  const latencyMs = Date.now() - start;
  const audio = await res.arrayBuffer();
  const errorText = res.ok ? null : new TextDecoder().decode(audio).slice(0, 500);

  if (!res.ok) {
    log.error("tts upstream error", {
      endpoint: "speech",
      model: resolved.model,
      status: res.status,
      latencyMs,
      caller,
      error: errorText,
    });
  }

  recordUsage({
    endpoint: "speech",
    model: resolved.model,
    status: res.status,
    latencyMs,
    inputChars,
    bytesOut: audio.byteLength,
    errorText,
  });

  return new Response(audio, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg" },
  });
}
