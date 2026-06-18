import { config } from "./config";
import { handleGeminiSpeech } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { recordUsage } from "./usage";

/** Models served by the native Gemini `generateContent` route, not OpenAI `/audio/speech`. */
const GEMINI_TTS = /gemini.*tts/i;

/**
 * TTS dispatcher. Gemini TTS models route to the native synth pipeline
 * (`gemini-tts.ts`); everything else is a straight proxy of OpenAI's
 * `/audio/speech`, returning the audio stream unchanged.
 *
 * Decision 2 / §10 bug fix: if the request body is not valid JSON, respond with
 * 400 immediately — do NOT forward the raw body and do NOT write a blank-model
 * usage row.
 */
export async function handleSpeech(req: Request): Promise<Response> {
  const body = await req.text();

  let model: string;
  let inputChars: number;
  let input: string;
  let voice: string;
  let responseFormat: string;
  let summarize: boolean;

  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    // Default the output model when the caller omits it (the Argo dashboard sends
    // text only). Empty model would otherwise fall through to the IU passthrough,
    // which 400s with "Missing model name". The default is a Gemini TTS model →
    // native expressive pipeline (uses the parsed fields, not the raw body).
    model =
      typeof json["model"] === "string" && json["model"] ? json["model"] : config.ttsModel;
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

  if (GEMINI_TTS.test(model)) {
    return handleGeminiSpeech({ model, input, voice, responseFormat, summarize });
  }

  const start = Date.now();
  const res = await fetch(iuUrl("/audio/speech"), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body,
  });
  const latencyMs = Date.now() - start;
  const audio = await res.arrayBuffer();

  recordUsage({
    endpoint: "speech",
    model,
    status: res.status,
    latencyMs,
    inputChars,
    bytesOut: audio.byteLength,
  });

  return new Response(audio, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg" },
  });
}
