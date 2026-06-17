import { unlink } from "node:fs/promises";
import { config } from "./config";
import { iuHeaders, iuUrl } from "./iu";
import { recordUsage } from "./usage";

/**
 * gpt-4o(-mini)-transcribe and -diarize only support `json`/`text` on IU —
 * `verbose_json`/`srt`/`vtt` and timestamp_granularities are rejected (503).
 * For those models we ask IU for plain `json` and synthesize the richer
 * envelope the client asked for. `whisper` supports the rich formats natively
 * (real segment timing), so it is passed through untouched.
 */
const SYNTH_MODEL = /transcribe/i;
const RICH_FORMATS = new Set(["verbose_json", "srt", "vtt"]);

/** Probe audio length via ffprobe; 0 if unavailable (timing is best-effort). */
async function audioDuration(file: File): Promise<number> {
  const tmp = `/tmp/audio-gateway-${crypto.randomUUID()}`;
  try {
    await Bun.write(tmp, await file.arrayBuffer());
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", tmp],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const d = Number.parseFloat(out.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export const srtTime = (s: number): string => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const sec = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  const milli = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${sec},${milli}`;
};

export const verboseJson = (text: string, duration: number, language: string | null) => ({
  task: "transcribe",
  language: language ?? "unknown",
  duration,
  text,
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0,
      end: duration,
      text,
      tokens: [] as number[],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 1,
      no_speech_prob: 0,
    },
  ],
});

export const srt = (text: string, duration: number): string =>
  `1\n${srtTime(0)} --> ${srtTime(duration)}\n${text}\n`;

export const vtt = (text: string, duration: number): string =>
  `WEBVTT\n\n${srtTime(0).replace(",", ".")} --> ${srtTime(duration).replace(",", ".")}\n${text}\n`;

export async function handleTranscriptions(req: Request): Promise<Response> {
  const form = await req.formData();
  const model = String(form.get("model") ?? "");
  const clientFormat = String(form.get("response_format") ?? "json");
  const language = form.get("language") ? String(form.get("language")) : null;
  const file = form.get("file");

  const synth = SYNTH_MODEL.test(model) && RICH_FORMATS.has(clientFormat);

  // Rebuild the upstream form, downgrading the format for synth models.
  const upstream = new FormData();
  for (const [key, value] of form.entries()) {
    if (key === "response_format" || key === "timestamp_granularities[]") continue;
    upstream.append(key, value);
  }
  upstream.append("response_format", synth ? "json" : clientFormat);

  // Inject language steering when the client provided none. `language` is a hard
  // single-language lock; `prompt` is a softer bias (use it for "de or en").
  if (!form.has("language") && config.sttLanguage) upstream.append("language", config.sttLanguage);
  if (!form.has("prompt") && config.sttPrompt) upstream.append("prompt", config.sttPrompt);

  const start = Date.now();
  const res = await fetch(iuUrl("/audio/transcriptions"), {
    method: "POST",
    headers: iuHeaders(),
    body: upstream,
  });
  const latencyMs = Date.now() - start;
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();

  if (!res.ok) {
    recordUsage({ endpoint: "transcriptions", model, status: res.status, latencyMs, responseFormat: clientFormat });
    return new Response(body, { status: res.status, headers: { "content-type": contentType } });
  }

  let text = body;
  let usage: unknown = null;
  let detectedLang = language ?? (config.sttLanguage || null);
  if (contentType.includes("application/json")) {
    const json = JSON.parse(body) as Record<string, unknown>;
    text = typeof json["text"] === "string" ? json["text"] : "";
    usage = json["usage"] ?? null;
    if (typeof json["language"] === "string") detectedLang = json["language"];
  }

  recordUsage({
    endpoint: "transcriptions",
    model,
    status: res.status,
    latencyMs,
    responseFormat: clientFormat,
    usageJson: usage,
  });

  if (synth && file instanceof File) {
    const duration = await audioDuration(file);
    if (clientFormat === "verbose_json") return Response.json(verboseJson(text, duration, detectedLang));
    if (clientFormat === "srt") return new Response(srt(text, duration), { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(vtt(text, duration), { headers: { "content-type": "text/vtt; charset=utf-8" } });
  }

  // Whisper rich formats and plain json/text pass through faithfully.
  if (clientFormat === "json") return Response.json({ text });
  return new Response(body, { status: res.status, headers: { "content-type": contentType } });
}
