import { absFetch, absJson, resolveLibrary } from "./audiobookshelf";

// Audiobookshelf hygiene: which episodes of the podcast library are finished, abandoned, superseded or test
// leftovers, judged from the user's listening sessions (the client's progress sync alone is unreliable — a
// re-open of a finished episode resets it). Routes verified against ABS v2.36.0 (ApiRouter.js, PodcastController.js):
// PATCH /api/me/progress/:libraryItemId/:episodeId?, DELETE /api/podcasts/:id/episode/:episodeId?hard=1.

/** A session that reached this share of the episode counts as listened through. */
const FINISHED_SHARE = 0.95;
/** Anything shorter than this is a pipeline test, not an episode. */
const TEST_MAX_SECONDS = 5 * 60;
/** Untouched for this long after a partial listen = abandoned. */
const ABANDONED_AFTER_DAYS = 14;

export interface TidyEpisode {
  itemId: string;
  episodeId: string;
  title: string;
  durationSec: number;
  /** ABS' own progress record for this episode, if any. */
  progress: { isFinished: boolean; share: number; lastUpdateMs: number } | null;
  sessions: Array<{ currentTime: number; updatedAtMs: number }>;
}

export type TidyVerdict = "finished" | "needs-finish" | "abandoned" | "never-played" | "in-progress";

export interface TidyRow {
  episode: TidyEpisode;
  verdict: TidyVerdict;
  /** Sessions reached the end, so a lost `isFinished` can be restored. */
  listenedThrough: boolean;
  /** Title of the newer version of the same base title, if one exists. */
  supersededBy: string | null;
  isTest: boolean;
}

/** `Factory v2.2 — Alles entschieden` → `{ base: "factory", version: [2,2] }`; titles without a version token are never superseded. */
export function versionedBase(title: string): { base: string; version: number[] } | null {
  const head = title.split(/\s[—–-]\s|:\s/)[0] ?? title;
  const m = /^(.*?)\s+v(\d+(?:\.\d+)*)$/i.exec(head.trim());
  if (!m) return null;
  return { base: m[1]!.trim().toLowerCase(), version: m[2]!.split(".").map(Number) };
}

function newerVersion(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export function classifyEpisodes(episodes: TidyEpisode[], nowMs: number): TidyRow[] {
  const versions = episodes.map((episode) => ({ episode, v: versionedBase(episode.title) }));
  return episodes.map((episode) => {
    const reached = episode.sessions.reduce((n, s) => Math.max(n, s.currentTime), 0);
    const listenedThrough = episode.durationSec > 0 && reached / episode.durationSec >= FINISHED_SHARE;
    const lastTouchMs = Math.max(episode.progress?.lastUpdateMs ?? 0, ...episode.sessions.map((s) => s.updatedAtMs));
    let verdict: TidyVerdict;
    if (episode.progress?.isFinished) verdict = "finished";
    else if (listenedThrough) verdict = "needs-finish";
    else if (episode.sessions.length === 0 && !episode.progress) verdict = "never-played";
    else if (nowMs - lastTouchMs > ABANDONED_AFTER_DAYS * 86_400_000) verdict = "abandoned";
    else verdict = "in-progress";

    const own = versions.find((x) => x.episode === episode)?.v;
    const newer = own && versions.find((x) => x.v && x.v.base === own.base && newerVersion(x.v.version, own.version));
    return { episode, verdict, listenedThrough, supersededBy: newer ? newer.episode.title : null, isTest: episode.durationSec > 0 && episode.durationSec < TEST_MAX_SECONDS };
  });
}

interface AbsMe {
  mediaProgress?: Array<{ libraryItemId: string; episodeId?: string; isFinished: boolean; progress: number; lastUpdate: number }>;
}
interface AbsSession {
  libraryItemId: string;
  episodeId?: string;
  currentTime: number;
  updatedAt: number;
  deviceInfo?: { clientName?: string };
}
interface AbsShow {
  media: { metadata: { title: string }; episodes?: Array<{ id: string; title?: string; duration?: number }> };
}

/** Every episode of every show in the configured podcast library, with its progress record and listening sessions. */
export async function loadTidyEpisodes(): Promise<{ episodes: TidyEpisode[]; clients: string[] }> {
  const library = await resolveLibrary();
  const [list, me, sessions] = await Promise.all([
    absJson<{ results: Array<{ id: string }> }>(`/api/libraries/${library.id}/items?limit=100`),
    absJson<AbsMe>("/api/me"),
    absJson<{ sessions: AbsSession[] }>("/api/me/listening-sessions?itemsPerPage=1000"),
  ]);
  const episodes: TidyEpisode[] = [];
  for (const { id } of list.results) {
    const show = await absJson<AbsShow>(`/api/items/${id}?expanded=1`);
    for (const e of show.media.episodes ?? []) {
      const p = me.mediaProgress?.find((m) => m.libraryItemId === id && m.episodeId === e.id);
      episodes.push({
        itemId: id,
        episodeId: e.id,
        title: e.title ?? "(untitled)",
        durationSec: e.duration ?? 0,
        progress: p ? { isFinished: p.isFinished, share: p.progress, lastUpdateMs: p.lastUpdate } : null,
        sessions: sessions.sessions.filter((s) => s.libraryItemId === id && s.episodeId === e.id).map((s) => ({ currentTime: s.currentTime, updatedAtMs: s.updatedAt })),
      });
    }
  }
  const clients = [...new Set(sessions.sessions.map((s) => s.deviceInfo?.clientName).filter((c): c is string => Boolean(c)))];
  return { episodes, clients };
}

export async function markFinished(episode: Pick<TidyEpisode, "itemId" | "episodeId">): Promise<void> {
  await absFetch(`/api/me/progress/${episode.itemId}/${episode.episodeId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isFinished: true }),
  });
}

/** Hard delete: removes the file too, otherwise the next library scan brings the episode back. */
export async function removeEpisode(episode: Pick<TidyEpisode, "itemId" | "episodeId">): Promise<void> {
  await absFetch(`/api/podcasts/${episode.itemId}/episode/${episode.episodeId}?hard=1`, { method: "DELETE" });
}
