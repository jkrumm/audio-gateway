import { config } from "./config";
import { log } from "./log";
import { withSpan } from "./otel";

// Audiobookshelf (ABS) v2.36 publish client — the podcast pipeline's final
// step. ABS' own openapi.json documents only a subset of its REST surface;
// the upload/scan/items/cover routes used here were verified against the
// server source (routers/ApiRouter.js, controllers/{Library,LibraryItem,
// Podcast}Controller.js) at tag v2.36.0. Every call goes through `absFetch`,
// which adds auth and a timeout and throws `AbsError` on non-2xx.

const POLL_INTERVAL_MS = 2000;
const POLL_DEADLINE_MS = 90_000;
const FETCH_TIMEOUT_MS = 30_000;

/** Any non-2xx response, timeout, or missing-library/item condition. */
export class AbsError extends Error {}

/** Whether both the ABS base URL and API key are set — unset disables publishing entirely. */
export function absConfigured(): boolean {
  return config.absUrl !== "" && config.absApiKey !== "";
}

export interface AbsEpisode {
  title: string;
  description: string;
  filename: string;
  file: Uint8Array;
}

export interface AbsPublishInput {
  series: string;
  author: string;
  description: string;
  language: string;
  genres: string[];
  episode: AbsEpisode;
  cover?: Uint8Array;
}

export interface AbsPublishResult {
  libraryId: string;
  libraryItemId: string;
  episodeId: string | null;
  url: string;
}

// ---------------------------------------------------------------------------
// ABS wire shapes (only the fields this client reads/writes)
// ---------------------------------------------------------------------------

interface AbsLibraryFolder {
  id: string;
  fullPath: string;
}

interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;
  folders: AbsLibraryFolder[];
}

interface AbsAudioFile {
  metadata?: { filename?: string };
}

interface AbsEpisodeItem {
  id: string;
  title?: string;
  audioFile?: AbsAudioFile;
}

interface AbsLibraryItemMinified {
  id: string;
  media?: {
    metadata?: { title?: string; description?: string };
    coverPath?: string | null;
  };
}

interface AbsLibraryItemExpanded extends AbsLibraryItemMinified {
  media?: AbsLibraryItemMinified["media"] & {
    episodes?: AbsEpisodeItem[];
  };
}

