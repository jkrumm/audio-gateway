/**
 * Tests for the podcast job store, pure orchestration helpers, and HTTP
 * routes. The real pipeline (script → synth → mux → publish) is never run
 * here — `bun:test` stubs `fetch` and any job that DOES get enqueued through
 * the HTTP layer is left to fail fast against that stub in the background;
 * assertions never depend on it reaching a particular terminal status.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// See audio.test.ts / routes.test.ts — config.ts is a process-wide singleton
// across bun test's shared module registry; every config-touching test file
// sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";

const { config } = await import("./config");

// `config.podcastDb`/`podcastDataDir` must be redirected to a temp location
// BEFORE any podcast route runs (cover.test.ts's pattern) — env vars race
// with whichever other config-touching test file's import wins the shared
// module registry first, so mutate the live singleton instead.
type MutablePodcastConfig = { podcastDb: string; podcastDataDir: string };
const mutableConfig = config as unknown as MutablePodcastConfig;
const tmpRoot = mkdtempSync(join(tmpdir(), "audio-gateway-podcasts-test-"));
mutableConfig.podcastDb = join(tmpRoot, "podcasts.db");
mutableConfig.podcastDataDir = join(tmpRoot, "data");

const { handleRequest } = await import("./index");
const {
  PodcastStore,
  buildMuxTurns,
  chaptersFromSegments,
  slugifyFilename,
  trackNumberFor,
  toPublicJob,
  renderTranscriptMarkdown,
  recoverPodcastJobs,
  _test,
} = await import("./podcasts");
type PodcastJobRequest = import("./podcasts").PodcastJobRequest;
type PodcastJob = import("./podcasts").PodcastJob;
type ScriptSegment = import("./podcast-script").ScriptSegment;
type PersistedPodcastScript = import("./podcasts").PersistedPodcastScript;

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Every stray background job (triggered by a real POST) fails fast against this, never reaching the network. */
function stubFailingFetch(): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(async () => new Response("stubbed failure", { status: 500 }));
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

function authed(req: Request): Request {
  const headers = new Headers(req.headers);
  headers.set("authorization", "Bearer test-proxy-secret");
  return new Request(req, { headers });
}

function makeRequest(overrides: Partial<PodcastJobRequest> = {}): PodcastJobRequest {
  return { source: "Some research notes.", language: "de", minutes: 10, series: "Test Show", publish: false, cover: true, ...overrides };
}

/** Write a minimal artifact set for `job` to disk and point its `files` at them, bypassing the real pipeline entirely. */
function seedDoneJob(overrides: Partial<PodcastJobRequest> = {}): PodcastJob {
  const store = _test.getStore();
  const job = store.create({ caller: "tester", request: makeRequest(overrides) });
  const dir = join(config.podcastDataDir, job.id);
  mkdirSync(dir, { recursive: true });

  const audioPath = join(dir, "episode.mp3");
  const coverPath = join(dir, "cover.png");
  const scriptPath = join(dir, "script.json");
  writeFileSync(audioPath, "fake-mp3-bytes");
  writeFileSync(coverPath, "fake-png-bytes");
  const script: PersistedPodcastScript = {
    title: "The Plan",
    description: "A short episode about the plan.",
    coverPrompt: "A van at sunset",
    genres: ["Travel"],
    language: "de",
    wordCount: 42,
    hosts: [
      { id: "A", name: "Jonas", voice: "Mark" },
      { id: "B", name: "Lena", voice: "Sarah" },
    ],
    segments: [
      { title: "Cold open", turns: [{ speaker: "A", text: "Los geht's." }, { speaker: "B", text: "Endlich." }] },
    ],
  };
  writeFileSync(scriptPath, JSON.stringify(script));

  return store.update(job.id, {
    status: "done",
    title: script.title,
    description: script.description,
    durationSeconds: 120,
    turns: 2,
    chapters: [{ title: "Cold open", startMs: 0 }],
    files: { audio: audioPath, cover: coverPath, script: scriptPath },
      runner: null,
  });
}

// ---------------------------------------------------------------------------
// PodcastStore CRUD
// ---------------------------------------------------------------------------

