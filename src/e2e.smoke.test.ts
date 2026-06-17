/**
 * Live-IU end-to-end smoke tests (STT + Gemini TTS round-trips).
 *
 * HERMETIC GUARD: these tests make ZERO network calls under a plain `bun test`.
 * They are gated behind `RUN_E2E=1` and run only via:
 *
 *   bun run test:e2e
 *
 * which is defined in package.json as:
 *   RUN_E2E=1 op run --account tkrumm --env-file=.env.tpl -- bun test src/e2e.smoke.test.ts
 *
 * Do NOT add these tests to the default `bun test` suite.
 */
import { describe, expect, test } from "bun:test";

describe.skipIf(process.env["RUN_E2E"] !== "1")("E2E smoke — live IU endpoint", () => {
  // Import gateway modules lazily inside the describe block so they are only
  // evaluated when the describe block actually runs (i.e. when RUN_E2E=1).
  // Under plain `bun test` the block is skipped before reaching `test()`.

  test("STT: POST /v1/audio/transcriptions returns transcribed text", async () => {
    const { handleRequest } = await import("./index");

    // A minimal silent WAV (44-byte header + 0 bytes PCM) as the audio file.
    const wavHeader = new Uint8Array(44);
    const view = new DataView(wavHeader.buffer);
    const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); view.setUint32(4, 36, true); w(8, "WAVE"); w(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, "data"); view.setUint32(40, 0, true);

    const form = new FormData();
    form.append("model", "gpt-4o-transcribe");
    form.append("response_format", "json");
    form.append("file", new File([wavHeader.buffer], "silence.wav", { type: "audio/wav" }));

    const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });
    const res = await handleRequest(req);

    // Accept 200 (transcribed text) or 400 (model rejected silent file) — either means the route reached IU.
    expect([200, 400, 422]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json() as Record<string, unknown>;
      expect(typeof body["text"]).toBe("string");
    }
  });

  test("Gemini TTS: POST /v1/audio/speech returns audio", async () => {
    const { handleRequest } = await import("./index");

    const req = new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.1-flash-tts-preview",
        input: "Hello, this is a smoke test.",
        voice: "Charon",
        response_format: "mp3",
      }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/");
    const audio = await res.arrayBuffer();
    expect(audio.byteLength).toBeGreaterThan(0);
  });
});
