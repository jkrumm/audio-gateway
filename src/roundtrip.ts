/**
 * Round-trip validator: text → Gemini TTS → MP3 (saved + played) → STT → text.
 *
 * Exercises BOTH audio paths in a single run and leaves a listenable artifact in
 * ./out/. Two modes:
 *
 *   in-process (default) — calls `handleRequest()` directly (no HTTP server, no
 *     port bind), like the e2e smoke test. Needs the IU creds from `.env.tpl`.
 *       bun run test:roundtrip
 *
 *   live (RT_BASE_URL set) — HTTP-fetches a deployed gateway. Needs NO local IU
 *     creds (the gateway holds them); reachable only from the tailnet.
 *       bun run test:roundtrip:prod
 *
 * Override via env:
 *   RT_BASE_URL   — when set, fetch this origin over HTTP instead of in-process
 *   RT_TEXT       — the sentence to synthesize (default exercises German + numbers/times)
 *   RT_TTS_MODEL  — Gemini TTS model; MUST be a live IU model matching /gemini.*tts/i
 *   RT_STT_MODEL  — transcription model (default gpt-4o-transcribe)
 *   RT_VOICE      — Gemini voice (default Charon)
 *   RT_NO_PLAY=1  — skip afplay (for headless runs)
 *
 * The comparison is fuzzy by design: the prep LLM rewrites numbers/times into
 * spoken form, so the transcript never matches the input verbatim. Word recall is
 * a sanity floor that confirms the pipeline produced intelligible, related speech.
 */
import { mkdir } from "node:fs/promises";

const BASE = process.env["RT_BASE_URL"] ?? "";
const TEXT = process.env["RT_TEXT"]
  ?? "Hallo, das ist ein Test des Audio-Gateways. Es ist Viertel nach neun, und ich habe heute neunzig Kilo gehoben.";
const TTS_MODEL = process.env["RT_TTS_MODEL"] ?? "gemini-3.1-flash-tts-preview";
const STT_MODEL = process.env["RT_STT_MODEL"] ?? "gpt-4o-transcribe";
const VOICE = process.env["RT_VOICE"] ?? "Charon";
const PROXY_KEY = process.env["PROXY_API_KEY"] ?? "";

type Handler = (req: Request) => Promise<Response>;
let localHandler: Handler | undefined;

/** Apply the bearer header only when the gateway is configured to require it. */
function withAuth(init: RequestInit): RequestInit {
  if (!PROXY_KEY) return init;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${PROXY_KEY}`);
  return { ...init, headers };
}

/** Route a request either over HTTP to RT_BASE_URL or through the in-process handler. */
async function call(path: string, init: RequestInit): Promise<Response> {
  const withAuthInit = withAuth(init);
  if (BASE) return fetch(`${BASE}${path}`, withAuthInit);
  if (!localHandler) localHandler = (await import("./index")).handleRequest;
  return localHandler(new Request(`http://localhost${path}`, withAuthInit));
}

const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

/** Fraction of the original's words that also appear in the transcript (set recall). */
function recall(original: string, transcript: string): number {
  const orig = new Set(words(original));
  const got = new Set(words(transcript));
  if (orig.size === 0) return 0;
  let hit = 0;
  for (const w of orig) if (got.has(w)) hit++;
  return hit / orig.size;
}

async function main(): Promise<void> {
  console.log(`\n▶ Round-trip validation (${BASE ? `live: ${BASE}` : "in-process"})`);
  console.log(`  TTS model: ${TTS_MODEL}  voice: ${VOICE}`);
  console.log(`  STT model: ${STT_MODEL}`);
  console.log(`  input:     ${TEXT}\n`);

  // 1. TTS — text → MP3
  const ttsStart = Date.now();
  const ttsRes = await call("/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, input: TEXT, voice: VOICE, response_format: "mp3" }),
  });
  const ttsMs = Date.now() - ttsStart;

  if (ttsRes.status !== 200) {
    console.error(`✗ TTS failed: ${ttsRes.status}\n${await ttsRes.text()}`);
    process.exit(1);
  }

  const mp3 = Buffer.from(await ttsRes.arrayBuffer());
  await mkdir("out", { recursive: true });
  const path = `out/roundtrip-${Date.now()}.mp3`;
  await Bun.write(path, mp3);
  console.log(`✓ TTS  ${ttsMs} ms  ${(mp3.byteLength / 1024).toFixed(1)} KB  → ${path}`);
  const title = ttsRes.headers.get("x-audio-title");
  if (title) console.log(`  title: ${decodeURIComponent(title)}`);

  // 2. Listen (macOS afplay) unless disabled
  if (process.platform === "darwin" && process.env["RT_NO_PLAY"] !== "1") {
    console.log("♪ playing…");
    await Bun.spawn(["afplay", path], { stdout: "ignore", stderr: "ignore" }).exited;
  }

  // 3. STT — MP3 → text
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("response_format", "json");
  form.append("file", new File([mp3], "roundtrip.mp3", { type: "audio/mpeg" }));
  const sttStart = Date.now();
  const sttRes = await call("/v1/audio/transcriptions", { method: "POST", body: form });
  const sttMs = Date.now() - sttStart;

  if (sttRes.status !== 200) {
    console.error(`✗ STT failed: ${sttRes.status}\n${await sttRes.text()}`);
    process.exit(1);
  }

  const body = await sttRes.json() as { text?: string };
  const transcript = body.text ?? "";
  console.log(`✓ STT  ${sttMs} ms`);
  console.log(`  transcript: ${transcript}\n`);

  // 4. Compare (fuzzy — see file header)
  const score = recall(TEXT, transcript);
  const verdict = score >= 0.6 ? "PASS" : score >= 0.3 ? "REVIEW" : "FAIL";
  console.log(`  word recall (original ∩ transcript): ${(score * 100).toFixed(0)}%  → ${verdict}`);
  console.log("  (fuzzy by design: numbers/times are spoken out, so <100% is expected)\n");

  if (score < 0.3) process.exit(1);
}

if (import.meta.main) {
  await main();
}
