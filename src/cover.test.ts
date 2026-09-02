/**
 * Unit tests for the image-gen cover client. Stubs globalThis.fetch — no
 * network, no creds. See replicate-tts.test.ts for the same fetch-stub
 * pattern. `config.imageGenUrl`/`imageGenApiKey` are set by directly mutating
 * the config singleton (its `as const` is a compile-time assertion only, not
 * a runtime freeze) rather than via env vars — env vars race with whichever
 * OTHER config-touching test file's import wins the process-wide module
 * registry first (see audio.test.ts's note on the singleton), which would
 * make "configured" tests order-dependent across a full `bun test` run.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching test file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";

const { coverConfigured, CoverError, generateCover } = await import("./cover");
const { config } = await import("./config");
const { _sink: usageSink } = await import("./usage");

type MutableConfig = { imageGenUrl: string; imageGenApiKey: string };
const mutableConfig = config as unknown as MutableConfig;

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

beforeEach(() => {
  mutableConfig.imageGenUrl = "https://image-gen.example.com";
  mutableConfig.imageGenApiKey = "test-image-gen-key";
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

function spyOnUsage(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const original = usageSink.record.bind(usageSink);
  (usageSink as { record: typeof usageSink.record }).record = (row) => {
    rows.push(row as unknown as Record<string, unknown>);
    return original(row);
  };
  return rows;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("coverConfigured", () => {
  test("true when both url and key are set", () => {
    expect(coverConfigured()).toBe(true);
  });

  test("false when either is missing", () => {
    mutableConfig.imageGenUrl = "";
    expect(coverConfigured()).toBe(false);
    mutableConfig.imageGenUrl = "https://image-gen.example.com";
    mutableConfig.imageGenApiKey = "";
    expect(coverConfigured()).toBe(false);
  });
});

describe("generateCover — success", () => {
  test("posts to /generate and decodes the returned base64 PNG", async () => {
    let sawAuth = "";
    let sawBody: Record<string, unknown> = {};
    setFetch(async (url, init) => {
      expect(String(url)).toBe("https://image-gen.example.com/generate");
      sawAuth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      sawBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "gen_1",
          model: "some-image-model",
          images: [{ b64_json: TINY_PNG_BASE64, format: "png" }],
          usage: { tokens: 100 },
          cost: { usd: 0.02, source: "computed" },
          latency_ms: 4200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const rows = spyOnUsage();
    const result = await generateCover("A calm podcast cover, minimalist, warm colors");

    expect(sawAuth).toBe("Bearer test-image-gen-key");
    expect(sawBody["prompt"]).toBe("A calm podcast cover, minimalist, warm colors");
    expect(sawBody["size"]).toBe("1024x1024");
    expect(sawBody["quality"]).toBe("medium");
    expect(sawBody["output_format"]).toBe("png");
    expect(sawBody["n"]).toBe(1);
    expect(sawBody["moderation"]).toBe("auto");

    expect(result.model).toBe("some-image-model");
    expect(result.costUsd).toBe(0.02);
    expect(result.png.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(result.png).toString("base64")).toBe(TINY_PNG_BASE64);

    const coverRows = rows.filter((r) => r["endpoint"] === "podcast-cover");
    expect(coverRows).toHaveLength(1);
    expect(coverRows[0]?.["status"]).toBe(200);
  });
});

describe("generateCover — failure", () => {
  test("non-2xx response throws CoverError and records an error usage row", async () => {
    setFetch(async () =>
      new Response(JSON.stringify({ error: { message: "content flagged", type: "moderation_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const rows = spyOnUsage();
    await expect(generateCover("bad prompt")).rejects.toThrow(CoverError);

    const errorRow = rows.find((r) => r["endpoint"] === "podcast-cover" && r["status"] === 400);
    expect(errorRow).toBeDefined();
  });

  test("unconfigured gateway throws CoverError without calling fetch", async () => {
    mutableConfig.imageGenUrl = "";
    mutableConfig.imageGenApiKey = "";

    let fetchCalled = false;
    setFetch(async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    });

    await expect(generateCover("anything")).rejects.toThrow(CoverError);
    expect(fetchCalled).toBe(false);
  });
});