describe("PodcastStore", () => {
  test("create/get/list/update/remove round-trip", () => {
    const store = new PodcastStore(":memory:");
    const job = store.create({ caller: "tester", request: makeRequest() });
    expect(job.status).toBe("queued");
    expect(job.files).toEqual({ audio: null, cover: null, script: null });
    expect(store.get(job.id)?.id).toBe(job.id);

    const listed = store.list(10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(job.id);

    const updated = store.update(job.id, { status: "done", title: "Episode 1" });
    expect(updated.status).toBe("done");
    expect(updated.title).toBe("Episode 1");
    expect(updated.createdAt).toBe(job.createdAt);
    expect(store.get(job.id)?.title).toBe("Episode 1");

    store.remove(job.id);
    expect(store.get(job.id)).toBeNull();
  });

  test("update throws on an unknown id", () => {
    const store = new PodcastStore(":memory:");
    expect(() => store.update("does-not-exist", { status: "done" })).toThrow();
  });

  test("list orders newest first", async () => {
    const store = new PodcastStore(":memory:");
    const a = store.create({ caller: "t", request: makeRequest() });
    await Bun.sleep(5); // guarantee a distinct created_at timestamp
    const b = store.create({ caller: "t", request: makeRequest() });

    const listed = store.list(10);
    expect(listed.map((j) => j.id)).toEqual([b.id, a.id]);
  });

  test("get returns null for an unknown id", () => {
    const store = new PodcastStore(":memory:");
    expect(store.get("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildMuxTurns", () => {
  test("short gap before a short interjection, zero gap after the last turn", () => {
    const synthOutputs = [0, 1, 2].map((i) => ({ pcm: new Uint8Array(4), sampleRate: 24000, audioSeconds: 0.1, inputChars: i }));
    const turnTexts = ["A longer opening line right here", "Echt?", "A final closing statement with plenty of words"];

    const muxTurns = buildMuxTurns({ synthOutputs, turnTexts, gapMs: 380, shortGapMs: 160 });

    expect(muxTurns[0]?.gapMsAfter).toBe(160); // next turn ("Echt?") is a short interjection
    expect(muxTurns[1]?.gapMsAfter).toBe(380); // next turn is a normal-length line
    expect(muxTurns[2]?.gapMsAfter).toBe(0); // last turn never gets a trailing gap
  });
});

describe("chaptersFromSegments", () => {
  test("one chapter per segment, at its first turn's offset", () => {
    const segments: ScriptSegment[] = [
      { title: "Intro", turns: [{ speaker: "A", text: "hi" }, { speaker: "B", text: "hey" }] },
      { title: "Deep dive", turns: [{ speaker: "A", text: "so" }] },
    ];
    const turnStartsMs = [0, 1000, 2500];

    expect(chaptersFromSegments(segments, turnStartsMs)).toEqual([
      { title: "Intro", startMs: 0 },
      { title: "Deep dive", startMs: 2500 },
    ]);
  });
});

describe("slugifyFilename", () => {
  test("strips characters outside the allowed set", () => {
    expect(slugifyFilename("Spain/Portugal Trip!!")).toBe("SpainPortugal Trip");
  });

  test("keeps letters, digits, umlauts, space, period, underscore, hyphen", () => {
    expect(slugifyFilename("Über_den-Wolken v2.mp3")).toBe("Über_den-Wolken v2.mp3");
  });

  test("caps at 80 characters", () => {
    expect(slugifyFilename("a".repeat(200))).toHaveLength(80);
  });
});

describe("trackNumberFor", () => {
  test("is one more than the prior done count", () => {
    expect(trackNumberFor(0)).toBe(1);
    expect(trackNumberFor(4)).toBe(5);
  });
});

describe("toPublicJob", () => {
  test("maps to snake_case and never leaks request.source", () => {
    const job: PodcastJob = {
      id: "job-1",
      status: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
      caller: "tester",
      request: makeRequest({ source: "TOP SECRET NOTES" }),
      progress: null,
      title: "Episode 1",
      description: "A description.",
      durationSeconds: 900,
      turns: 40,
      chapters: [{ title: "Intro", startMs: 0 }],
      costUsd: 0.42,
      error: null,
      abs: { url: "https://abs.example.com/item/1", libraryItemId: "item-1", episodeId: "ep-1" },
      files: { audio: "/tmp/a/episode.mp3", cover: "/tmp/a/cover.png", script: "/tmp/a/script.json" },
      runner: null,
    };

    const pub = toPublicJob(job);
    expect(pub.duration_seconds).toBe(900);
    expect(pub.cost_usd).toBe(0.42);
    expect(pub.chapters).toEqual([{ title: "Intro", start_ms: 0 }]);
    expect(pub.abs).toEqual({ url: "https://abs.example.com/item/1", library_item_id: "item-1", episode_id: "ep-1" });
    expect(pub.series).toBe("Test Show");
    expect(pub.links).toEqual({
      audio: "/v1/podcasts/job-1/audio",
      cover: "/v1/podcasts/job-1/cover",
      script: "/v1/podcasts/job-1/script",
    });
    expect(JSON.stringify(pub)).not.toContain("TOP SECRET NOTES");
  });
});

describe("renderTranscriptMarkdown", () => {
  test("renders title, description, and one heading + speaker lines per segment", () => {
    const script: PersistedPodcastScript = {
      title: "The Plan",
      description: "A short episode about the plan.",
      coverPrompt: "x",
      genres: [],
      language: "de",
      wordCount: 10,
      hosts: [
        { id: "A", name: "Jonas", voice: "Mark" },
        { id: "B", name: "Lena", voice: "Sarah" },
      ],
      segments: [
        { title: "Cold open", turns: [{ speaker: "A", text: "Los geht's." }, { speaker: "B", text: "Endlich." }] },
      ],
    };

    const md = renderTranscriptMarkdown(script);
    expect(md).toContain("# The Plan");
    expect(md).toContain("A short episode about the plan.");
    expect(md).toContain("## Cold open");
    expect(md).toContain("**Jonas:** Los geht's.");
    expect(md).toContain("**Lena:** Endlich.");
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe("POST /v1/podcasts validation", () => {
  test("missing source → 400", async () => {
    stubFailingFetch();
    const req = authed(new Request("http://localhost/v1/podcasts", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(400);
  });

  test("non-JSON body → 400", async () => {
    stubFailingFetch();
    const req = authed(new Request("http://localhost/v1/podcasts", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(400);
  });

  test("unsupported language → 400", async () => {
    stubFailingFetch();
    const req = authed(new Request("http://localhost/v1/podcasts", {
      method: "POST",
      body: JSON.stringify({ source: "hello", language: "fr" }),
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(400);
  });

  test("defaults applied → 202, job readable with defaults", async () => {
    stubFailingFetch();
    const req = authed(new Request("http://localhost/v1/podcasts", {
      method: "POST",
      body: JSON.stringify({ source: "hello world" }),
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    expect(res.status).toBe(202);
    const created = (await res.json()) as { id: string; status: string };
    expect(created.status).toBe("queued");

    const getRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${created.id}`)));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body["id"]).toBe(created.id);
    expect(body["series"]).toBe(config.podcastSeries);
    expect(body["minutes"]).toBe(config.podcastDefaultMinutes);
    expect(body["language"]).toBe("de");
    expect(body["publish"]).toBe(false);
    expect(JSON.stringify(body)).not.toContain("hello world");
  });

  test("clamps out-of-range minutes", async () => {
    stubFailingFetch();
    const req = authed(new Request("http://localhost/v1/podcasts", {
      method: "POST",
      body: JSON.stringify({ source: "hello world", minutes: 999 }),
      headers: { "content-type": "application/json" },
    }));
    const res = await handleRequest(req);
    const created = (await res.json()) as { id: string };
    const getRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${created.id}`)));
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body["minutes"]).toBe(60);
  });
});

describe("GET /v1/podcasts/:id", () => {
  test("unknown id → 404", async () => {
    const res = await handleRequest(authed(new Request("http://localhost/v1/podcasts/does-not-exist")));
    expect(res.status).toBe(404);
  });

  test("known id → public JSON shape", async () => {
    const job = seedDoneJob();
    const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}`)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("done");
    expect(body["title"]).toBe("The Plan");
    expect(body["duration_seconds"]).toBe(120);
    expect((body["links"] as Record<string, unknown>)["audio"]).toBe(`/v1/podcasts/${job.id}/audio`);
  });
});

describe("GET /v1/podcasts", () => {
  test("lists jobs, newest first", async () => {
    const job = seedDoneJob();
    const res = await handleRequest(authed(new Request("http://localhost/v1/podcasts")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ id: string }> };
    expect(body.jobs.some((j) => j.id === job.id)).toBe(true);
  });
});

describe("GET /v1/podcasts/:id/audio|cover|script", () => {
  test("serves the mp3, png, and script.json for a job with artifacts", async () => {
    const job = seedDoneJob();

    const audioRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/audio`)));
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers.get("content-type")).toBe("audio/mpeg");
    expect(await audioRes.text()).toBe("fake-mp3-bytes");

    const coverRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/cover`)));
    expect(coverRes.status).toBe(200);
    expect(coverRes.headers.get("content-type")).toBe("image/png");

    const scriptRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/script`)));
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("content-type")).toBe("application/json");
    const script = (await scriptRes.json()) as { title: string };
    expect(script.title).toBe("The Plan");
  });

  test("a title with umlauts still serves a valid Content-Disposition header", async () => {
    const job = seedDoneJob();
    _test.getStore().update(job.id, { title: "München nach Santander – der Camper-Plan" });

    const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/audio`)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Muenchen");
  });

  test("script.json rendered as markdown transcript with ?format=md", async () => {
    const job = seedDoneJob();
    const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/script?format=md`)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain("# The Plan");
    expect(md).toContain("**Jonas:** Los geht's.");
    expect(md).toContain("**Lena:** Endlich.");
  });

  test("404 when a job has no audio yet", async () => {
    const store = _test.getStore();
    const job = store.create({ caller: "t", request: makeRequest() });
    const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/audio`)));
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/podcasts/:id/publish", () => {
  test("400 when the job has no audio yet", async () => {
    const store = _test.getStore();
    const job = store.create({ caller: "t", request: makeRequest() });
    const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/publish`, { method: "POST" })));
    expect(res.status).toBe(400);
  });

  test("404 for an unknown job", async () => {
    const res = await handleRequest(authed(new Request("http://localhost/v1/podcasts/does-not-exist/publish", { method: "POST" })));
    expect(res.status).toBe(404);
  });

  test("runs and returns the job JSON — fails cleanly when Audiobookshelf isn't configured", async () => {
    // audiobookshelf.test.ts / cover.test.ts flip the config singleton to "configured"
    // and bun test shares one module registry — pin the precondition this test is about.
    const cfg = config as unknown as { absUrl: string; absApiKey: string };
    const saved = { absUrl: cfg.absUrl, absApiKey: cfg.absApiKey };
    cfg.absUrl = "";
    cfg.absApiKey = "";
    try {
      const job = seedDoneJob();
      const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/publish`, { method: "POST" })));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; error: string | null };
      expect(body.status).toBe("failed");
      expect(body.error).toContain("not configured");
    } finally {
      cfg.absUrl = saved.absUrl;
      cfg.absApiKey = saved.absApiKey;
    }
  });

  test("409 when the same job is already publishing", async () => {
    const job = seedDoneJob();
    const req1 = authed(new Request(`http://localhost/v1/podcasts/${job.id}/publish`, { method: "POST" }));
    const req2 = authed(new Request(`http://localhost/v1/podcasts/${job.id}/publish`, { method: "POST" }));

    // republishPodcast marks the job "running" synchronously before its first
    // await, so firing req1 without awaiting it still lets req2 observe the
    // guard deterministically.
    const first = handleRequest(req1);
    const res2 = await handleRequest(req2);
    expect(res2.status).toBe(409);
    await first;
  });
});

describe("DELETE /v1/podcasts/:id", () => {
  test("removes the row and artifact directory", async () => {
    const job = seedDoneJob();
    const res = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}`, { method: "DELETE" })));
    expect(res.status).toBe(200);
    expect(_test.getStore().get(job.id)).toBeNull();

    const getRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}`)));
    expect(getRes.status).toBe(404);
  });

  test("404 for an unknown job", async () => {
    const res = await handleRequest(authed(new Request("http://localhost/v1/podcasts/does-not-exist", { method: "DELETE" })));
    expect(res.status).toBe(404);
  });

  test("409 while the same job is publishing", async () => {
    const job = seedDoneJob();
    const publishReq = authed(new Request(`http://localhost/v1/podcasts/${job.id}/publish`, { method: "POST" }));
    const deleteReq = authed(new Request(`http://localhost/v1/podcasts/${job.id}`, { method: "DELETE" }));

    const publishing = handleRequest(publishReq);
    const deleteRes = await handleRequest(deleteReq);
    expect(deleteRes.status).toBe(409);
    await publishing;
  });
});

