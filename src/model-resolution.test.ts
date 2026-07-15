/**
 * Unit tests for central STT/TTS model resolution.
 *
 * config.ts reads env at import time, so env is set before the dynamic import.
 * With no STT_MODEL/TTS_MODEL override the config defaults apply
 * (gpt-4o-transcribe / gemini-3.1-flash-tts-preview).
 */
import { describe, expect, test } from "bun:test";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";

const { resolveSttModel, STT_MODELS } = await import("./model-resolution");

describe("resolveSttModel", () => {
  test("honours known-good STT models as-is", () => {
    for (const model of ["whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]) {
      const r = resolveSttModel(model);
      expect(r.model).toBe(model);
      expect(r.overridden).toBe(false);
    }
  });

  test("remaps an OpenAI-only 'transcribe' name the endpoint doesn't serve at this path", () => {
    // gpt-4o-transcribe-diarize is listed by IU but rejects the batch prompt path;
    // the old /(transcribe)/i regex leaked it through. It must now remap.
    const r = resolveSttModel("gpt-4o-transcribe-diarize");
    expect(r.model).toBe("gpt-4o-transcribe");
    expect(r.overridden).toBe(true);
  });

  test("remaps a realtime-only voxtral model", () => {
    const r = resolveSttModel("voxtral-mini-transcribe-realtime-2602");
    expect(r.model).toBe("gpt-4o-transcribe");
    expect(r.overridden).toBe(true);
  });

  test("remaps an unrecognized model and flags it overridden", () => {
    const r = resolveSttModel("some-random-model");
    expect(r.model).toBe("gpt-4o-transcribe");
    expect(r.overridden).toBe(true);
  });

  test("empty model defaults without flagging an override (the normal omitted case)", () => {
    const r = resolveSttModel("");
    expect(r.model).toBe("gpt-4o-transcribe");
    expect(r.overridden).toBe(false);
    expect(r.requested).toBe("");
  });

  test("STT_MODELS excludes realtime-only and diarize variants", () => {
    expect(STT_MODELS.has("whisper")).toBe(true);
    expect(STT_MODELS.has("gpt-4o-transcribe")).toBe(true);
    expect(STT_MODELS.has("voxtral-mini-transcribe-realtime-2602")).toBe(false);
    expect(STT_MODELS.has("gpt-4o-transcribe-diarize")).toBe(false);
  });
});
