/**
 * Tests for the podcast synth stage. `turnsForSynthesis` is pure. `synthesizeTurns`
 * stubs globalThis.fetch for the Replicate create+delivery calls (same pattern
 * as replicate-tts.test.ts) and lets the real ffmpeg decode a tiny silent MP3
 * fixture, exercising the actual audio path.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PodcastHost, ScriptSegment } from "./podcast-script";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";
process.env["TTS_CONCURRENCY"] ??= "4";

const { turnsForSynthesis, synthesizeTurns, numberDensity } = await import("./podcast-synth");

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
const PREDICTIONS_PATH = "https://iu.example.com/replicate/v1/models/elevenlabs/v3/predictions";

const HOSTS: [PodcastHost, PodcastHost] = [
  { id: "A", name: "Lena", voice: "Rachel" },
  { id: "B", name: "Marco", voice: "Roger" },
];

describe("turnsForSynthesis", () => {
  test("maps each turn to its host's voice, in flattened segment order", () => {
    const segments: ScriptSegment[] = [
      { title: "S1", turns: [{ speaker: "A", text: "Hallo." }, { speaker: "B", text: "Hi." }] },
      { title: "S2", turns: [{ speaker: "A", text: "Weiter geht's." }] },
    ];
    const turns = turnsForSynthesis(segments, HOSTS, "de");
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.text)).toEqual(["Hallo.", "Hi.", "Weiter geht's."]);
    expect(turns.map((t) => t.voice)).toEqual(["Rachel", "Roger", "Rachel"]);
    expect(turns.every((t) => t.languageCode === "de")).toBe(true);
  });

  test("previous/next text comes from the SAME speaker's neighbouring turn, not the other host's", () => {
    const segments: ScriptSegment[] = [
      { title: "S1", turns: [
        { speaker: "A", text: "A1" },
        { speaker: "B", text: "B1" },
        { speaker: "A", text: "A2" },
        { speaker: "B", text: "B2" },
      ] },
    ];
    const turns = turnsForSynthesis(segments, HOSTS, "en");
    // A2 (index 2): previous same-speaker turn is A1, next is undefined (no later A turn)
    expect(turns[2]?.previousText).toBe("A1");
    expect(turns[2]?.nextText).toBeUndefined();
    // B1 (index 1): previous is undefined, next same-speaker turn is B2
    expect(turns[1]?.previousText).toBeUndefined();
    expect(turns[1]?.nextText).toBe("B2");
  });

  test("caps previous/next context at 600 chars", () => {
    const longText = "x".repeat(1000);
    const segments: ScriptSegment[] = [
      { title: "S1", turns: [{ speaker: "A", text: longText }, { speaker: "B", text: "filler" }, { speaker: "A", text: "short" }] },
    ];
    const turns = turnsForSynthesis(segments, HOSTS, "en");
    expect(turns[2]?.previousText?.length).toBe(600);
  });
});

/** The cold open of episode 5 — the exact turn the pacing rule exists for. */
const DENSE_TURN =
  "Zwölf Euro fünfzig. Das ist die Differenz, und deshalb reden wir heute über eintausenddreihundertdreiundsiebzig Euro fünfundsiebzig … hundertfünfzigtausend Euro mal drei Komma neun neun Prozent.";

describe("numberDensity", () => {
  test("the Obermenzing cold open is dense", () => {
    expect(numberDensity(DENSE_TURN)).toBeGreaterThan(0.12);
  });

  test("a normal spoken sentence is not dense", () => {
    expect(numberDensity("Und dann stehst du da an der Mautstelle und fragst dich, ob das alles so klug war.")).toBeLessThanOrEqual(0.12);
  });

  test("the articles ein/eine/einer do not count as numbers", () => {
    expect(numberDensity("Ein Auto, eine Frage, einer von vielen Wegen dorthin.")).toBe(0);
  });

  test("digits, German compounds and English numerals all count", () => {
    expect(numberDensity("330")).toBe(1);
    expect(numberDensity("eintausenddreihundertdreiundsiebzig")).toBe(1);
    expect(numberDensity("dreißig")).toBe(1);
    expect(numberDensity("twenty seven percent")).toBe(1);
    expect(numberDensity("")).toBe(0);
  });

  test("words merely containing a numeral stem as a substring do not count (no more substring matching)", () => {
    expect(numberDensity("einzig")).toBe(0);
    expect(numberDensity("regelmäßig")).toBe(0);
    expect(numberDensity("witzige")).toBe(0);
    expect(numberDensity("jetzig")).toBe(0);
  });

  test("bare 'ein' and 'und' do not count on their own", () => {
    expect(numberDensity("ein")).toBe(0);
    expect(numberDensity("und")).toBe(0);
  });

  test("English 'one' and 'point' were dropped from the word set", () => {
    expect(numberDensity("one of the things I want to point out")).toBe(0);
  });

  test("German compound numerals built from 'ein'/'und' plus other stems still count", () => {
    expect(numberDensity("einundzwanzig")).toBe(1);
    expect(numberDensity("dreizehn")).toBe(1);
    expect(numberDensity("siebzehn")).toBe(1);
    expect(numberDensity("fünfzig")).toBe(1);
  });
});

