import { describe, expect, test } from "bun:test";

// config.ts is a genuine process-wide singleton — bun test shares one module
// registry, and config.ts reads env exactly once, on whichever test file's
// import chain resolves it first. Every config-touching test file sets this
// SAME baseline so the outcome is identical no matter which file wins.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";

const { extractTextAndUsage, stripPromptEcho } = await import("./stt-dispatch");

const PROMPT = "Die Aufnahme ist auf Deutsch oder Englisch.";

describe("stripPromptEcho", () => {
  test("no-op when the prompt is empty", () => {
    expect(stripPromptEcho("Hallo Welt.", "")).toBe("Hallo Welt.");
  });

  test("no-op when the text does not contain the prompt", () => {
    expect(stripPromptEcho("Hallo Welt.", PROMPT)).toBe("Hallo Welt.");
  });

  test("removes a standalone echoed sentence at the start", () => {
    const text = `${PROMPT} Das war die eigentliche Aufnahme.`;
    expect(stripPromptEcho(text, PROMPT)).toBe("Das war die eigentliche Aufnahme.");
  });

  test("removes a standalone echoed sentence in the middle", () => {
    const text = `Erster Satz. ${PROMPT} Letzter Satz.`;
    expect(stripPromptEcho(text, PROMPT)).toBe("Erster Satz. Letzter Satz.");
  });

  test("removes a standalone echoed sentence at the end", () => {
    const text = `Erster Satz. ${PROMPT}`;
    expect(stripPromptEcho(text, PROMPT)).toBe("Erster Satz.");
  });

  test("removes multiple occurrences", () => {
    const text = `${PROMPT} Mitte. ${PROMPT} Ende.`;
    expect(stripPromptEcho(text, PROMPT)).toBe("Mitte. Ende.");
  });

  test("tolerates a trailing punctuation mismatch (echoed without the period)", () => {
    const core = PROMPT.replace(/\.$/, "");
    const text = `${core} Weiter geht's.`;
    expect(stripPromptEcho(text, PROMPT)).toBe("Weiter geht's.");
  });

  test("leaves the prompt's words untouched when embedded inside a larger sentence", () => {
    const text = `Er sagte, ${PROMPT} und legte auf.`;
    expect(stripPromptEcho(text, PROMPT)).toBe(text);
  });

  test("collapses whitespace left behind, no double spaces or leading/trailing space", () => {
    const text = `  ${PROMPT}   Danach kam noch etwas.  `;
    const result = stripPromptEcho(text, PROMPT);
    expect(result).not.toMatch(/ {2,}/);
    expect(result).toBe(result.trim());
    expect(result).toBe("Danach kam noch etwas.");
  });
});

describe("extractTextAndUsage", () => {
  test("parses a JSON body", () => {
    const out = extractTextAndUsage(JSON.stringify({ text: "hi", usage: { seconds: 1 }, language: "de" }), "application/json");
    expect(out.text).toBe("hi");
    expect(out.language).toBe("de");
  });

  test("passes a non-JSON body through as raw text", () => {
    const out = extractTextAndUsage("1\n00:00:00,000 --> 00:00:01,000\nhi\n", "text/plain");
    expect(out.text).toBe("1\n00:00:00,000 --> 00:00:01,000\nhi\n");
    expect(out.usage).toBeNull();
    expect(out.language).toBeNull();
  });
});
