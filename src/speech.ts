import { parseOutputFormat } from "./audio";
import { handleGeminiSpeech } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { GEMINI_TTS, resolveTtsRoute } from "./model-resolution";
import { handleReplicateSpeech } from "./replicate-tts";
import { recordUsage } from "./usage";

// Re-export GEMINI_TTS so any existing importers of the old location still work.
export { GEMINI_TTS };

/**
 * TTS dispatcher. `resolveTtsRoute` (model-resolution.ts) decides the lane:
 * Gemini TTS models route to the native synth pipeline (`gemini-tts.ts`),
 * Replicate `owner/name` ids (ElevenLabs) route to `replicate-tts.ts`,
 * everything else is a straight proxy of OpenAI's `/audio/speech`, returning
 * the audio stream unchanged.
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
  let responseFormatRaw: string;
  let summarize: boolean;
  let speed: number | undefined;
  let instructions: string | undefined;
  let language: string | undefined;
  let stability: number | undefined;
  let style: number | undefined;
  let similarityBoost: number | undefined;

  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    requestedModel = typeof json["model"] === "string" ? json["model"] : "";
    input = typeof json["input"] === "string" ? json["input"] : "";
    inputChars = input.length;
    voice = typeof json["voice"] === "string" ? json["voice"] : "";
    responseFormatRaw = typeof json["response_format"] === "string" ? json["response_format"] : "";
    summarize = json["summarize"] === true;
    speed = typeof json["speed"] === "number" ? json["speed"] : undefined;
    instructions = typeof json["instructions"] === "string" ? json["instructions"] : undefined;
    // `lang_code` is what Hermes' OpenAI provider sends (tts.openai.language → extra_body.lang_code).
    const lang = json["language"] ?? json["lang_code"];
    language = typeof lang === "string" ? lang : undefined;
    stability = typeof json["stability"] === "number" ? json["stability"] : undefined;
    style = typeof json["style"] === "number" ? json["style"] : undefined;
    similarityBoost = typeof json["similarity_boost"] === "number" ? json["similarity_boost"] : undefined;
  } catch {
    // Bug fix: non-JSON body → 400 JSON, no blank-model usage row.
    return Response.json(
      { error: { message: "request body must be valid JSON", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Reject an unrecognized response_format before dispatch, in every lane —
  // a client typo must never silently fall through to a broken upstream call.
  const responseFormat = parseOutputFormat(responseFormatRaw);
  if (responseFormat === null) {
    return Response.json(
      { error: { message: `unsupported response_format: ${responseFormatRaw}`, type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Central model resolution: a wrong or absent model never reaches the upstream.
  const route = resolveTtsRoute(requestedModel);
  if (requestedModel.length > 0 && route.model !== requestedModel) {
    log.warn("tts model overridden", {
      endpoint: "speech",
      requested: requestedModel,
      used: route.model,
      caller,
    });
  }

  if (route.provider === "gemini") {
    return handleGeminiSpeech({ model: route.model, input, voice, responseFormat, summarize });
  }

  if (route.provider === "replicate") {
    return handleReplicateSpeech({
      model: route.model,
      input,
      voice,
      responseFormat,
      summarize,
      speed,
      instructions,
      language,
      stability,
      style,
      similarityBoost,
    });
  }

  // IU OpenAI passthrough — build body from parsed fields so the resolved model
  // is used, not whatever the caller sent (which may be wrong or absent).
  const upstreamBody = JSON.stringify({
    model: route.model,
    input,
    ...(voice && { voice }),
    response_format: responseFormat,
    ...(speed !== undefined && { speed }),
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
      model: route.model,
      status: res.status,
      latencyMs,
      caller,
      error: errorText,
    });
  }

  recordUsage({
    endpoint: "speech",
    model: route.model,
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
