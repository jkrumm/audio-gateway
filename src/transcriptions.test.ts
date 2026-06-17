import { describe, expect, test } from "bun:test";
import { srt, srtTime, verboseJson, vtt } from "./transcriptions";

describe("srtTime", () => {
  test("formats zero as 00:00:00,000", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
  });

  test("zero-pads hours, minutes, seconds, and milliseconds", () => {
    // 1 h + 2 min + 3 sec + 456 ms = 3723.456 s
    expect(srtTime(3723.456)).toBe("01:02:03,456");
  });

  test("handles sub-second values", () => {
    expect(srtTime(0.5)).toBe("00:00:00,500");
  });

  test("rounds ms correctly", () => {
    // 1.0005 s → rounds to 1001 ms
    expect(srtTime(1.0005)).toBe("00:00:01,001");
  });

  test("clamps negative input to 0", () => {
    expect(srtTime(-1)).toBe("00:00:00,000");
  });
});

describe("srt", () => {
  test("produces correct SRT block shape", () => {
    const result = srt("Hello world", 5.0);
    expect(result).toBe("1\n00:00:00,000 --> 00:00:05,000\nHello world\n");
  });

  test("starts at 00:00:00,000", () => {
    const result = srt("Test", 3.5);
    expect(result.startsWith("1\n00:00:00,000 -->")).toBe(true);
  });
});

describe("vtt", () => {
  test("starts with WEBVTT header", () => {
    const result = vtt("Hello", 2.0);
    expect(result.startsWith("WEBVTT\n\n")).toBe(true);
  });

  test("uses dot separator (not comma) for milliseconds", () => {
    const result = vtt("Hello", 1.5);
    expect(result).toContain("00:00:00.000 --> 00:00:01.500");
    expect(result).not.toContain(",");
  });

  test("includes the text", () => {
    const result = vtt("My transcript", 10.0);
    expect(result).toContain("My transcript");
  });
});

describe("verboseJson", () => {
  test("wraps text in a single segment spanning the clip", () => {
    const out = verboseJson("Hello world", 5.0, "en");
    expect(out.task).toBe("transcribe");
    expect(out.language).toBe("en");
    expect(out.duration).toBe(5.0);
    expect(out.text).toBe("Hello world");
    expect(out.segments).toHaveLength(1);
    const seg = out.segments[0]!;
    expect(seg.id).toBe(0);
    expect(seg.seek).toBe(0);
    expect(seg.start).toBe(0);
    expect(seg.end).toBe(5.0);
    expect(seg.text).toBe("Hello world");
    expect(seg.tokens).toEqual([]);
    expect(seg.temperature).toBe(0);
    expect(seg.avg_logprob).toBe(0);
    expect(seg.compression_ratio).toBe(1);
    expect(seg.no_speech_prob).toBe(0);
  });

  test("defaults null language to 'unknown'", () => {
    const out = verboseJson("Test", 1.0, null);
    expect(out.language).toBe("unknown");
  });
});
