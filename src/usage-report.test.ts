/**
 * Hermetic tests for usage-report.ts — no SQLite, no network, plain
 * UsageDbRow fixtures shaped like the usage_record columns.
 */
import { describe, expect, test } from "bun:test";
import { buildRequestLines, computeRollups, formatLine, formatRollup, parseSince, type UsageDbRow } from "./usage-report";

let nextId = 1;
const row = (overrides: Partial<UsageDbRow>): UsageDbRow => ({
  id: nextId++,
  ts: "2026-08-26T18:50:47.000Z",
  endpoint: "speech",
  model: "elevenlabs/flash-v2.5",
  status: 200,
  latency_ms: 100,
  response_format: "mp3",
  input_tokens: null,
  output_tokens: null,
  audio_tokens: null,
  audio_seconds: null,
  input_chars: null,
  bytes_out: null,
  usage_json: null,
  error_text: null,
  request_id: null,
  caller: null,
  text_json: null,
  ...overrides,
});

describe("parseSince", () => {
  const now = new Date("2026-08-26T20:00:00.000Z");

  test("parses relative minutes/hours/days", () => {
    expect(parseSince("30m", now).toISOString()).toBe("2026-08-26T19:30:00.000Z");
    expect(parseSince("2h", now).toISOString()).toBe("2026-08-26T18:00:00.000Z");
    expect(parseSince("1d", now).toISOString()).toBe("2026-08-25T20:00:00.000Z");
  });

  test("parses an ISO date string", () => {
    expect(parseSince("2026-08-01T00:00:00.000Z", now).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  test("throws on an unparseable value", () => {
    expect(() => parseSince("not-a-date", now)).toThrow();
  });
});

describe("buildRequestLines", () => {
  test("joins a speech-request row with its prep + chunk siblings by request_id", () => {
    const rows: UsageDbRow[] = [
      row({
        request_id: "req-1",
        endpoint: "speech-prep",
        model: "gpt-5.6-luna",
        latency_ms: 2100,
      }),
      row({ request_id: "req-1", endpoint: "speech", latency_ms: 1100 }),
      row({
        request_id: "req-1",
        endpoint: "speech-request",
        model: "elevenlabs/flash-v2.5",
        latency_ms: 4300,
        input_chars: 850,
        audio_seconds: 12.4,
        usage_json: JSON.stringify({ mode: "summary", lane: "replicate", chunks: 1, language_code: "de", voice: "Mark", title: "Todo angelegt" }),
        text_json: JSON.stringify({ input: "Bitte ein Todo für morgen anlegen.", output: "Todo für morgen angelegt." }),
      }),
    ];

    const [line] = buildRequestLines(rows);
    expect(line).toBeDefined();
    expect(line?.endpoint).toBe("speech-request");
    expect(line?.mode).toBe("summary");
    expect(line?.lane).toBe("replicate");
    expect(line?.chunks).toBe(1);
    expect(line?.languageCode).toBe("de");
    expect(line?.voice).toBe("Mark");
    expect(line?.prepMs).toBe(2100);
    expect(line?.synthMs).toBe(1100);
    expect(line?.outputSnippet).toBe("Todo für morgen angelegt.");
  });

  test("approximates synth stage as the MAX chunk latency (concurrent synth)", () => {
    const rows: UsageDbRow[] = [
      row({ request_id: "req-2", endpoint: "speech", latency_ms: 900 }),
      row({ request_id: "req-2", endpoint: "speech", latency_ms: 1600 }),
      row({ request_id: "req-2", endpoint: "speech", latency_ms: 1200 }),
      row({ request_id: "req-2", endpoint: "speech-request", latency_ms: 2000 }),
    ];

    const [line] = buildRequestLines(rows);
    expect(line?.synthMs).toBe(1600);
    expect(line?.chunks).toBe(3);
  });

  test("sums stt attempt latency for a transcription-request row", () => {
    const rows: UsageDbRow[] = [
      row({ request_id: "req-3", endpoint: "transcriptions", model: "gpt-4o-transcribe", latency_ms: 300, status: 404 }),
      row({ request_id: "req-3", endpoint: "transcriptions", model: "whisper", latency_ms: 1000 }),
      row({
        request_id: "req-3",
        endpoint: "transcription-request",
        model: "whisper",
        latency_ms: 1300,
        audio_seconds: 6.6,
        text_json: JSON.stringify({ output: "Hallo, ist das Mikro an?" }),
      }),
    ];

    const [line] = buildRequestLines(rows);
    expect(line?.sttMs).toBe(1300);
    expect(line?.audioSeconds).toBe(6.6);
    expect(line?.outputSnippet).toBe("Hallo, ist das Mikro an?");
  });

  test("a request-summary row without a request_id still produces a line, with no joined stages", () => {
    const rows: UsageDbRow[] = [row({ endpoint: "speech-request", request_id: null })];
    const [line] = buildRequestLines(rows);
    expect(line?.requestId).toBeNull();
    expect(line?.prepMs).toBeNull();
    expect(line?.synthMs).toBeNull();
  });

  test("a non-request-summary row alone produces no line", () => {
    const rows: UsageDbRow[] = [row({ request_id: "req-4", endpoint: "speech" })];
    expect(buildRequestLines(rows)).toHaveLength(0);
  });

  test("status >= 400 flags the line as an error", () => {
    const rows: UsageDbRow[] = [row({ request_id: "req-5", endpoint: "speech-request", status: 502 })];
    const [line] = buildRequestLines(rows);
    expect(line?.error).toBe(true);
  });
});

describe("computeRollups", () => {
  test("groups by lane/mode, computes p50/p95/errors/avg audio/language split", () => {
    const rows: UsageDbRow[] = [
      row({
        request_id: "a",
        endpoint: "speech-request",
        latency_ms: 1000,
        audio_seconds: 4,
        usage_json: JSON.stringify({ lane: "replicate", mode: "direct", language_code: "de" }),
      }),
      row({
        request_id: "b",
        endpoint: "speech-request",
        latency_ms: 2000,
        audio_seconds: 6,
        usage_json: JSON.stringify({ lane: "replicate", mode: "direct", language_code: "de" }),
      }),
      row({
        request_id: "c",
        endpoint: "speech-request",
        status: 500,
        latency_ms: 3000,
        usage_json: JSON.stringify({ lane: "replicate", mode: "direct", language_code: "en" }),
      }),
    ];

    const [rollup] = computeRollups(buildRequestLines(rows));
    expect(rollup?.key).toBe("replicate/direct");
    expect(rollup?.count).toBe(3);
    expect(rollup?.errorCount).toBe(1);
    expect(rollup?.avgAudioSeconds).toBe(5);
    expect(rollup?.languageSplit).toEqual({ de: 2, en: 1 });
  });

  test("transcription-request rows roll up under the 'transcription' key", () => {
    const rows: UsageDbRow[] = [row({ request_id: "t1", endpoint: "transcription-request" })];
    const [rollup] = computeRollups(buildRequestLines(rows));
    expect(rollup?.key).toBe("transcription");
  });
});

describe("formatLine / formatRollup", () => {
  test("formats a speech-request line without throwing and includes the model + snippet", () => {
    const rows: UsageDbRow[] = [
      row({
        request_id: "fmt-1",
        endpoint: "speech-request",
        model: "elevenlabs/flash-v2.5",
        input_chars: 850,
        usage_json: JSON.stringify({ mode: "summary", lane: "replicate", chunks: 1, language_code: "de", voice: "Mark" }),
        text_json: JSON.stringify({ output: "Todo Serverrechnung für morgen angelegt" }),
      }),
    ];
    const [line] = buildRequestLines(rows);
    const formatted = formatLine(line!);
    expect(formatted).toContain("elevenlabs/flash-v2.5");
    expect(formatted).toContain("Todo Serverrechnung");
  });

  test("formats a transcription-request line", () => {
    const rows: UsageDbRow[] = [
      row({
        request_id: "fmt-2",
        endpoint: "transcription-request",
        model: "whisper",
        audio_seconds: 6.6,
        text_json: JSON.stringify({ output: "Hallo, ist das Mikro an?" }),
      }),
    ];
    const [line] = buildRequestLines(rows);
    const formatted = formatLine(line!);
    expect(formatted).toContain("transcription");
    expect(formatted).toContain("6.6s audio");
  });

  test("formatRollup produces a readable summary line", () => {
    const rows: UsageDbRow[] = [
      row({ request_id: "r1", endpoint: "speech-request", usage_json: JSON.stringify({ lane: "gemini", mode: "prep" }) }),
    ];
    const [rollup] = computeRollups(buildRequestLines(rows));
    const formatted = formatRollup(rollup!);
    expect(formatted).toContain("gemini/prep");
    expect(formatted).toContain("n=1");
  });
});
