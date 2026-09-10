import { afterEach, describe, expect, mock, test } from "bun:test";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
// A dynamic import (not a static one) is required here so these assignments
// run before "./transcriptions" (which imports config.ts transitively) does —
// a static `import` would be hoisted ahead of any top-level statement.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";

const { handleTranscriptions, srt, srtTime, verboseJson, vtt } = await import("./transcriptions");
const { config } = await import("./config");
const { _sink } = await import("./usage");

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

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

describe("handleTranscriptions", () => {
  test("an empty-body upstream 5xx yields a JSON error message instead of proxying the empty body", async () => {
    setFetch(async () => new Response("", { status: 500, headers: { "content-type": "text/plain" } }));

    const form = new FormData();
    form.append("file", new File([new Uint8Array(100)], "short.wav", { type: "audio/wav" }));
    form.append("model", "gpt-4o-transcribe");
    const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

    const res = await handleTranscriptions(req);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as { error: { message: string; type: string } };
    expect(json.error.type).toBe("upstream_error");
    expect(json.error.message).toContain("empty body");
  });

  const hasFfmpeg = Boolean(Bun.which("ffmpeg")) && Boolean(Bun.which("ffprobe"));

  /** Generate `durationSec` of 44.1kHz mono sine-wave audio as a WAV `File` via ffmpeg. */
  async function genWavFile(durationSec: number): Promise<File> {
    const proc = Bun.spawn(
      [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
        "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const bytes = await new Response(proc.stdout).arrayBuffer();
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`ffmpeg fixture generation failed (${exitCode})`);
    return new File([bytes], "input.wav", { type: "audio/wav" });
  }

  test.skipIf(!hasFfmpeg)(
    "a multi-part transcription joins per-part text and synthesizes verbose_json from it",
    async () => {
      const mutableConfig = config as unknown as { sttMaxUploadBytes: number };
      const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
      mutableConfig.sttMaxUploadBytes = 18_000; // forces the ~10s clip below into multiple parts
      try {
        const file = await genWavFile(10);

        let callCount = 0;
        setFetch(async (_url, init) => {
          const body = init?.body;
          expect(body).toBeInstanceOf(FormData);
          expect((body as FormData).get("response_format")).toBe("json");
          const text = `part${callCount}`;
          callCount++;
          return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
        });

        const form = new FormData();
        form.append("file", file);
        form.append("model", "gpt-4o-transcribe");
        form.append("response_format", "verbose_json");
        const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

        const res = await handleTranscriptions(req);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { text: string; task: string; duration: number };
        expect(callCount).toBeGreaterThan(1);
        expect(json.text).toBe(Array.from({ length: callCount }, (_, i) => `part${i}`).join(" "));
        expect(json.task).toBe("transcribe");
        expect(Math.abs(json.duration - 10)).toBeLessThan(2); // probed off the ORIGINAL file, not a chunk
      } finally {
        mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "a multi-part transcription surfaces a failing part's status and body to the client",
    async () => {
      const mutableConfig = config as unknown as { sttMaxUploadBytes: number };
      const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
      mutableConfig.sttMaxUploadBytes = 18_000; // same 10s clip, forced into 3 parts (see the join test above)
      try {
        const file = await genWavFile(10);

        setFetch(async (_url, init) => {
          const body = init?.body as FormData;
          const filePart = body.get("file") as File;
          if (filePart.name.includes("part2")) {
            return new Response(JSON.stringify({ error: "unsupported codec" }), {
              status: 415,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
        });

        const form = new FormData();
        form.append("file", file);
        form.append("model", "gpt-4o-transcribe");
        const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

        const res = await handleTranscriptions(req);
        // 415 is a client-error status, not isModelUnavailable — no fallback
        // retry is attempted, and the failing part's response surfaces as-is.
        expect(res.status).toBe(415);
        const text = await res.text();
        expect(text).toContain("unsupported codec");
      } finally {
        mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "B3: an isModelUnavailable status on one part retries ONLY that part on the fallback model",
    async () => {
      const mutableConfig = config as unknown as { sttMaxUploadBytes: number };
      const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
      mutableConfig.sttMaxUploadBytes = 18_000; // same 10s clip, forced into 3 parts (see the join test above)

      const originalRecord = _sink.record.bind(_sink);
      const recorded: Array<{ endpoint: string; model: string; status: number }> = [];
      (_sink as { record: typeof _sink.record }).record = (row) => {
        recorded.push({ endpoint: row.endpoint, model: row.model, status: row.status });
        return originalRecord(row);
      };

      try {
        const file = await genWavFile(10);

        const calls: Array<{ model: string; filename: string }> = [];
        setFetch(async (_url, init) => {
          const body = init?.body as FormData;
          const model = String(body.get("model"));
          const filePart = body.get("file") as File;
          calls.push({ model, filename: filePart.name });
          // part2 hits a transient backend outage on the requested model, and
          // must succeed once it's retried on the fallback model alone.
          if (filePart.name.includes("part2") && model !== "whisper") {
            return new Response("backend unavailable", { status: 503, headers: { "content-type": "text/plain" } });
          }
          return new Response(JSON.stringify({ text: `${model}:${filePart.name}` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });

        const form = new FormData();
        form.append("file", file);
        form.append("model", "gpt-4o-transcribe");
        const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

        const res = await handleTranscriptions(req);
        expect(res.status).toBe(200);

        const part2Calls = calls.filter((c) => c.filename.includes("part2"));
        expect(part2Calls).toHaveLength(2); // one failed attempt + one fallback retry — not a whole-set retry
        expect(part2Calls[0]!.model).toBe("gpt-4o-transcribe");
        expect(part2Calls[1]!.model).toBe("whisper");

        // every OTHER part is called exactly once — the outage on part2 never
        // re-sends or re-transcribes an already-succeeded chunk.
        const callsPerFilename = new Map<string, number>();
        for (const c of calls) callsPerFilename.set(c.filename, (callsPerFilename.get(c.filename) ?? 0) + 1);
        for (const [filename, count] of callsPerFilename) {
          expect(count).toBe(filename.includes("part2") ? 2 : 1);
        }

        // usage recorded exactly once per HTTP call actually made — never
        // doubled for a part that already succeeded.
        const perCallRows = recorded.filter((r) => r.endpoint === "transcriptions");
        expect(perCallRows.length).toBe(calls.length);
      } finally {
        mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
        (_sink as { record: typeof _sink.record }).record = originalRecord;
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "B2: a chunk still over the upload limit after slicing is rejected with 413 and never sent upstream",
    async () => {
      const mutableConfig = config as unknown as { sttMaxUploadBytes: number; sttMaxSttChunks: number };
      const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
      const originalMaxSttChunks = mutableConfig.sttMaxSttChunks;
      mutableConfig.sttMaxUploadBytes = 18_000; // same 10s clip, forced into 3 parts
      mutableConfig.sttMaxSttChunks = 12;

      const originalSpawn = Bun.spawn;
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], ...rest: unknown[]) => {
        // sliceAudio's ffmpeg call always carries "-ss" (audio.ts); force its
        // output to stay over the upload limit so prepareSttInput must throw
        // SttChunkTooLargeError instead of silently accepting an oversize part.
        if (cmd[0] === "ffmpeg" && cmd.includes("-ss")) {
          const oversize = new Uint8Array(mutableConfig.sttMaxUploadBytes + 1000);
          return {
            stdout: new Response(oversize).body,
            stderr: new Response("").body,
            exited: Promise.resolve(0),
          } as unknown as ReturnType<typeof Bun.spawn>;
        }
        return originalSpawn(cmd as never, ...(rest as []));
      }) as typeof Bun.spawn;

      let fetchCalled = false;
      setFetch(async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ text: "should never happen" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const file = await genWavFile(10);
        const form = new FormData();
        form.append("file", file);
        form.append("model", "gpt-4o-transcribe");
        const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

        const res = await handleTranscriptions(req);
        expect(res.status).toBe(413);
        const json = (await res.json()) as { error: { message: string; type: string } };
        expect(json.error.type).toBe("invalid_request_error");
        expect(json.error.message).toContain("over the");
        expect(fetchCalled).toBe(false); // the still-oversize chunk is never sent upstream
      } finally {
        (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
        mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
        mutableConfig.sttMaxSttChunks = originalMaxSttChunks;
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "a plain ffmpeg failure during prepareSttInput still sends the original upload unchanged",
    async () => {
      const mutableConfig = config as unknown as { sttMaxUploadBytes: number };
      const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
      mutableConfig.sttMaxUploadBytes = 1000; // force compression — the 1s clip below exceeds this

      // Generate the fixture BEFORE installing the spawn override below — the
      // override's predicate would otherwise also intercept genWavFile's own
      // ffmpeg invocation (which also carries neither "-ss" nor "-af").
      const file = await genWavFile(1);

      const originalSpawn = Bun.spawn;
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], ...rest: unknown[]) => {
        // compressForStt's ffmpeg call has neither "-ss" (sliceAudio) nor
        // "-af" (detectSilence) — force IT to fail so prepareSttInput throws a
        // plain Error, not one of the dedicated chunk-rejection errors.
        if (cmd[0] === "ffmpeg" && !cmd.includes("-ss") && !cmd.includes("-af")) {
          return {
            stdout: new Response("").body,
            stderr: new Response("simulated ffmpeg failure").body,
            exited: Promise.resolve(1),
          } as unknown as ReturnType<typeof Bun.spawn>;
        }
        return originalSpawn(cmd as never, ...(rest as []));
      }) as typeof Bun.spawn;

      let sentFile: File | null = null;
      setFetch(async (_url, init) => {
        const body = init?.body as FormData;
        sentFile = body.get("file") as File;
        return new Response(JSON.stringify({ text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
      });

      try {
        const form = new FormData();
        form.append("file", file);
        form.append("model", "gpt-4o-transcribe");
        const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

        const res = await handleTranscriptions(req);
        expect(res.status).toBe(200);
        expect(sentFile).not.toBeNull();
        expect(sentFile!.size).toBe(file.size); // the ORIGINAL upload, unchanged
        expect(sentFile!.name).toBe(file.name);
      } finally {
        (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
        mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "SttChunkLimitError surfaces as a 413 end-to-end through handleTranscriptions",
    async () => {
      const mutableConfig = config as unknown as { sttMaxUploadBytes: number; sttMaxSttChunks: number };
      const originalMaxUploadBytes = mutableConfig.sttMaxUploadBytes;
      const originalMaxSttChunks = mutableConfig.sttMaxSttChunks;
      mutableConfig.sttMaxUploadBytes = 18_000;
      mutableConfig.sttMaxSttChunks = 2; // the same 10s clip needs 3 chunks (see the join test above) — over the cap

      let fetchCalled = false;
      setFetch(async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ text: "should never happen" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

      try {
        const file = await genWavFile(10);
        const form = new FormData();
        form.append("file", file);
        form.append("model", "gpt-4o-transcribe");
        const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

        const res = await handleTranscriptions(req);
        expect(res.status).toBe(413);
        expect(res.headers.get("content-type")).toContain("application/json");
        const json = (await res.json()) as { error: { message: string; type: string } };
        expect(json.error.type).toBe("invalid_request_error");
        expect(json.error.message).toMatch(/2/);
        expect(fetchCalled).toBe(false);
      } finally {
        mutableConfig.sttMaxUploadBytes = originalMaxUploadBytes;
        mutableConfig.sttMaxSttChunks = originalMaxSttChunks;
      }
    },
  );

  test("strips a verbatim echoed prompt from a json response", async () => {
    const mutableConfig = config as unknown as { sttPrompt: string };
    const original = mutableConfig.sttPrompt;
    mutableConfig.sttPrompt = "Die Aufnahme ist auf Deutsch oder Englisch.";
    try {
      setFetch(async () =>
        new Response(JSON.stringify({ text: "Die Aufnahme ist auf Deutsch oder Englisch. Hallo Welt." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const form = new FormData();
      form.append("file", new File([new Uint8Array(100)], "short.wav", { type: "audio/wav" }));
      form.append("model", "gpt-4o-transcribe");
      const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

      const res = await handleTranscriptions(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { text: string };
      expect(json.text).toBe("Hallo Welt.");
    } finally {
      mutableConfig.sttPrompt = original;
    }
  });

  test("leaves the whisper raw-passthrough path unaffected by prompt stripping", async () => {
    const mutableConfig = config as unknown as { sttPrompt: string };
    const original = mutableConfig.sttPrompt;
    mutableConfig.sttPrompt = "Die Aufnahme ist auf Deutsch oder Englisch.";
    try {
      const srtBody = "1\n00:00:00,000 --> 00:00:01,000\nDie Aufnahme ist auf Deutsch oder Englisch.\n";
      setFetch(async () => new Response(srtBody, { status: 200, headers: { "content-type": "text/plain" } }));

      const form = new FormData();
      form.append("file", new File([new Uint8Array(100)], "short.wav", { type: "audio/wav" }));
      form.append("model", "whisper");
      form.append("response_format", "srt");
      const req = new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });

      const res = await handleTranscriptions(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe(srtBody); // raw whisper passthrough — never run through stripPromptEcho
    } finally {
      mutableConfig.sttPrompt = original;
    }
  });
});
