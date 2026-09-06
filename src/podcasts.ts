import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { config } from "./config";
import { log } from "./log";
import { type Span, startSpan, traceIdFromRequestId, withRootSpan, withSpan } from "./otel";
import { getRequestMeta, recordUsage, runWithRequestContext } from "./usage";
import { buildEpisodeProfile, loadShowBible, type PodcastHost, type PodcastScript, type ScriptSegment, writePodcastScript } from "./podcast-script";
import { type SynthTurnOutput, synthesizeTurns, turnsForSynthesis } from "./podcast-synth";
import { type Chapter, concatWithGaps, masterPodcastMp3, type MuxTurn, matchHostLoudness } from "./podcast-mux";
import { coverConfigured, generateCover } from "./cover";
import { absConfigured, publishToAudiobookshelf } from "./audiobookshelf";
import { readBrainNotes, runPodcastResearch } from "./podcast-research";
import { decideEpisodeBrief } from "./podcast-editorial";
import { writeEpisodeBrainNote } from "./brain-note";
import { EMPTY_DOSSIER, type Dossier, type EpisodeBrief, type EpisodeHistory, type EpisodeProfile, type EpisodeSummary } from "./podcast-types";

// Podcast orchestrator: turns one HTTP request into a long-running job
// (script → per-turn synth → mux/master → optional cover → optional publish),
// persisted in `podcast_job` (bun:sqlite) so status survives a restart within
// the same process lifetime and is pollable while the pipeline runs. Only one
// job's pipeline runs at a time (module-level FIFO) — bounds Replicate fan-out
// and memory on a 512 MB container; a republish (see `handlePodcasts`'s
// `/publish` route) is comparatively cheap and runs outside that queue,
// guarded only against re-entering the SAME job.

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------

export type PodcastStatus =
  | "queued"
  | "scripting"
  | "synthesizing"
  | "mastering"
  | "cover"
  | "publishing"
  | "done"
  | "failed";

export interface PodcastJobRequest {
  source: string;
  /** Brain-relative note paths, read server-side and appended to `source` (which may be blank when this is non-empty). */
  sourcePaths: string[];
  brief?: string;
  title?: string;
  language: "de" | "en";
  minutes: number;
  series: string;
  publish: boolean;
  cover: boolean;
  /** Run the research stage (brain/past-episodes/research-gateway tool loop). */
  research: boolean;
  /** The editor may not deviate from `minutes` when true. */
  pinMinutes: boolean;
  /** Write the transcript note back into the brain once the job is done. */
  brainNote: boolean;
}

export interface PodcastJob {
  id: string;
  status: PodcastStatus;
  createdAt: string;
  updatedAt: string;
  caller: string;
  request: PodcastJobRequest;
  progress: { stage: string; done: number; total: number } | null;
  title: string | null;
  description: string | null;
  durationSeconds: number | null;
  turns: number | null;
  chapters: { title: string; startMs: number }[] | null;
  costUsd: number | null;
  error: string | null;
  abs: { url: string; libraryItemId: string; episodeId: string | null } | null;
  /** Absolute paths under `config.podcastDataDir/<id>/`. */
  files: { audio: string | null; cover: string | null; script: string | null; dossier: string | null; brief: string | null };
  /**
   * Which process is running the job (`hostname:pid`), set when the queue
   * claims it. A rolling deploy briefly runs two containers on the same
   * ledger; the new one must not declare the old one's live job dead.
   */
  runner: string | null;
  /** The editor's decision for this episode (docs/podcast-editorial-room.md §2); null before the editorial stage runs. */
  brief: EpisodeBrief | null;
  /** What the ledger remembers about this episode once the script is locked; `durationSeconds` fills in after mastering. */
  profile: EpisodeProfile | null;
  /** Result of writing the transcript back into the brain; null when skipped (no BRAIN_DIR, `brainNote: false`) or not yet attempted. */
  brainNote: { path: string; committed: boolean; pushed: boolean } | null;
}

const NON_TERMINAL_STATUSES: PodcastStatus[] = [
  "queued",
  "scripting",
  "synthesizing",
  "mastering",
  "cover",
  "publishing",
];

/** Scanning the ledger for recovery/track-numbering never needs to page — a personal show does a handful of episodes a week. */
const LEDGER_SCAN_LIMIT = 100_000;

// ---------------------------------------------------------------------------
// Store — a job ledger, not a query surface: everything mutable beyond the
// indexable columns lives as one JSON blob (`state_json`).
// ---------------------------------------------------------------------------

interface PodcastJobRow {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  caller: string;
  request_json: string;
  state_json: string;
}

interface PodcastJobState {
  progress: PodcastJob["progress"];
  title: PodcastJob["title"];
  description: PodcastJob["description"];
  durationSeconds: PodcastJob["durationSeconds"];
  turns: PodcastJob["turns"];
  chapters: PodcastJob["chapters"];
  costUsd: PodcastJob["costUsd"];
  error: PodcastJob["error"];
  abs: PodcastJob["abs"];
  files: PodcastJob["files"];
  runner?: PodcastJob["runner"];
  brief: PodcastJob["brief"];
  profile: PodcastJob["profile"];
  brainNote: PodcastJob["brainNote"];
}

function jobToState(job: PodcastJob): PodcastJobState {
  return {
    progress: job.progress,
    title: job.title,
    description: job.description,
    durationSeconds: job.durationSeconds,
    turns: job.turns,
    chapters: job.chapters,
    costUsd: job.costUsd,
    error: job.error,
    abs: job.abs,
    files: job.files,
    runner: job.runner,
    brief: job.brief,
    profile: job.profile,
    brainNote: job.brainNote,
  };
}

/** Defaults applied to a request parsed from an older ledger row — sourcePaths/research/pinMinutes/brainNote didn't exist before v2. */
function withRequestDefaults(request: Partial<PodcastJobRequest>): PodcastJobRequest {
  return {
    source: request.source ?? "",
    sourcePaths: request.sourcePaths ?? [],
    brief: request.brief,
    title: request.title,
    language: request.language ?? "de",
    minutes: request.minutes ?? config.podcastDefaultMinutes,
    series: request.series ?? config.podcastSeries,
    publish: request.publish ?? false,
    cover: request.cover ?? true,
    research: request.research ?? true,
    pinMinutes: request.pinMinutes ?? false,
    brainNote: request.brainNote ?? true,
  };
}