describe("dense-turn pacing", () => {
  const dense: ScriptSegment[] = [{ title: "S1", turns: [{ speaker: "A", text: DENSE_TURN }, { speaker: "B", text: "Das musst du mir noch einmal erklären, bitte." }] }];

  test("a dense turn is slowed by the configured delta; a normal one keeps the host's speed", () => {
    const hosts: [PodcastHost, PodcastHost] = [
      { id: "A", name: "Lena", voice: "Rachel", speed: 1.0 },
      { id: "B", name: "Marco", voice: "Roger", speed: 1.05 },
    ];
    const turns = turnsForSynthesis(dense, hosts, "de", { denseThreshold: 0.12, denseSlowdown: 0.06 });
    expect(turns[0]?.speed).toBeCloseTo(0.94, 5);
    expect(turns[1]?.speed).toBe(1.05);
  });

  test("a host with no speed of its own is slowed from 1.0", () => {
    const turns = turnsForSynthesis(dense, HOSTS, "de", { denseThreshold: 0.12, denseSlowdown: 0.06 });
    expect(turns[0]?.speed).toBeCloseTo(0.94, 5);
    // The non-dense turn stays unset, so ElevenLabs keeps the model's own pace.
    expect(turns[1]?.speed).toBeUndefined();
  });

  test("the slowed speed is clamped to the 0.7 floor", () => {
    const slowHosts: [PodcastHost, PodcastHost] = [
      { id: "A", name: "Lena", voice: "Rachel", speed: 0.72 },
      { id: "B", name: "Marco", voice: "Roger" },
    ];
    const turns = turnsForSynthesis(dense, slowHosts, "de", { denseThreshold: 0.12, denseSlowdown: 0.5 });
    expect(turns[0]?.speed).toBe(0.7);
  });

  test("defaults to the config defaults (0.12 / 0.06) when no pacing is passed", () => {
    const turns = turnsForSynthesis(dense, HOSTS, "de");
    expect(turns[0]?.speed).toBeCloseTo(0.94, 5);
    expect(turns[1]?.speed).toBeUndefined();
  });
});

describe("synthesizeTurns", () => {
  test("synthesizes each turn via one Replicate prediction, decoded to PCM at 24kHz", async () => {
    let predictionCalls = 0;
    setFetch(async (url) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) {
        predictionCalls++;
        return jsonRes({ id: `p${predictionCalls}`, status: "succeeded", output: DELIVERY_URL, metrics: { predict_time: 1 } });
      }
      if (u === DELIVERY_URL) return new Response(MOCK_MP3, { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const turns = turnsForSynthesis(
      [{ title: "S1", turns: [{ speaker: "A", text: "Hallo Welt." }, { speaker: "B", text: "Und hallo zurück." }] }],
      HOSTS,
      "de",
    );

    const progress: Array<[number, number]> = [];
    const results = await synthesizeTurns(turns, {
      model: "elevenlabs/v3",
      concurrency: 2,
      stability: 0.5,
      similarityBoost: 0.5,
      style: 0,
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(results).toHaveLength(2);
    expect(predictionCalls).toBe(2);
    for (const r of results) {
      expect(r.sampleRate).toBe(24000);
      expect(r.pcm.byteLength).toBeGreaterThan(0);
      expect(r.audioSeconds).toBeGreaterThan(0);
    }
    expect(results[0]?.inputChars).toBe("Hallo Welt.".length);
    expect(progress).toHaveLength(2);
    expect(progress[progress.length - 1]).toEqual([2, 2]);
  });

  test("propagates ReplicateSynthError on a failed prediction", async () => {
    const { ReplicateSynthError } = await import("./replicate-tts");
    setFetch(async (url) => {
      const u = String(url);
      if (u === PREDICTIONS_PATH) return jsonRes({ id: "pf", status: "failed", error: "voice not available" });
      throw new Error(`unexpected fetch: ${u}`);
    });

    const turns = turnsForSynthesis([{ title: "S1", turns: [{ speaker: "A", text: "Hallo." }] }], HOSTS, "de");

    await expect(
      synthesizeTurns(turns, { model: "elevenlabs/v3", concurrency: 1, stability: 0.5, similarityBoost: 0.5, style: 0 }),
    ).rejects.toBeInstanceOf(ReplicateSynthError);
  });
});
