/**
 * Unit tests for the Audiobookshelf publish client. Stubs globalThis.fetch
 * with a small scripted responder keyed by method+path — no network, no ABS
 * instance required. `config.absUrl`/`absApiKey` are set by mutating the
 * config singleton directly (see cover.test.ts's note on why: `as const` is
 * a compile-time assertion only, and env-var races across the shared module
 * registry would make "configured" tests order-dependent in a full `bun test`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

const { absConfigured, AbsError, publishToAudiobookshelf } = await import("./audiobookshelf");
const { config } = await import("./config");

type MutableConfig = { absUrl: string; absApiKey: string };
const mutableConfig = config as unknown as MutableConfig;

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = impl;
}

beforeEach(() => {
  mutableConfig.absUrl = "https://abs.example.com";
  mutableConfig.absApiKey = "test-abs-key";
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Deliberately NOT config.podcastSeries — a per-request series must flow through
// uploadEpisodeFile/pollOnce/patchMedia instead of falling back to the config default.
const SERIES = "A Different Show";
const LIBRARY: { id: string; name: string; mediaType: string; folders: Array<{ id: string; fullPath: string }> } = {
  id: "lib1",
  name: "Podcasts",
  mediaType: "podcast",
  folders: [{ id: "f1", fullPath: "/podcasts" }],
};

function baseEpisode(): { title: string; description: string; filename: string; file: Uint8Array } {
  return { title: "Episode One", description: "What happened today.", filename: "episode-one.mp3", file: new Uint8Array([1, 2, 3]) };
}

describe("absConfigured", () => {
  test("true when both url and key are set", () => {
    expect(absConfigured()).toBe(true);
  });

  test("false when either is missing", () => {
    mutableConfig.absUrl = "";
    expect(absConfigured()).toBe(false);
  });
});

describe("publishToAudiobookshelf — new podcast", () => {
  test("uploads, scans, finds the item, patches media/cover/episode", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let mediaPatchBody: Record<string, unknown> = {};
    let episodePatchBody: Record<string, unknown> = {};
    let coverUploaded = false;
    const captured: { uploadTitle: string | null } = { uploadTitle: null };

    setFetch(async (url, init) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path: u.pathname });

      if (method === "GET" && u.pathname === "/api/libraries") {
        return jsonRes({ libraries: [LIBRARY] });
      }
      if (method === "POST" && u.pathname === "/api/upload") {
        captured.uploadTitle = (init?.body as FormData).get("title") as string | null;
        return new Response(null, { status: 200 });
      }
      if (method === "POST" && u.pathname === `/api/libraries/${LIBRARY.id}/scan`) {
        return new Response(null, { status: 200 });
      }
      if (method === "GET" && u.pathname === `/api/libraries/${LIBRARY.id}/items`) {
        return jsonRes({
          results: [{ id: "item1", media: { metadata: { title: SERIES, description: "" }, coverPath: null } }],
        });
      }
      if (method === "GET" && u.pathname === "/api/items/item1") {
        return jsonRes({
          id: "item1",
          media: {
            metadata: { title: SERIES, description: "" },
            coverPath: null,
            episodes: [{ id: "ep1", title: "placeholder", audioFile: { metadata: { filename: "episode-one.mp3" } } }],
          },
        });
      }
      if (method === "PATCH" && u.pathname === "/api/items/item1/media") {
        mediaPatchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonRes({ updated: true, libraryItem: {} });
      }
      if (method === "POST" && u.pathname === "/api/items/item1/cover") {
        coverUploaded = true;
        return jsonRes({ success: true, cover: "/covers/item1.png" });
      }
      if (method === "PATCH" && u.pathname === "/api/podcasts/item1/episode/ep1") {
        episodePatchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonRes({ title: "Episode One" });
      }
      throw new Error(`unexpected fetch: ${method} ${u.pathname}`);
    });

    const result = await publishToAudiobookshelf({
      series: SERIES,
      author: "Hermes",
      description: "A daily briefing show.",
      language: "en",
      genres: ["News"],
      episode: baseEpisode(),
      cover: new Uint8Array([9, 9, 9]),
    });

    expect(result).toEqual({ libraryId: "lib1", libraryItemId: "item1", episodeId: "ep1", url: "https://abs.example.com/item/item1" });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/upload")).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/libraries/lib1/scan")).toBe(true);
    expect(captured.uploadTitle).toBe(SERIES);
    expect(mediaPatchBody["metadata"]).toMatchObject({ title: SERIES, author: "Hermes", description: "A daily briefing show.", genres: ["News"], language: "en" });
    expect(coverUploaded).toBe(true);
    expect(episodePatchBody["title"]).toBe("Episode One");
    expect(episodePatchBody["description"]).toBe("What happened today.");
    expect(typeof episodePatchBody["publishedAt"]).toBe("number");
  });
});

describe("publishToAudiobookshelf — existing podcast", () => {
  test("second episode does not clobber an existing description or cover", async () => {
    let mediaPatchCalled = false;
    let coverPatchCalled = false;

    setFetch(async (url, init) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && u.pathname === "/api/libraries") return jsonRes({ libraries: [LIBRARY] });
      if (method === "POST" && u.pathname === "/api/upload") return new Response(null, { status: 200 });
      if (method === "POST" && u.pathname === `/api/libraries/${LIBRARY.id}/scan`) return new Response(null, { status: 200 });
      if (method === "GET" && u.pathname === `/api/libraries/${LIBRARY.id}/items`) {
        return jsonRes({
          results: [{ id: "item1", media: { metadata: { title: SERIES, description: "A hand-edited show description." }, coverPath: "/covers/item1.png" } }],
        });
      }
      if (method === "GET" && u.pathname === "/api/items/item1") {
        return jsonRes({
          id: "item1",
          media: {
            metadata: { title: SERIES, description: "A hand-edited show description." },
            coverPath: "/covers/item1.png",
            episodes: [
              { id: "ep1", title: "old", audioFile: { metadata: { filename: "episode-old.mp3" } } },
              { id: "ep2", title: "placeholder", audioFile: { metadata: { filename: "episode-two.mp3" } } },
            ],
          },
        });
      }
      if (method === "PATCH" && u.pathname === "/api/items/item1/media") {
        mediaPatchCalled = true;
        return jsonRes({ updated: true, libraryItem: {} });
      }
      if (method === "POST" && u.pathname === "/api/items/item1/cover") {
        coverPatchCalled = true;
        return jsonRes({ success: true, cover: "/covers/item1.png" });
      }
      if (method === "PATCH" && u.pathname === "/api/podcasts/item1/episode/ep2") {
        return jsonRes({ title: "Episode Two" });
      }
      throw new Error(`unexpected fetch: ${method} ${u.pathname}`);
    });

    const result = await publishToAudiobookshelf({
      series: SERIES,
      author: "Hermes",
      description: "A daily briefing show.",
      language: "en",
      genres: ["News"],
      episode: { title: "Episode Two", description: "Second day.", filename: "episode-two.mp3", file: new Uint8Array([1]) },
      cover: new Uint8Array([9]),
    });

    expect(result.episodeId).toBe("ep2");
    expect(mediaPatchCalled).toBe(false);
    expect(coverPatchCalled).toBe(false);
  });
});

describe("publishToAudiobookshelf — failure", () => {
  test("missing podcast library throws AbsError naming the configured library", async () => {
    setFetch(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/libraries") {
        return jsonRes({ libraries: [{ id: "lib2", name: "Audiobooks", mediaType: "book", folders: [] }] });
      }
      throw new Error(`unexpected fetch: ${u.pathname}`);
    });

    await expect(
      publishToAudiobookshelf({
        series: SERIES,
        author: "Hermes",
        description: "x",
        language: "en",
        genres: [],
        episode: baseEpisode(),
      }),
    ).rejects.toThrow(AbsError);
  });
});

describe("publishToAudiobookshelf — unconfigured", () => {
  test("throws AbsError without calling fetch", async () => {
    mutableConfig.absUrl = "";
    mutableConfig.absApiKey = "";

    let fetchCalled = false;
    setFetch(async () => {
      fetchCalled = true;
      throw new Error("should not be called");
    });

    await expect(
      publishToAudiobookshelf({
        series: SERIES,
        author: "Hermes",
        description: "x",
        language: "en",
        genres: [],
        episode: baseEpisode(),
      }),
    ).rejects.toThrow(AbsError);
    expect(fetchCalled).toBe(false);
  });
});

describe("filenameMatches", () => {
  test("matches on the job-id token regardless of how ABS sanitized the rest", async () => {
    const { filenameMatches } = await import("./audiobookshelf");
    expect(filenameMatches("2026-09-02 Camper die Zahl [3965afde].mp3", "2026-09-02 Camper  die Zahl [3965afde].mp3")).toBe(true);
    expect(filenameMatches("2026-09-02 Camper [c2e279c6].mp3", "2026-09-02 Camper [3965afde].mp3")).toBe(false);
    expect(filenameMatches("plain.mp3", "plain.mp3")).toBe(true);
    expect(filenameMatches(undefined, "plain.mp3")).toBe(false);
  });
});
