import { describe, expect, test } from "bun:test";

// See audiobookshelf.test.ts — config.ts needs the shared baseline env before first import.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";

const { classifyEpisodes, versionedBase } = await import("./abs-tidy");
type TidyEpisode = import("./abs-tidy").TidyEpisode;

const NOW = Date.parse("2026-10-26T12:00:00Z");
const DAY = 86_400_000;

const ep = (over: Partial<TidyEpisode> & { title: string }): TidyEpisode => ({
  itemId: "i",
  episodeId: over.title.slice(0, 6),
  durationSec: 1200,
  progress: null,
  sessions: [],
  ...over,
});

describe("versionedBase", () => {
  test("reads base + version from the head of the title", () => {
    expect(versionedBase("Factory v2.2 — Alles entschieden")).toEqual({ base: "factory", version: [2, 2] });
    expect(versionedBase("Factory v2 — fünf Entscheidungen")).toEqual({ base: "factory", version: [2] });
  });
  test("titles without a version token are never versioned", () => {
    expect(versionedBase("WeatherOrb: Design steht")).toBeNull();
  });
});

describe("classifyEpisodes", () => {
  test("a finished flag lost to a client re-open is restored from the sessions", () => {
    const [row] = classifyEpisodes(
      [ep({ title: "Kessel", progress: { isFinished: false, share: 0.01, lastUpdateMs: NOW - DAY }, sessions: [{ currentTime: 1200, updatedAtMs: NOW - 20 * DAY }, { currentTime: 12, updatedAtMs: NOW - DAY }] })],
      NOW,
    );
    expect(row!.verdict).toBe("needs-finish");
  });

  test("no sessions and no progress is never-played; a stale partial listen is abandoned", () => {
    const rows = classifyEpisodes(
      [
        ep({ title: "Unplayed" }),
        ep({ title: "Stale", progress: { isFinished: false, share: 0.4, lastUpdateMs: NOW - 30 * DAY }, sessions: [{ currentTime: 500, updatedAtMs: NOW - 30 * DAY }] }),
        ep({ title: "Recent", progress: { isFinished: false, share: 0.4, lastUpdateMs: NOW - DAY }, sessions: [{ currentTime: 500, updatedAtMs: NOW - DAY }] }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.verdict)).toEqual(["never-played", "abandoned", "in-progress"]);
  });

  test("the older version of a versioned title is superseded; unversioned siblings are not", () => {
    const rows = classifyEpisodes(
      [ep({ title: "Factory v2 — alt" }), ep({ title: "Factory v2.2 — neu" }), ep({ title: "WeatherOrb: A" }), ep({ title: "WeatherOrb: B" })],
      NOW,
    );
    expect(rows.map((r) => r.supersededBy)).toEqual(["Factory v2.2 — neu", null, null, null]);
  });

  test("episodes under five minutes are tests", () => {
    const rows = classifyEpisodes([ep({ title: "Kurz", durationSec: 187 }), ep({ title: "Lang" })], NOW);
    expect(rows.map((r) => r.isTest)).toEqual([true, false]);
  });
});
