/**
 * Integration tests for the Replicate/ElevenLabs TTS lane. Stubs
 * globalThis.fetch for the create/poll/delivery calls — no network, no creds.
 * Real ffmpeg decodes the (real, silent) MP3 fixture where a lane needs to
 * concatenate or transcode, so these assertions exercise the actual audio
 * path rather than a mocked byte count.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["TTS_PREP"] ??= "off";
process.env["TTS_CONCURRENCY"] ??= "4";

const { handleReplicateSpeech } = await import("./replicate-tts");
const { _sink: usageSink } = await import("./usage");

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

/** Generate a real, valid silent MP3 via ffmpeg — decodable by the real transcode path. */
function silentMp3(durationSec: number): Uint8Array {
  const proc = Bun.spawnSync(
    [
      "ffmpeg", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
      "-t", String(durationSec),
      "-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3", "pipe:1",
    ],
    { stdout: "pipe" },
  );
  if (!proc.success) throw new Error("ffmpeg fixture generation failed");
  return new Uint8Array(proc.stdout);
}

const MOCK_MP3 = silentMp3(0.3);
const DELIVERY_URL = "https://replicate.delivery/mock/chunk.mp3";
const PREDICTIONS_PATH = "https://iu.example.com/replicate/v1/models/elevenlabs/flash-v2.5/predictions";
const V3_PREDICTIONS_PATH = "https://iu.example.com/replicate/v1/models/elevenlabs/v3/predictions";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Record spy for recordUsage's underlying sink. */
function spyOnUsage(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const original = usageSink.record.bind(usageSink);
  (usageSink as { record: typeof usageSink.record }).record = (row) => {
    rows.push(row as unknown as Record<string, unknown>);
    return original(row);
  };
  return rows;
}