function rowToJob(row: PodcastJobRow): PodcastJob {
  const request = withRequestDefaults(JSON.parse(row.request_json) as Partial<PodcastJobRequest>);
  const state = JSON.parse(row.state_json) as Partial<PodcastJobState>;
  return {
    id: row.id,
    status: row.status as PodcastStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    caller: row.caller,
    request,
    runner: state.runner ?? null,
    progress: state.progress ?? null,
    title: state.title ?? null,
    description: state.description ?? null,
    durationSeconds: state.durationSeconds ?? null,
    turns: state.turns ?? null,
    chapters: state.chapters ?? null,
    costUsd: state.costUsd ?? null,
    error: state.error ?? null,
    abs: state.abs ?? null,
    files: {
      audio: state.files?.audio ?? null,
      cover: state.files?.cover ?? null,
      script: state.files?.script ?? null,
      dossier: state.files?.dossier ?? null,
      brief: state.files?.brief ?? null,
    },
    brief: state.brief ?? null,
    profile: state.profile ?? null,
    brainNote: state.brainNote ?? null,
  };
}

/**
 * Job ledger for the podcast pipeline. `create`/`get`/`list`/`update`/`remove`
 * is the whole public interface — deliberately not a query surface. Takes an
 * injectable db path (`:memory:` works) so tests don't touch the real
 * `config.podcastDb` file.
 */
export class PodcastStore {
  private readonly db: Database;
  private readonly upsert;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS podcast_job (
        id           TEXT PRIMARY KEY,
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        caller       TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state_json   TEXT NOT NULL
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_podcast_job_created_at ON podcast_job (created_at);");

    this.upsert = this.db.prepare(`
      INSERT INTO podcast_job (id, status, created_at, updated_at, caller, request_json, state_json)
      VALUES ($id, $status, $createdAt, $updatedAt, $caller, $requestJson, $stateJson)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        request_json = excluded.request_json,
        state_json = excluded.state_json
    `);
  }

  private write(job: PodcastJob): void {
    this.upsert.run({
      $id: job.id,
      $status: job.status,
      $createdAt: job.createdAt,
      $updatedAt: job.updatedAt,
      $caller: job.caller,
      $requestJson: JSON.stringify(job.request),
      $stateJson: JSON.stringify(jobToState(job)),
    });
  }

