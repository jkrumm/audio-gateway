import { describe, expect, test } from "bun:test";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";

const { deriveAnthropicBaseUrl } = await import("./config");

describe("deriveAnthropicBaseUrl", () => {
  test("swaps a trailing /openai/v1 for /anthropic", () => {
    expect(deriveAnthropicBaseUrl(undefined, "https://iu.example.com/openai/v1")).toBe("https://iu.example.com/anthropic");
  });

  test("an explicit override wins and is trailing-slash trimmed, whatever the OpenAI base looks like", () => {
    expect(deriveAnthropicBaseUrl("https://other.example.com/claude/", "https://iu.example.com/custom")).toBe("https://other.example.com/claude");
  });

  test("fails loudly when unset and the OpenAI base does not end in /openai/v1", () => {
    expect(() => deriveAnthropicBaseUrl(undefined, "https://iu.example.com/v1")).toThrow(
      /Cannot derive IU_ANTHROPIC_BASE_URL.*must end in \/openai\/v1.*https:\/\/iu\.example\.com\/v1/,
    );
  });
});