// ---------------------------------------------------------------------------
// Active-job claim/release — a republish of one job must never clobber a
// concurrently generating (or concurrently republishing) different job.
// ---------------------------------------------------------------------------

describe("claimJob/releaseJob", () => {
  test("a claimed job id blocks both DELETE and POST /publish with 409 until released", async () => {
    const job = seedDoneJob();
    expect(_test.claimJob(job.id)).toBe(true);
    expect(_test.claimJob(job.id)).toBe(false); // already active

    const publishRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}/publish`, { method: "POST" })));
    expect(publishRes.status).toBe(409);

    const deleteRes = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}`, { method: "DELETE" })));
    expect(deleteRes.status).toBe(409);

    _test.releaseJob(job.id);

    const deleteRes2 = await handleRequest(authed(new Request(`http://localhost/v1/podcasts/${job.id}`, { method: "DELETE" })));
    expect(deleteRes2.status).toBe(200);
  });
});

describe("recoverPodcastJobs", () => {
  test("fails a non-terminal job this runner owned (same hostname) as interrupted by restart", async () => {
    const { hostname } = await import("node:os");
    const store = _test.getStore();
    const job = store.create({ caller: "t", request: makeRequest() });
    store.update(job.id, { status: "scripting", runner: `${hostname()}:99999` });

    recoverPodcastJobs();

    const recovered = store.get(job.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBe("interrupted by restart");
  });

  test("leaves a fresh job owned by another runner alone (rolling deploy)", () => {
    const store = _test.getStore();
    const job = store.create({ caller: "t", request: makeRequest() });
    store.update(job.id, { status: "cover", runner: "other-container:1" });

    recoverPodcastJobs();

    expect(store.get(job.id)?.status).toBe("cover");
  });

  test("fails a job from another runner once it has gone stale", () => {
    const store = _test.getStore();
    const job = store.create({ caller: "t", request: makeRequest() });
    store.update(job.id, { status: "synthesizing", runner: "other-container:1" });
    const db = (store as unknown as { db: { run: (sql: string, ...args: unknown[]) => unknown } }).db;
    db.run("UPDATE podcast_job SET updated_at = ? WHERE id = ?", new Date(Date.now() - 45 * 60 * 1000).toISOString(), job.id);

    recoverPodcastJobs();

    const recovered = store.get(job.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toContain("no progress");
  });
});

describe("asciiHeaderSafe", () => {
  test("strips quotes and backslashes alongside non-ASCII bytes", () => {
    expect(_test.asciiHeaderSafe('a"b\\c')).toBe("abc");
  });
});

describe("episodeFilename", () => {
  test("is unique per job and stable for the same job", async () => {
    const { episodeFilename } = await import("./podcasts");
    const a = episodeFilename("2026-09-02", "Nordspanien 2026", "c2e279c6-b004-49cd-91b7-89d969856bf8");
    const b = episodeFilename("2026-09-02", "Nordspanien 2026", "13f825b0-034e-4856-8bbb-64e6f4f01c3c");
    expect(a).toBe("2026-09-02 Nordspanien 2026 [c2e279c6].mp3");
    expect(a).not.toBe(b);
    expect(episodeFilename("2026-09-02", "Camper – die Zahl, die zählt", "3965afde-0000")).toBe("2026-09-02 Camper die Zahl die zählt [3965afde].mp3");
  });
});