  create(params: { caller: string; request: PodcastJobRequest }): PodcastJob {
    const now = new Date().toISOString();
    const job: PodcastJob = {
      id: crypto.randomUUID(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      caller: params.caller,
      request: params.request,
      progress: null,
      title: null,
      description: null,
      durationSeconds: null,
      turns: null,
      chapters: null,
      costUsd: null,
      error: null,
      abs: null,
      files: { audio: null, cover: null, script: null, dossier: null, brief: null },
      runner: null,
      brief: null,
      profile: null,
      brainNote: null,
    };
    this.write(job);
    return job;
  }

  get(id: string): PodcastJob | null {
    const row = this.db.query("SELECT * FROM podcast_job WHERE id = $id").get({ $id: id }) as PodcastJobRow | null;
    return row ? rowToJob(row) : null;
  }

  /** Latest `limit` jobs, newest first. */
  list(limit: number): PodcastJob[] {
    const rows = this.db
      .query("SELECT * FROM podcast_job ORDER BY created_at DESC LIMIT $limit")
      .all({ $limit: limit }) as PodcastJobRow[];
    return rows.map(rowToJob);
  }

  /**
   * `done` jobs of `series`, newest first, as the editor and the research
   * tools see them — the whole ledger is scanned (small, personal show; see
   * `LEDGER_SCAN_LIMIT`) since `series` lives inside `request_json`, not a column.
   */
  recentEpisodes(series: string, limit: number): EpisodeSummary[] {
    const rows = this.db
      .query("SELECT * FROM podcast_job WHERE status = 'done' ORDER BY created_at DESC LIMIT $limit")
      .all({ $limit: LEDGER_SCAN_LIMIT }) as PodcastJobRow[];
    return rows
      .map(rowToJob)
      .filter((job) => job.request.series === series)
      .slice(0, limit)
      .map((job) => ({ id: job.id, createdAt: job.createdAt, title: job.title ?? "", description: job.description ?? "", profile: job.profile }));
  }

  /** Shallow-merge `patch` into the stored job and bump `updatedAt`. Throws if `id` is unknown. */
  update(id: string, patch: Partial<PodcastJob>): PodcastJob {
    const existing = this.get(id);
    if (!existing) throw new Error(`podcast job not found: ${id}`);
    const merged: PodcastJob = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.write(merged);
    return merged;
  }

  remove(id: string): void {
    this.db.query("DELETE FROM podcast_job WHERE id = $id").run({ $id: id });
  }
}

let storeInstance: PodcastStore | null = null;

/** Lazily construct the module-level store against `config.podcastDb` on first use — never at import time, so tests can mutate the config singleton first (mirrors cover.test.ts). */
function getStore(): PodcastStore {
  if (!storeInstance) storeInstance = new PodcastStore(config.podcastDb);
  return storeInstance;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A turn this short is an interjection ("Echt?", "Mhm.") — it gets a shorter lead-in gap. */
const SHORT_INTERJECTION_MAX_WORDS = 6;
/** Per-host level before mastering; loudnorm lifts the programme to -16 LUFS afterwards. */
const PRE_MASTER_HOST_LUFS = -20;
const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

/**
 * Turn per-turn synth output into {@link MuxTurn}s: the gap before a turn is
 * short when THAT turn is a short interjection, zero after the last turn.
 * `turnTexts` must be the same length and order as `synthOutputs`.
 */
export function buildMuxTurns(params: {
  synthOutputs: SynthTurnOutput[];
  turnTexts: string[];
  gapMs: number;
  shortGapMs: number;
}): MuxTurn[] {
  const { synthOutputs, turnTexts, gapMs, shortGapMs } = params;
  return synthOutputs.map((output, i) => {
    const isLast = i === synthOutputs.length - 1;
    const nextWords = isLast ? 0 : countWords(turnTexts[i + 1] ?? "");
    return {
      pcm: output.pcm,
      sampleRate: output.sampleRate,
      gapMsAfter: isLast ? 0 : nextWords <= SHORT_INTERJECTION_MAX_WORDS ? shortGapMs : gapMs,
    };
  });
}

/** One chapter per segment, starting at its first turn's offset (from `concatWithGaps`'s `turnStartsMs`). */
export function chaptersFromSegments(segments: ScriptSegment[], turnStartsMs: number[]): Chapter[] {
  const chapters: Chapter[] = [];
  let turnIndex = 0;
  for (const segment of segments) {
    chapters.push({ title: segment.title, startMs: turnStartsMs[turnIndex] ?? 0 });
    turnIndex += segment.turns.length;
  }
  return chapters;
}

const SLUG_DISALLOWED = /[^A-Za-z0-9äöüÄÖÜß ._-]/g;
const SLUG_MAX_CHARS = 80;

/** Sanitize a title into a filesystem/URL-safe slug — `[A-Za-z0-9äöüÄÖÜß ._-]`, capped at 80 chars. */
export function slugifyFilename(title: string): string {
  // Collapse runs of whitespace too: Audiobookshelf's own sanitizer does, and
  // the scan poll matches on the stored name — "Camper  die Zahl" (after an
  // en dash was stripped) never matched "Camper die Zahl" (2026-09-02).
  const cleaned = title.replace(SLUG_DISALLOWED, "").replace(/\s+/g, " ").trim();
  return cleaned.length > SLUG_MAX_CHARS ? cleaned.slice(0, SLUG_MAX_CHARS).trim() : cleaned;
}

/** 1-indexed track number for a new episode, given how many prior episodes in the same series are `done`. */
/**
 * The file name inside the show folder. ABS's upload MOVES the file onto
 * `<show>/<filename>` without checking for an existing one, so a second
 * episode with the same date and title silently replaced the first
 * (2026-09-02, v1 → v2 of the Spain briefing). The job id makes the name
 * unique per job while a re-publish of the SAME job still overwrites its own file.
 */
export function episodeFilename(date: string, title: string, jobId: string): string {
  return `${date} ${slugifyFilename(title)} [${jobId.slice(0, 8)}].mp3`;
}

export function trackNumberFor(previousDoneCountInSeries: number): number {
  return previousDoneCountInSeries + 1;
}

export interface PublicPodcastJob {
  id: string;
  status: PodcastStatus;
  progress: PodcastJob["progress"];
  title: string | null;
  description: string | null;
  duration_seconds: number | null;
  turns: number | null;
  chapters: { title: string; start_ms: number }[] | null;
  cost_usd: number | null;
  error: string | null;
  abs: { url: string; library_item_id: string; episode_id: string | null } | null;
  series: string;
  minutes: number;
  language: "de" | "en";
  publish: boolean;
  created_at: string;
  updated_at: string;
  links: { audio: string | null; cover: string | null; script: string | null; dossier: string | null; brief: string | null };
  brief: EpisodeBrief | null;
  profile: EpisodeProfile | null;
  brain_note: { path: string; committed: boolean; pushed: boolean } | null;
}

/** Map a job onto its wire shape — snake_case, and never includes `request.source`. */
export function toPublicJob(job: PodcastJob): PublicPodcastJob {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    title: job.title,
    description: job.description,
    duration_seconds: job.durationSeconds,
    turns: job.turns,
    chapters: job.chapters ? job.chapters.map((c) => ({ title: c.title, start_ms: c.startMs })) : null,
    cost_usd: job.costUsd,
    error: job.error,
    abs: job.abs ? { url: job.abs.url, library_item_id: job.abs.libraryItemId, episode_id: job.abs.episodeId } : null,
    series: job.request.series,
    minutes: job.request.minutes,
    language: job.request.language,
    publish: job.request.publish,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    links: {
      audio: job.files.audio ? `/v1/podcasts/${job.id}/audio` : null,
      cover: job.files.cover ? `/v1/podcasts/${job.id}/cover` : null,
      script: job.files.script ? `/v1/podcasts/${job.id}/script` : null,
      dossier: job.files.dossier ? `/v1/podcasts/${job.id}/dossier` : null,
      brief: job.files.brief ? `/v1/podcasts/${job.id}/brief` : null,
    },
    brief: job.brief,
    profile: job.profile,
    brain_note: job.brainNote,
  };
}

/** Persisted script shape — `hosts` is added on top of {@link PodcastScript} so the transcript renderer knows display names. */
export type PersistedPodcastScript = PodcastScript & { hosts: [PodcastHost, PodcastHost] };

/** Render a script as a readable Markdown transcript: title, description, then one `##` heading + `**Name:** text` lines per segment. */
export function renderTranscriptMarkdown(script: PersistedPodcastScript): string {
  const nameById = new Map<string, string>(script.hosts.map((h) => [h.id, h.name] as const));
  const lines: string[] = [`# ${script.title}`, "", script.description, ""];
  for (const segment of script.segments) {
    lines.push(`## ${segment.title}`, "");
    for (const turn of segment.turns) {
      lines.push(`**${nameById.get(turn.speaker) ?? turn.speaker}:** ${turn.text}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const MAX_SOURCE_CHARS = 200_000;
const MIN_MINUTES = 3;
const MAX_MINUTES = 60;

function jobHosts(): [PodcastHost, PodcastHost] {
  return [
    { id: "A", name: config.podcastHostNames[0], voice: config.podcastVoices[0], speed: config.podcastSpeeds[0] },
    { id: "B", name: config.podcastHostNames[1], voice: config.podcastVoices[1], speed: config.podcastSpeeds[1] },
  ];
}

/**
 * The ledger side of the research tools (`podcast-research.ts`'s `EpisodeHistory`
 * port): `recent` reads this series' finished episodes, `transcript` reads a
 * past episode's persisted script synchronously and renders it — null for an
 * unknown, unfinished or unreadable id, never thrown.
 */
function buildEpisodeHistory(store: PodcastStore, series: string): EpisodeHistory {
  return {
    recent: (limit) => store.recentEpisodes(series, limit),
    transcript: (id) => {
      const past = store.get(id);
      if (!past || past.status !== "done" || !past.files.script) return null;
      try {
        const script = JSON.parse(readFileSync(past.files.script, "utf8")) as PersistedPodcastScript;
        return renderTranscriptMarkdown(script);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Run one job's full pipeline end to end, persisting status/progress to the
 * store as it goes so a concurrent GET sees live progress. Wraps the whole
 * run in one request context + root span (mirrors `speech.ts`'s
 * `handleSpeech`) so every `recordUsage` call made along the way — outline,
 * segments, per-turn synth, cover — joins the same `request_id`/trace as this
 * job's id. Never rejects: a failure is recorded on the job and logged, not
 * thrown, so the queue loop always moves on to the next job.
 */
export async function runPodcastJob(job: PodcastJob): Promise<void> {
  const store = getStore();
  const requestStart = Date.now();
  await runWithRequestContext({ requestId: job.id, caller: job.caller }, () =>
    withRootSpan(
      {
        traceId: traceIdFromRequestId(job.id),
        name: "audio.podcast",
        kind: "server",
        attrs: { "audio.request_id": job.id, "audio.caller": job.caller },
      },
      async (span) => {
        try {
          await runPodcastPipeline(job, store, span, requestStart);
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          const current = store.update(job.id, { status: "failed", error: message, progress: null });
          span.setStatus("error", message);
          log.error("podcast.failed", { id: job.id, error: message });
          await notifyPodcastResult({ text: `Podcast-Job ${job.id.slice(0, 8)} ist fehlgeschlagen: ${message}` });
          recordUsage({
            endpoint: "podcast-request",
            model: config.podcastTtsModel,
            status: 500,
            latencyMs: Date.now() - requestStart,
            inputChars: job.request.source.length,
            errorText: message,
            usageJson: { series: job.request.series, title: current.title },
          });
        }
      },
    ),
  );
}

async function runPodcastPipeline(job: PodcastJob, store: PodcastStore, span: Span, requestStart: number): Promise<void> {
  const { request } = job;
  const dir = join(config.podcastDataDir, job.id);
  await mkdir(dir, { recursive: true });
  const hosts = jobHosts();
  const files = { ...job.files };

  // 0. sourcePaths — brain-relative notes read up front and appended to the
  // source; everything downstream (research, editorial, the writers' room)
  // sees the combined text.
  let source = request.source;
  if (request.sourcePaths.length > 0) {
    if (!config.brainDir) throw new Error("podcast job requested sourcePaths but BRAIN_DIR is not configured");
    const notes = await readBrainNotes(config.brainDir, request.sourcePaths);
    for (const note of notes) source += `\n\n## ${note.path}\n${note.text}`;
  }

  const history = buildEpisodeHistory(store, request.series);

  // 1. research — best-effort; a throw here never fails the job (Decision 7).
  store.update(job.id, { status: "scripting", progress: { stage: "research", done: 0, total: 1 } });
  let dossier: Dossier = EMPTY_DOSSIER;
  if (request.research && (config.brainDir || config.researchApiKey)) {
    try {
      dossier = await withSpan("audio.podcast.research", { "audio.podcast.stage": "research" }, () =>
        runPodcastResearch(
          { source, brief: request.brief, title: request.title, language: request.language, series: request.series },
          {
            brainDir: config.brainDir || undefined,
            research: config.researchApiKey
              ? { url: config.researchGatewayUrl, apiKey: config.researchApiKey, maxCalls: config.podcastResearchMaxCalls }
              : undefined,
            history,
            model: config.podcastResearchModel,
            maxRounds: config.podcastToolMaxRounds,
          },
        ),
      );
    } catch (err) {
      log.warn("podcast research failed, proceeding without a dossier", { id: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  files.dossier = join(dir, "dossier.json");
  await writeFile(files.dossier, JSON.stringify(dossier, null, 2), "utf8");
  store.update(job.id, { files: { ...files } });

  // 2. editorial — never throws; a parse/LLM failure yields a neutral default brief.
  store.update(job.id, { progress: { stage: "editorial", done: 0, total: 1 } });
  const showBible = await loadShowBible(config.podcastShowBible);
  const brief = await withSpan("audio.podcast.editorial", { "audio.podcast.stage": "editorial" }, () =>
    decideEpisodeBrief(
      {
        dossier,
        source,
        brief: request.brief,
        title: request.title,
        language: request.language,
        minutes: request.minutes,
        pinMinutes: request.pinMinutes,
        bounds: { minMinutes: MIN_MINUTES, maxMinutes: MAX_MINUTES },
        series: request.series,
        hosts,
        history: store.recentEpisodes(request.series, config.podcastHistoryDepth),
        showBible,
      },
      { model: config.podcastEditorialModel },
    ),
  );
  files.brief = join(dir, "brief.json");
  await writeFile(files.brief, JSON.stringify(brief, null, 2), "utf8");
  store.update(job.id, { brief, files: { ...files } });

  // 3. scripting (outline → segment → review → revise → metadata; progress reported by writePodcastScript's onProgress)
  const script = await writePodcastScript(
    {
      source,
      brief: request.brief,
      title: request.title,
      language: request.language,
      minutes: request.minutes,
      hosts,
      series: request.series,
      dossier,
      episodeBrief: brief,
    },
    {
      models: {
        outline: config.podcastOutlineModel,
        write: config.podcastWriteModel,
        review: config.podcastReviewModels,
        metadata: config.podcastMetadataModel,
      },
      concurrency: 3,
      showBiblePath: config.podcastShowBible,
      onProgress: (stage, done, total) => store.update(job.id, { progress: { stage, done, total } }),
    },
  );

  files.script = join(dir, "script.json");
  const persistedScript: PersistedPodcastScript = { ...script, hosts };
  await writeFile(files.script, JSON.stringify(persistedScript, null, 2), "utf8");
  const profile = buildEpisodeProfile({ brief, script, dossier });
  store.update(job.id, { title: script.title, description: script.description, files: { ...files }, profile });

  // 4. synthesizing
  store.update(job.id, { status: "synthesizing", progress: { stage: "synth", done: 0, total: 0 } });
  const turns = turnsForSynthesis(script.segments, hosts, request.language, {
    denseThreshold: config.podcastDenseTurnThreshold,
    denseSlowdown: config.podcastDenseTurnSlowdown,
  });
  const synthOutputs = await withSpan("audio.podcast.stage", { "audio.podcast.stage": "synth", "audio.podcast.turns": turns.length }, () =>
    synthesizeTurns(turns, {
    model: config.podcastTtsModel,
    concurrency: config.ttsConcurrency,
    stability: config.podcastStability,
    similarityBoost: config.ttsElevenLabsSimilarity,
    style: config.ttsElevenLabsStyle,
    onProgress: (done, total) => store.update(job.id, { progress: { stage: "synth", done, total } }),
    }),
  );

  // 5a. cover (before mastering — it must be embedded in the mp3). A missing
  // cover must never fail the episode, so any error here is swallowed.
  let coverPng: Uint8Array | undefined;
  if (request.cover && coverConfigured()) {
    store.update(job.id, { status: "cover" });
    try {
      coverPng = (await generateCover(script.coverPrompt)).png;
    } catch (err) {
      log.warn("podcast cover generation failed, continuing without cover", {
        id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5b. mastering — first level the two voices against each other (one gain
  // per host), then gap/concat, then the global loudnorm inside masterPodcastMp3.
  store.update(job.id, { status: "mastering" });
  const masterSpan = startSpan("audio.podcast.stage", { "audio.podcast.stage": "master" });
  const levelled = await matchHostLoudness(
    synthOutputs.map((o, i) => ({ ...o, speaker: turns[i]?.speaker ?? "A" })),
    PRE_MASTER_HOST_LUFS,
  );
  log.info("podcast host loudness matched", { id: job.id, gainsDb: levelled.gainsDb });
  const muxTurns = buildMuxTurns({
    synthOutputs: levelled.turns,
    turnTexts: turns.map((t) => t.text),
    gapMs: config.podcastGapMs,
    shortGapMs: config.podcastShortGapMs,
  });
  const mux = concatWithGaps(muxTurns);
  const chapters = chaptersFromSegments(script.segments, mux.turnStartsMs);
  const track = trackNumberFor(countDoneInSeries(store, request.series));
  const today = new Date().toISOString().slice(0, 10);

  const mp3 = await masterPodcastMp3(mux.pcm, mux.sampleRate, {
    chapters,
    tags: {
      title: script.title,
      album: request.series,
      artist: config.podcastAuthor,
      albumArtist: config.podcastAuthor,
      comment: script.description,
      date: today,
      genre: script.genres[0] ?? "Podcast",
      language: request.language === "de" ? "deu" : "eng",
      track,
    },
    cover: coverPng,
    bitrateKbps: config.podcastBitrateKbps,
  });

  masterSpan.setAttributes({ "audio.bytes_out": mp3.byteLength, "audio.audio_seconds": mux.totalMs / 1000 });
  masterSpan.end();

  files.audio = join(dir, "episode.mp3");
  await writeFile(files.audio, mp3);
  if (coverPng) {
    files.cover = join(dir, "cover.png");
    await writeFile(files.cover, coverPng);
  }

  const durationSeconds = Math.round(mux.totalMs / 1000);
  profile.durationSeconds = durationSeconds;
  store.update(job.id, { durationSeconds, turns: turns.length, chapters, files: { ...files }, profile });

  // 6. publishing
  let absResult: PodcastJob["abs"] = null;
  if (request.publish) {
    if (!absConfigured()) {
      log.warn("publish skipped: audiobookshelf not configured", { id: job.id });
    } else {
      store.update(job.id, { status: "publishing" });
      const filename = episodeFilename(today, script.title, job.id);
      const published = await publishToAudiobookshelf({
        series: request.series,
        author: config.podcastAuthor,
        description: config.podcastSeriesDescription,
        language: request.language,
        genres: script.genres,
        episode: { title: script.title, description: script.description, filename, file: mp3 },
        cover: coverPng,
      });
      absResult = { url: published.url, libraryItemId: published.libraryItemId, episodeId: published.episodeId };
    }
  }

  const costUsd = getRequestMeta().costUsd ?? null;
  store.update(job.id, { status: "done", abs: absResult, error: null, progress: null, costUsd });

  const audioSeconds = mux.totalMs / 1000;
  span.setAttributes({
    "audio.podcast.title": script.title,
    "audio.podcast.turns": turns.length,
    "audio.podcast.chapters": chapters.length,
    "audio.audio_seconds": audioSeconds,
    "audio.bytes_out": mp3.byteLength,
    "audio.cost_usd": costUsd ?? undefined,
    "audio.podcast.published": absResult !== null,
    "podcast.format": profile.format,
    "podcast.lead": profile.lead,
    "podcast.humor": profile.humor,
    "podcast.minutes_planned": profile.minutes,
    "podcast.tool_calls": profile.toolCalls,
    "podcast.research_calls": profile.researchCalls,
  });
  log.info("podcast.done", {
    id: job.id,
    title: script.title,
    turns: turns.length,
    chapters: chapters.length,
    durationSeconds,
    costUsd,
    published: absResult !== null,
  });
  await notifyPodcastResult({
    text: podcastDoneMessage({
      title: script.title,
      durationSeconds,
      chapters: chapters.map((c) => c.title),
      absUrl: absResult?.url ?? null,
      costUsd,
      publishRequested: request.publish,
      format: profile.format,
      lead: profile.lead,
      humor: profile.humor,
      hostNames: [hosts[0].name, hosts[1].name],
    }),
  });

  recordUsage({
    endpoint: "podcast-request",
    model: config.podcastTtsModel,
    status: 200,
    latencyMs: Date.now() - requestStart,
    inputChars: source.length,
    audioSeconds,
    bytesOut: mp3.byteLength,
    usageJson: {
      series: request.series,
      title: script.title,
      turns: turns.length,
      chapters: chapters.length,
      published: absResult !== null,
      cost_usd: costUsd,
      format: profile.format,
      lead: profile.lead,
      humor: profile.humor,
      tool_calls: profile.toolCalls,
      research_calls: profile.researchCalls,
    },
  });

  // 7. brain note — best-effort, never fails the job.
  if (config.brainDir && request.brainNote) {
    const brainNoteResult = await writeEpisodeBrainNote({
      brainDir: config.brainDir,
      jobId: job.id,
      title: script.title,
      description: script.description,
      series: request.series,
      createdAt: job.createdAt,
      profile,
      transcriptMarkdown: renderTranscriptMarkdown(persistedScript),
      absItemId: absResult?.libraryItemId ?? null,
    });
    store.update(job.id, { brainNote: brainNoteResult });
    log.info("podcast.brain_note", { id: job.id, path: brainNoteResult.path, committed: brainNoteResult.committed, pushed: brainNoteResult.pushed });
  }
}

/** The Slack line for a finished episode — the listener wants the link, not the JSON. Exported for tests. */
export function podcastDoneMessage(params: {
  title: string;
  durationSeconds: number;
  chapters: string[];
  absUrl: string | null;
  costUsd: number | null;
  publishRequested: boolean;
  format: string;
  lead: EpisodeProfile["lead"];
  humor: string;
  /** [host A name, host B name] — `lead` maps onto one of these. */
  hostNames: [string, string];
}): string {
  const minutes = Math.round(params.durationSeconds / 60);
  const leadLabel = params.lead === "A" ? `${params.hostNames[0]} führt` : params.lead === "B" ? `${params.hostNames[1]} führt` : "ausgeglichen";
  const lines = [
    `Podcast fertig: *${params.title}* (${minutes} min, ${params.chapters.length} Kapitel)`,
    `Format: ${params.format} · ${leadLabel} · ${params.humor}`,
    ...params.chapters.map((c) => `• ${c}`),
    params.absUrl
      ? `Anhören in Audiobookshelf: ${params.absUrl}`
      : params.publishRequested
        ? "Nicht veröffentlicht: Audiobookshelf ist auf diesem Gateway nicht konfiguriert."
        : "Nicht veröffentlicht (nicht angefordert) — die Datei liegt auf dem Gateway.",
    params.costUsd != null ? `ElevenLabs-Kosten: ${params.costUsd.toFixed(2)} USD` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Slack ids look like `C0AS5GUH5U4`; anything else is a channel name to resolve. */
const SLACK_ID_RE = /^[CGD][A-Z0-9]{8,}$/;
let resolvedNotifyChannelId: string | null = null;

/**
 * Turn `config.podcastNotifyChannel` into a channel id via Argo's channel
 * list (`GET /slack/channels` → `[{ id, name }]`), once per process.
 * Exported for tests.
 */
export async function resolveNotifyChannel(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const wanted = config.podcastNotifyChannel.trim().replace(/^#/, "");
  if (!wanted) return null;
  if (SLACK_ID_RE.test(wanted)) return wanted;
  if (resolvedNotifyChannelId) return resolvedNotifyChannelId;
  if (!config.argoBaseUrl) {
    log.warn("podcast notify: channel is a name but no Argo base URL is configured", { channel: wanted });
    return null;
  }
  const res = await fetchImpl(`${config.argoBaseUrl}/slack/channels`, {
    headers: { Authorization: `Bearer ${config.argoApiSecret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Argo channel list failed: HTTP ${res.status}`);
  const channels = (await res.json()) as Array<{ id?: string; name?: string }>;
  const match = channels.find((c) => (c.name ?? "").toLowerCase() === wanted.toLowerCase());
  if (!match?.id) throw new Error(`Argo knows no Slack channel named "${wanted}"`);
  resolvedNotifyChannelId = match.id;
  return match.id;
}

/**
 * Announce a job's outcome in the configured Slack channel via Argo. Best
 * effort: a failed announcement is logged and never fails the job, and
 * nothing happens at all when `PODCAST_NOTIFY_CHANNEL` is unset.
 */
async function notifyPodcastResult(params: { text: string }): Promise<void> {
  if (!config.podcastNotifyChannel) return;
  try {
    const channelId = await resolveNotifyChannel();
    if (!channelId) return;
    const res = await fetch(`${config.argoBaseUrl}/slack/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${config.argoApiSecret}` },
      body: JSON.stringify({ text: params.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn("podcast notify failed", { status: res.status, body: (await res.text()).slice(0, 200) });
  } catch (err) {
    log.warn("podcast notify failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Job ledger is small (a personal show) — scanning the whole thing for a per-series count is simpler than a second query shape. */
function countDoneInSeries(store: PodcastStore, series: string): number {
  return store.list(LEDGER_SCAN_LIMIT).filter((j) => j.status === "done" && j.request.series === series).length;
}

/**
 * Re-publish an already-generated episode: the mp3/cover are still on disk,
 * so this re-runs only stage 4, wrapped in the same trace as the original run
 * (same `job.id`) for correlation. Never throws — a failure is recorded on
 * the job (status `failed`) and returned to the caller as the job's JSON, so
 * `POST /publish` can simply be retried.
 */
async function runPublishStage(job: PodcastJob): Promise<PodcastJob> {
  const store = getStore();
  await runWithRequestContext({ requestId: job.id, caller: job.caller }, () =>
    withRootSpan(
      {
        traceId: traceIdFromRequestId(job.id),
        name: "audio.podcast",
        kind: "server",
        attrs: { "audio.request_id": job.id, "audio.caller": job.caller, "audio.podcast.republish": true },
      },
      async (span) => {
        try {
          store.update(job.id, { status: "publishing" });
          const audioPath = job.files.audio;
          if (!audioPath) throw new Error("podcast job has no audio to publish");
          const mp3 = await readFile(audioPath);
          const cover = job.files.cover ? await readFile(job.files.cover) : undefined;
          const genres = await readPersistedGenres(job.files.script);
          const title = job.title ?? job.request.title ?? job.request.series;
          const description = job.description ?? "";
          const today = new Date().toISOString().slice(0, 10);
          const filename = episodeFilename(today, title, job.id);

          const published = await publishToAudiobookshelf({
            series: job.request.series,
            author: config.podcastAuthor,
            description: config.podcastSeriesDescription,
            language: job.request.language,
            genres,
            episode: { title, description, filename, file: mp3 },
            cover,
          });

          store.update(job.id, {
            status: "done",
            error: null,
            abs: { url: published.url, libraryItemId: published.libraryItemId, episodeId: published.episodeId },
          });
          log.info("podcast.published", { id: job.id, url: published.url });
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          store.update(job.id, { status: "failed", error: message });
          span.setStatus("error", message);
          log.error("podcast.publish.failed", { id: job.id, error: message });
        }
      },
    ),
  );
  return store.get(job.id) ?? job;
}

async function readPersistedGenres(scriptPath: string | null): Promise<string[]> {
  if (!scriptPath) return [];
  try {
    const raw = await readFile(scriptPath, "utf8");
    return (JSON.parse(raw) as { genres?: string[] }).genres ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Queue — strictly one job's pipeline runs at a time.
// ---------------------------------------------------------------------------

const queue: string[] = [];
let processingQueue = false;
/** Job ids currently mid-pipeline — generation (via `processQueue`) and a republish/delete guard share this set, so a republish of one job never clobbers a concurrently-generating other job (each id is claimed independently). */
const activeJobIds = new Set<string>();

/** Claim `id` as active. Returns false (no-op) if it's already claimed. */
function claimJob(id: string): boolean {
  if (activeJobIds.has(id)) return false;
  activeJobIds.add(id);
  return true;
}

function releaseJob(id: string): void {
  activeJobIds.delete(id);
}

/** Whether any job (generation or republish) is currently running — the graceful-shutdown drain treats this like an in-flight request. */
export function podcastRunning(): boolean {
  return activeJobIds.size > 0;
}

function enqueue(id: string): void {
  queue.push(id);
  void processQueue().catch((err) => {
    log.error("podcast queue crashed", { error: err instanceof Error ? err.message : String(err) });
  });
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  try {
    let id: string | undefined;
    while ((id = queue.shift())) {
      const job = getStore().get(id);
      if (!job) continue;
      if (!claimJob(id)) continue;
      try {
        getStore().update(id, { runner: RUNNER_ID });
        await runPodcastJob(job);
      } finally {
        releaseJob(id);
      }
    }
  } finally {
    processingQueue = false;
  }
}

/**
 * At boot, any job left in a non-terminal status was interrupted mid-run by a
 * restart — its partial artifacts are discarded (no resume). Called from
 * `index.ts`'s `import.meta.main` block, before the server starts listening.
 */
/** Identity of this process on the shared ledger — a restarted container keeps its hostname, a rolling-deploy sibling has another. */
const RUNNER_ID = `${hostname()}:${process.pid}`;
/** A live job updates the ledger at every stage and every synthesized turn; this long without a write means its runner is gone. */
const STALE_JOB_MS = 30 * 60 * 1000;
const STALE_SWEEP_MS = 60 * 1000;

/**
 * Boot-time recovery. Only jobs this runner owned (same hostname, i.e. the
 * container restarted) are failed outright — a rolling deploy runs the
 * replacement container next to the old one for a while, and the old one is
 * still working on its job (2026-09-02: the new container marked a job
 * "interrupted by restart" while the old container went on to master and
 * publish it). Jobs owned by another runner, or by nobody (rows from before
 * this field existed), are left alone unless they have gone stale.
 */
export function recoverPodcastJobs(): void {
  const store = getStore();
  for (const job of store.list(LEDGER_SCAN_LIMIT)) {
    if (!NON_TERMINAL_STATUSES.includes(job.status)) continue;
    const ownedHere = job.runner !== null && job.runner.split(":")[0] === RUNNER_ID.split(":")[0];
    if (ownedHere) {
      store.update(job.id, { status: "failed", error: "interrupted by restart", progress: null });
      log.warn("podcast job interrupted by restart", { id: job.id, previousStatus: job.status, runner: job.runner });
      continue;
    }
    if (isStale(job)) {
      failStale(store, job);
      continue;
    }
    log.info("podcast job owned by another runner, leaving it", { id: job.id, status: job.status, runner: job.runner });
  }
}

function isStale(job: PodcastJob): boolean {
  return Date.now() - Date.parse(job.updatedAt) > STALE_JOB_MS;
}

function failStale(store: PodcastStore, job: PodcastJob): void {
  store.update(job.id, { status: "failed", error: `no progress for ${Math.round(STALE_JOB_MS / 60000)} minutes — runner gone`, progress: null });
  log.warn("podcast job stale, marked failed", { id: job.id, previousStatus: job.status, runner: job.runner, updatedAt: job.updatedAt });
}

/** Periodic sweep for jobs whose runner died without a restart of this process (e.g. the old deploy container was killed). */
export function startStaleJobSweep(): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    const store = getStore();
    for (const job of store.list(LEDGER_SCAN_LIMIT)) {
      if (!NON_TERMINAL_STATUSES.includes(job.status) || activeJobIds.has(job.id)) continue;
      if (isStale(job)) failStale(store, job);
    }
  }, STALE_SWEEP_MS);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const PODCAST_PATH_RE = /^(?:\/v1)?(?:\/audio)?\/podcasts(?:\/([^/]+))?(?:\/(audio|cover|script|dossier|brief|publish|retry))?$/;

/** Whether `path` is any podcast route (with or without a `/v1`/`/audio` prefix) — the gate `index.ts` uses to dispatch here. */
export function isPodcastPath(path: string): boolean {
  return PODCAST_PATH_RE.test(path);
}

function errorResponse(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ error: { message, type } }, { status });
}

function notFound(message: string): Response {
  return errorResponse(404, message, "not_found");
}

async function createPodcastJob(req: Request, tokenCaller: string | undefined): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "request body must be valid JSON");
  }

  const sourcePathsRaw = body["sourcePaths"];
  let sourcePaths: string[] = [];
  if (sourcePathsRaw !== undefined) {
    const valid = Array.isArray(sourcePathsRaw) && sourcePathsRaw.length <= 20 && sourcePathsRaw.every((p) => typeof p === "string" && p.trim());
    if (!valid) return errorResponse(400, "sourcePaths must be an array of up to 20 non-blank strings");
    sourcePaths = sourcePathsRaw as string[];
  }

  const source = typeof body["source"] === "string" ? body["source"] : "";
  if (!source.trim() && sourcePaths.length === 0) return errorResponse(400, "source or sourcePaths is required");
  if (source.length > MAX_SOURCE_CHARS) return errorResponse(400, `source exceeds ${MAX_SOURCE_CHARS} characters`);

  const languageRaw = typeof body["language"] === "string" ? body["language"] : "de";
  if (languageRaw !== "de" && languageRaw !== "en") {
    return errorResponse(400, `unsupported language: ${languageRaw} (expected "de" or "en")`);
  }

  const minutesRaw = typeof body["minutes"] === "number" ? body["minutes"] : config.podcastDefaultMinutes;
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutesRaw));
  const seriesRaw = typeof body["series"] === "string" ? body["series"].trim() : "";

  const request: PodcastJobRequest = {
    source,
    sourcePaths,
    brief: typeof body["brief"] === "string" ? body["brief"] : undefined,
    title: typeof body["title"] === "string" ? body["title"] : undefined,
    language: languageRaw,
    minutes,
    series: seriesRaw || config.podcastSeries,
    publish: body["publish"] === true,
    cover: body["cover"] !== false,
    research: body["research"] !== false,
    pinMinutes: body["pinMinutes"] === true,
    brainNote: body["brainNote"] !== false,
  };

  const caller = req.headers.get("x-audio-source") ?? tokenCaller ?? "unknown";
  const job = getStore().create({ caller, request });
  enqueue(job.id);
  return Response.json({ id: job.id, status: job.status }, { status: 202 });
}

function listPodcastJobs(): Response {
  return Response.json({ jobs: getStore().list(50).map(toPublicJob) });
}

function getPodcastJob(id: string): Response {
  const job = getStore().get(id);
  if (!job) return notFound(`podcast job not found: ${id}`);
  return Response.json(toPublicJob(job));
}

/**
 * `Content-Disposition` is a raw HTTP header value — unlike `slugifyFilename`'s
 * multipart-form filename (which the brief allows umlauts/ß in, and which Bun's
 * `FormData` happily UTF-8-encodes in the body), this goes through Bun's strict
 * header-value validator and throws on non-ASCII bytes. Transliterate the
 * common German cases, then drop anything else outside printable ASCII.
 */
function asciiHeaderSafe(name: string): string {
  const transliterated = name
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss");
  return transliterated.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "");
}

function serveFile(path: string | null, notFoundMessage: string, contentType: string, filename: string): Response {
  if (!path) return notFound(notFoundMessage);
  return new Response(Bun.file(path), {
    headers: { "content-type": contentType, "content-disposition": `attachment; filename="${asciiHeaderSafe(filename)}"` },
  });
}

async function servePodcastScript(id: string, format: string | null): Promise<Response> {
  const job = getStore().get(id);
  if (!job?.files.script) return notFound(`no script for podcast job: ${id}`);
  const raw = await readFile(job.files.script, "utf8");
  if (format === "md") {
    const script = JSON.parse(raw) as PersistedPodcastScript;
    return new Response(renderTranscriptMarkdown(script), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return new Response(raw, { headers: { "content-type": "application/json" } });
}

/**
 * Re-queue a failed job as a NEW job with the same request. The source text
 * never leaves the gateway (the API deliberately hides it), so a caller that
 * lost its copy — Hermes after a 20-minute wait — can still retry without
 * re-uploading. Only failed jobs; a running or finished one is not a retry.
 */
function retryPodcast(id: string, tokenCaller: string | undefined): Response {
  const store = getStore();
  const previous = store.get(id);
  if (!previous) return notFound(`no podcast job ${id}`);
  if (previous.status !== "failed") return errorResponse(409, `podcast job is ${previous.status}, only a failed job can be retried`);
  const job = store.create({ caller: tokenCaller ?? previous.caller, request: previous.request });
  enqueue(job.id);
  log.info("podcast job retried", { id: job.id, retryOf: previous.id });
  return Response.json({ id: job.id, status: job.status, retry_of: previous.id }, { status: 202 });
}

async function republishPodcast(id: string): Promise<Response> {
  const job = getStore().get(id);
  if (!job) return notFound(`podcast job not found: ${id}`);
  if (!job.files.audio) return errorResponse(400, "podcast job has no audio to publish");
  if (!claimJob(id)) return errorResponse(409, "podcast job is currently running");

  let updated: PodcastJob;
  try {
    updated = await runPublishStage(job);
  } finally {
    releaseJob(id);
  }
  return Response.json(toPublicJob(updated));
}

async function deletePodcastJob(id: string): Promise<Response> {
  const job = getStore().get(id);
  if (!job) return notFound(`podcast job not found: ${id}`);
  if (activeJobIds.has(id)) return errorResponse(409, "podcast job is currently running");
  getStore().remove(id);
  await rm(join(config.podcastDataDir, id), { recursive: true, force: true });
  return Response.json({ id, deleted: true });
}

/** Serve a small persisted JSON file (dossier.json/brief.json) verbatim, or 404 when the stage never ran / hasn't reached it yet. */
async function serveJsonFile(path: string | null, notFoundMessage: string): Promise<Response> {
  if (!path) return notFound(notFoundMessage);
  const raw = await readFile(path, "utf8");
  return new Response(raw, { headers: { "content-type": "application/json" } });
}

/**
 * Podcast routes — mounted from `index.ts` for any path `isPodcastPath`
 * matches. `tokenCaller` mirrors `handleSpeech`'s parameter: an explicit
 * `x-audio-source` header wins, falling back to a mapped
 * AUDIO_CALLER_TOKENS caller for clients that can't set headers. When
 * `config.podcastEnabled` is off (the VPS instance once the mini owns the
 * pipeline — docs/podcast-editorial-room.md Decision 2), every route 410s.
 */
export async function handlePodcasts(req: Request, path: string, tokenCaller?: string): Promise<Response> {
  if (!config.podcastEnabled) {
    return Response.json({ error: "podcast pipeline moved to the mini instance (podcasts.mini.jkrumm.com)" }, { status: 410 });
  }

  const match = path.match(PODCAST_PATH_RE);
  const id = match?.[1];
  const sub = match?.[2];
  const method = req.method;

  if (method === "POST" && !id) return await createPodcastJob(req, tokenCaller);
  if (method === "GET" && !id) return listPodcastJobs();
  if (method === "GET" && id && !sub) return getPodcastJob(id);
  if (method === "GET" && id && sub === "audio") {
    const job = getStore().get(id);
    return serveFile(job?.files.audio ?? null, `no audio for podcast job: ${id}`, "audio/mpeg", `${slugifyFilename(job?.title ?? id)}.mp3`);
  }
  if (method === "GET" && id && sub === "cover") {
    const job = getStore().get(id);
    return serveFile(job?.files.cover ?? null, `no cover for podcast job: ${id}`, "image/png", "cover.png");
  }
  if (method === "GET" && id && sub === "script") {
    return await servePodcastScript(id, new URL(req.url).searchParams.get("format"));
  }
  if (method === "GET" && id && sub === "dossier") {
    const job = getStore().get(id);
    return await serveJsonFile(job?.files.dossier ?? null, `no dossier for podcast job: ${id}`);
  }
  if (method === "GET" && id && sub === "brief") {
    const job = getStore().get(id);
    return await serveJsonFile(job?.files.brief ?? null, `no brief for podcast job: ${id}`);
  }
  if (method === "POST" && id && sub === "publish") return await republishPodcast(id);
  if (method === "POST" && id && sub === "retry") return retryPodcast(id, tokenCaller);
  if (method === "DELETE" && id && !sub) return await deletePodcastJob(id);

  return notFound(`no route for ${method} ${path}`);
}

// ---------------------------------------------------------------------------
// Test-only seam — lets podcasts.test.ts seed/inspect the module-level store
// directly (mirrors otel.ts's `_test` export) without racing the real
// generation pipeline that a POST enqueues.
// ---------------------------------------------------------------------------
export const _test = { getStore, claimJob, releaseJob, asciiHeaderSafe };