async function absFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(`${config.absUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.absApiKey}`, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new AbsError(`ABS ${init.method ?? "GET"} ${path} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return { status: res.status, body };
}

async function absJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { body } = await absFetch(path, init);
  return JSON.parse(body) as T;
}

/** Resolve `config.absLibrary` (name or id) to a podcast-typed ABS library. */
async function resolveLibrary(): Promise<AbsLibrary> {
  const { libraries } = await absJson<{ libraries: AbsLibrary[] }>("/api/libraries");
  const target = config.absLibrary.trim().toLowerCase();
  const match = libraries.find(
    (lib) => (lib.id === config.absLibrary || lib.name.trim().toLowerCase() === target) && lib.mediaType === "podcast",
  );
  if (match) return match;

  const podcastLibraries = libraries.filter((lib) => lib.mediaType === "podcast").map((lib) => lib.name);
  throw new AbsError(
    `No podcast library named "${config.absLibrary}" found. Podcast libraries present: ${
      podcastLibraries.length ? podcastLibraries.join(", ") : "(none)"
    }`,
  );
}

async function uploadEpisodeFile(library: AbsLibrary, episode: AbsEpisode, series: string): Promise<void> {
  const folder = library.folders[0];
  if (!folder) throw new AbsError(`Library "${library.name}" has no folders configured`);

  const form = new FormData();
  form.set("title", series);
  form.set("library", library.id);
  form.set("folder", folder.id);
  form.set("files[]", new Blob([episode.file], { type: "audio/mpeg" }), episode.filename);

  await absFetch("/api/upload", { method: "POST", body: form });
}

async function triggerScan(libraryId: string): Promise<void> {
  await absFetch(`/api/libraries/${libraryId}/scan`, { method: "POST" });
}

interface FoundItem {
  item: AbsLibraryItemExpanded;
  episode: AbsEpisodeItem | null;
}

/** One poll attempt: list the library, find the show by title, expand it, and look for the uploaded filename. */
async function pollOnce(libraryId: string, filename: string, series: string): Promise<FoundItem | null> {
  const target = series.trim().toLowerCase();
  const { results } = await absJson<{ results: AbsLibraryItemMinified[] }>(
    `/api/libraries/${libraryId}/items?limit=100&sort=addedAt&desc=1`,
  );
  const minified = results.find((r) => (r.media?.metadata?.title ?? "").trim().toLowerCase() === target);
  if (!minified) return null;

  const expanded = await absJson<AbsLibraryItemExpanded>(`/api/items/${minified.id}?expanded=1`);
  const episode = expanded.media?.episodes?.find((ep) => ep.audioFile?.metadata?.filename === filename) ?? null;
  if (!episode) return null;

  return { item: expanded, episode };
}

/** Poll until the scan has picked up the uploaded file as an episode, or time out. */
async function waitForEpisode(libraryId: string, filename: string, series: string): Promise<FoundItem> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    const found = await pollOnce(libraryId, filename, series);
    if (found) return found;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new AbsError(`Timed out waiting for ABS to scan episode file "${filename}" into library "${series}"`);
}

async function patchMedia(itemId: string, input: AbsPublishInput): Promise<void> {
  await absFetch(`/api/items/${itemId}/media`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      metadata: {
        title: input.series,
        author: input.author,
        description: input.description,
        genres: input.genres,
        language: input.language,
      },
    }),
  });
}

async function uploadCover(itemId: string, cover: Uint8Array): Promise<void> {
  const form = new FormData();
  form.set("cover", new Blob([cover], { type: "image/png" }), "cover.png");
  await absFetch(`/api/items/${itemId}/cover`, { method: "POST", body: form });
}

async function patchEpisode(itemId: string, episodeId: string, episode: AbsEpisode): Promise<void> {
  await absFetch(`/api/podcasts/${itemId}/episode/${episodeId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: episode.title,
      description: episode.description,
      publishedAt: Date.now(),
    }),
  });
}

/**
 * Upload one episode into the configured Audiobookshelf podcast library,
 * trigger a scan, then patch metadata/cover/episode fields once the scan has
 * picked the file up. Show-level description/cover are only written when the
 * podcast item is newly created OR (description) currently empty — never
 * clobbering a hand-edited show description; genres/language are always
 * merged in since they carry no editorial intent.
 */
export async function publishToAudiobookshelf(input: AbsPublishInput): Promise<AbsPublishResult> {
  if (!absConfigured()) {
    throw new AbsError("Audiobookshelf publishing not configured (ABS_URL/ABS_API_KEY unset)");
  }

  return withSpan(
    "audio.publish.abs",
    {},
    async (span) => {
      const library = await resolveLibrary();
      span.setAttributes({ "abs.library_id": library.id });

      await uploadEpisodeFile(library, input.episode, input.series);
      log.info("abs upload done", { library: library.name, filename: input.episode.filename });

      await triggerScan(library.id);
      log.info("abs scan triggered", { libraryId: library.id });

      const found = await waitForEpisode(library.id, input.episode.filename, input.series);
      const itemId = found.item.id;
      const episodeId = found.episode?.id ?? null;
      log.info("abs item found", { itemId, episodeId });

      // A freshly scanned item's title equals the series name and its
      // description is unset — that's the only reliable "just created" signal
      // this endpoint surface gives us (ABS assigns createdAt server-side and
      // the minified list response doesn't expose it here).
      const existingDescription = found.item.media?.metadata?.description ?? "";
      const created = existingDescription === "";
      span.setAttributes({ "abs.item_id": itemId, "abs.episode_id": episodeId, "abs.created": created });

      if (created) {
        await patchMedia(itemId, input);
      }

      const hasCover = Boolean(found.item.media?.coverPath);
      if (input.cover && (created || !hasCover)) {
        await uploadCover(itemId, input.cover);
      }

      if (episodeId) {
        await patchEpisode(itemId, episodeId, input.episode);
      }

      return {
        libraryId: library.id,
        libraryItemId: itemId,
        episodeId,
        url: `${config.absUrl}/item/${itemId}`,
      };
    },
    "client",
  );
}