describe("handleReplicateSpeech — success paths", () => {
  test("single-chunk mp3 request: exactly one prediction call + one delivery fetch, no prep row", async () => {
    const calledUrls: string[] = [];
    setFetch(async (url) => {
      const u = String(url);
      calledUrls.push(u);
      if (u === PREDICTIONS_PATH) {
        return jsonRes({ id: "p1", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1.2 } });
      }
      if (u === DELIVERY_URL) {
        return new Response(MOCK_MP3, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Guten Morgen Johannes.",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.has("x-audio-title")).toBe(false); // no prep ran

    const predictionCalls = calledUrls.filter((u) => u === PREDICTIONS_PATH);
    const deliveryCalls = calledUrls.filter((u) => u === DELIVERY_URL);
    expect(predictionCalls).toHaveLength(1);
    expect(deliveryCalls).toHaveLength(1);
    expect(calledUrls.some((u) => u.includes("/chat/completions"))).toBe(false);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(MOCK_MP3.byteLength);
  });

  test("processing → poll → succeeded", async () => {
    let pollCount = 0;
    setFetch(async (url) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) {
        return jsonRes({ id: "p2", status: "processing" });
      }
      if (u === "https://iu.example.com/replicate/v1/predictions/p2") {
        pollCount++;
        if (pollCount < 2) return jsonRes({ id: "p2", status: "processing" });
        return jsonRes({ id: "p2", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 0.9 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Poll me.",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
    });

    expect(res.status).toBe(200);
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  test("prep runs for a listed model (v3) — chat/completions is called and x-audio-title is set", async () => {
    let sawPrepCall = false;
    setFetch(async (url) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        sawPrepCall = true;
        return jsonRes({
          choices: [{ message: { content: JSON.stringify({
            lang: "de", title: "Kurzer Titel",
            chunks: [{ style: "warm", text: "Ein Satz." }],
          }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }
      if (u === V3_PREDICTIONS_PATH) {
        return jsonRes({ id: "p3", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 2.1 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await handleReplicateSpeech({
      model: "elevenlabs/v3",
      input: "Ein Satz.",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
    });

    expect(res.status).toBe(200);
    expect(sawPrepCall).toBe(true);
    expect(res.headers.get("x-audio-title")).toBe(encodeURIComponent("Kurzer Titel"));
  });

  test("previous_text/next_text wiring for 2 chunks (long prep-off input, sentence-split)", async () => {
    const sentBodies: Array<{ prompt: string; previous_text?: string; next_text?: string }> = [];
    setFetch(async (url, init) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) {
        const parsed = JSON.parse(String(init?.body)) as { input: { prompt: string; previous_text?: string; next_text?: string } };
        sentBodies.push(parsed.input);
        return jsonRes({ id: `p-${sentBodies.length}`, status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    // Two clearly-separated sentences, long enough (>4000 chars) to force the
    // no-LLM sentence splitter into two chunks without any chat/completions call.
    const sentenceA = `Erster Satz ${"wort ".repeat(600)}Ende eins.`;
    const sentenceB = `Zweiter Satz ${"wort ".repeat(600)}Ende zwei.`;
    const input = `${sentenceA} ${sentenceB}`;
    expect(input.length).toBeGreaterThan(4000);

    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input,
      voice: "Roger",
      responseFormat: "wav",
      summarize: false,
    });

    expect(res.status).toBe(200);
    expect(sentBodies.length).toBeGreaterThanOrEqual(2);
    expect(sentBodies[0]?.next_text).toBeDefined();
    expect(sentBodies[0]?.previous_text).toBeUndefined();
    const last = sentBodies[sentBodies.length - 1];
    expect(last?.previous_text).toBeDefined();
    expect(last?.next_text).toBeUndefined();
  });

  test("response_format pcm sets audio/pcm content-type", async () => {
    setFetch(async (url) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) return jsonRes({ id: "p4", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1 } });
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Hallo",
      voice: "Roger",
      responseFormat: "pcm",
      summarize: false,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/pcm");
  });

  test("speed is clamped into 0.7–1.2 and forwarded to the prediction input", async () => {
    let sentSpeed: number | undefined;
    setFetch(async (url, init) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) {
        const body = JSON.parse(String(init?.body)) as { input: { speed?: number } };
        sentSpeed = body.input.speed;
        return jsonRes({ id: "p5", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Hallo",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
      speed: 1.9, // above the 1.2 ceiling
    });

    expect(res.status).toBe(200);
    expect(sentSpeed).toBe(1.2);
  });

  test("speed of exactly 1 is omitted from the prediction input", async () => {
    let sawSpeedKey = true;
    setFetch(async (url, init) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) {
        const body = JSON.parse(String(init?.body)) as { input: Record<string, unknown> };
        sawSpeedKey = "speed" in body.input;
        return jsonRes({ id: "p6", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Hallo",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
      speed: 1,
    });

    expect(sawSpeedKey).toBe(false);
  });

  test("records a usage row per chunk with the Replicate model id and inputChars", async () => {
    setFetch(async (url) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) return jsonRes({ id: "p7", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1.5 } });
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const rows = spyOnUsage();
    await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Hallo Welt",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
    });

    const speechRows = rows.filter((r) => r["endpoint"] === "speech");
    expect(speechRows).toHaveLength(1);
    expect(speechRows[0]?.["model"]).toBe("elevenlabs/flash-v2.5");
    expect(speechRows[0]?.["inputChars"]).toBe("Hallo Welt".length);
  });
});

describe("handleReplicateSpeech — spoken summary", () => {
  test("summarize on a prep-off model uses the SUMMARY prompt, one prediction, title header", async () => {
    let systemPrompt = "";
    setFetch(async (url, init) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
        systemPrompt = body.messages[0]?.content ?? "";
        return jsonRes({
          choices: [{ message: { content: JSON.stringify({
            lang: "de", title: "Todo erstellt",
            chunks: [{ style: "ruhig", text: "Todo Serverrechnung für morgen erstellt." }],
          }) } }],
          usage: { prompt_tokens: 80, completion_tokens: 20 },
        });
      }
      if (u === PREDICTIONS_PATH) {
        return jsonRes({ id: "ps", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 0.9 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Erledigt! Ich habe das Todo 'Serverrechnung bezahlen' für morgen angelegt. " + "Weitere Details. ".repeat(20),
      voice: "Mark",
      responseFormat: "pcm",
      summarize: true,
    });

    expect(res.status).toBe(200);
    expect(systemPrompt).toContain("what should be SPOKEN aloud");
    expect(res.headers.get("x-audio-title")).toBe(encodeURIComponent("Todo erstellt"));
    expect(res.headers.get("content-type")).toBe("audio/pcm");
  });
});

describe("handleSpeech — gateway-side auto-summarize for whole-file clients", () => {
  const LONG = "Erledigt! Ich habe das Todo Serverrechnung bezahlen für morgen angelegt. " + "Weitere Details, die man lesen kann. ".repeat(6);
  function stub(): { prompts: string[] } {
    const prompts: string[] = [];
    setFetch(async (url, init) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
        prompts.push(body.messages[0]?.content ?? "");
        return jsonRes({ choices: [{ message: { content: JSON.stringify({ lang: "de", title: "Todo", chunks: [{ style: "", text: "Todo angelegt." }] }) } }], usage: {} });
      }
      if (u === PREDICTIONS_PATH) return jsonRes({ id: "pa", status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 0.5 } });
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });
    return { prompts };
  }
  // Dynamic import: a static one would hoist above this file's env baseline and load config too early.
  const post = async (body: Record<string, unknown>) =>
    (await import("./speech")).handleSpeech(new Request("http://x/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  test("long mp3 request on flash is summarized without the client asking", async () => {
    const { prompts } = stub();
    const res = await post({ model: "elevenlabs/flash-v2.5", input: LONG, voice: "Mark" });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("what should be SPOKEN aloud");
  });
  test("the same text as pcm (a streaming sentence) is never summarized", async () => {
    const { prompts } = stub();
    const res = await post({ model: "elevenlabs/flash-v2.5", input: LONG, voice: "Mark", response_format: "pcm" });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(0);
  });
  test("short mp3 requests stay direct", async () => {
    const { prompts } = stub();
    const res = await post({ model: "elevenlabs/flash-v2.5", input: "Alles klar, erledigt.", voice: "Mark" });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(0);
  });
});

describe("handleReplicateSpeech — failure path", () => {
  test("a failed prediction status maps to 502, with an error usage row", async () => {
    setFetch(async (url) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) {
        return jsonRes({ id: "p8", status: "failed", error: "voice not available" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const rows = spyOnUsage();
    const res = await handleReplicateSpeech({
      model: "elevenlabs/flash-v2.5",
      input: "Hallo",
      voice: "Roger",
      responseFormat: "mp3",
      summarize: false,
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("voice not available");

    const errorRow = rows.find((r) => r["status"] === 502);
    expect(errorRow).toBeDefined();
  });
});
