/** Round-trip check helper: transcribe an mp3 through the IU STT route (default voxtral, ~$0.0035/min). */
import { readFile } from "node:fs/promises";

export async function transcribe(path: string, iuBaseUrl: string, apiKey: string, model = "voxtral-mini-transcribe-3-0"): Promise<string> {
  const form = new FormData();
  form.append("file", new File([await readFile(path)], "audio.mp3", { type: "audio/mpeg" }));
  form.append("model", model);
  const res = await fetch(`${iuBaseUrl}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return json.text ?? "";
}
