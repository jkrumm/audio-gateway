import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";

const { deriveAnthropicBaseUrl } = await import("./config");

/** Run a script in a fresh bun process with its own env — config.ts is a process-wide singleton here. */
async function runIsolated(script: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  const base = { ...process.env } as Record<string, string | undefined>;
  delete base["IU_ANTHROPIC_BASE_URL"];
  delete base["PODCAST_VOICE_PATH"];
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: { ...base, IU_API_KEY: "test-key", USAGE_DB: ":memory:", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

const URL_SCRIPT = `
  const { iuAnthropicUrl } = await import("./iu");
  console.log("imported");
  try { console.log("url=" + iuAnthropicUrl("/v1/messages")); } catch (e) { console.log("error=" + e.message); }
`;

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

  test("a trailing slash on the OpenAI base is normalised before the suffix check", () => {
    expect(deriveAnthropicBaseUrl(undefined, "https://iu.example.com/openai/v1/")).toBe("https://iu.example.com/anthropic");
  });
});


describe("lazy Anthropic base", () => {
  test("a non-derivable OpenAI base does not throw at import; the first Anthropic URL does, with the clear message", async () => {
    const { code, out } = await runIsolated(URL_SCRIPT, { IU_OPENAI_BASE_URL: "https://iu.example.com/v1" });
    expect(code).toBe(0);
    expect(out).toContain("imported");
    expect(out).toMatch(/error=Cannot derive IU_ANTHROPIC_BASE_URL.*must end in \/openai\/v1/);
  });

  test("an explicit override works with an invalid OpenAI base", async () => {
    const { out } = await runIsolated(URL_SCRIPT, {
      IU_OPENAI_BASE_URL: "https://iu.example.com/v1",
      IU_ANTHROPIC_BASE_URL: "https://other.example.com/claude/",
    });
    expect(out).toContain("url=https://other.example.com/claude/v1/messages");
  });

  test("the first claude-* Messages call rejects with the clear error instead of crashing the process", async () => {
    const script = `
      const { callAnthropicMessages } = await import("./anthropic-messages");
      try {
        await callAnthropicMessages({ model: "claude-opus-5-5", system: "s", user: "u", maxTokens: 1 });
        console.log("no error");
      } catch (e) { console.log("error=" + e.message); }
    `;
    const { code, out } = await runIsolated(script, { IU_OPENAI_BASE_URL: "https://iu.example.com/v1" });
    expect(code).toBe(0);
    expect(out).toMatch(/error=Cannot derive IU_ANTHROPIC_BASE_URL/);
  });
});

describe("podcastVoicePath", () => {
  const SCRIPT = `console.log((await import("./config")).config.podcastVoicePath)`;
  const env = { IU_OPENAI_BASE_URL: "https://iu.example.com/openai/v1" };

  test("expands a leading ~/ to the home directory", async () => {
    const { out } = await runIsolated(SCRIPT, { ...env, PODCAST_VOICE_PATH: "~/x/voice.md" });
    expect(out.trim()).toBe(`${homedir()}/x/voice.md`);
  });

  test("leaves a non-tilde path unchanged", async () => {
    const { out } = await runIsolated(SCRIPT, { ...env, PODCAST_VOICE_PATH: "/opt/voice.md" });
    expect(out.trim()).toBe("/opt/voice.md");
  });
});
