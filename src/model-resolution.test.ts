/**
 * Unit tests for central STT/TTS model resolution.
 *
 * config.ts reads env at import time, so env is set before the dynamic import.
 * With no STT_MODEL/TTS_MODEL override the config defaults apply
 * (gpt-4o-transcribe / gemini-3.1-flash-tts-preview).
 */
import { describe, expect, test } from "bun:test";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["TTS_PREP"] ??= "off";

const { resolveSttModel, resolveTtsRoute, STT_MODELS } = await import("./model-resolution");

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

describe("resolveTtsRoute", () => {
  test("empty model defaults to the Gemini pipeline (config.ttsModel is a Gemini id)", () => {
    const r = resolveTtsRoute("");
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("gemini-3.1-flash-tts-preview");
  });

  test("a Gemini TTS model routes to the gemini provider as-is", () => {
    const r = resolveTtsRoute("gemini-2.0-flash-tts");
    expect(r).toEqual({ provider: "gemini", model: "gemini-2.0-flash-tts" });
  });

  test("an owner/name id routes to the replicate provider as-is", () => {
    expect(resolveTtsRoute("elevenlabs/flash-v2.5")).toEqual({ provider: "replicate", model: "elevenlabs/flash-v2.5" });
    expect(resolveTtsRoute("elevenlabs/v3")).toEqual({ provider: "replicate", model: "elevenlabs/v3" });
  });

  test("an unrecognized non-empty model falls back to the default's own provider", () => {
    // Mirrors the old resolveTtsModel behaviour: a non-TTS Gemini chat model
    // (no slash, no 'tts' in the name) is remapped to config.ttsModel, which is
    // itself a Gemini TTS id — so the fallback provider is gemini, not passthrough.
    const r = resolveTtsRoute("gemini-3.1-flash");
    expect(r.provider).toBe("gemini");
    expect(r.model).toBe("gemini-3.1-flash-tts-preview");
  });
});
