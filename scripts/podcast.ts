/**
 * podcast — submit notes to the long-form podcast pipeline, watch it run,
 * and pull down the finished episode. A thin HTTP client for `/v1/podcasts`
 * (src/podcasts.ts); dependency-free (Bun built-ins only), mirrors
 * scripts/usage-tail.ts's hand-rolled arg parsing.
 *
 * Usage:
 *   bun run podcast -- --source <file.md|-> [--brief "…"] [--title "…"] [--minutes 20]
 *     [--series "…"] [--language de] [--publish] [--no-cover] [--base-url URL]
 *     [--out DIR] [--json] [--no-wait]
 *   bun run podcast -- status <id> [--base-url URL] [--json]
 *   bun run podcast -- list [--base-url URL] [--json]
 *   bun run podcast -- publish <id> [--base-url URL] [--json]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HELP = `Usage:
  bun run podcast -- --source <file.md|-> [--brief "…"] [--title "…"] [--minutes 20] [--series "…"] [--language de] [--publish] [--no-cover] [--base-url URL] [--out DIR] [--json] [--no-wait]
  bun run podcast -- status <id>
  bun run podcast -- list
  bun run podcast -- publish <id>

Base URL: --base-url, then $PODCAST_BASE_URL, then http://localhost:7714.
Auth: Authorization: Bearer $AUDIO_TOKEN (defaults to "claude-code").`;

// ---------------------------------------------------------------------------
// Wire shape (src/podcasts.ts's PublicPodcastJob) — duplicated on purpose so
// this script stays a plain HTTP client, not an importer of server internals.
// ---------------------------------------------------------------------------

interface PodcastJobPublic {
  id: string;
  status: string;
  progress: { stage: string; done: number; total: number } | null;
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
  language: string;
  publish: boolean;
  created_at: string;
  updated_at: string;
  links: { audio: string | null; cover: string | null; script: string | null };
}

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const POLL_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CreateArgs {
  source: string;
  brief?: string;
  title?: string;
  minutes?: number;
  series?: string;
  language?: "de" | "en";
  publish: boolean;
  cover: boolean;
  baseUrl: string;
  out?: string;
  json: boolean;
  wait: boolean;
}

function defaultBaseUrl(): string {
  return process.env["PODCAST_BASE_URL"] ?? "http://localhost:7714";
}

function parseCreateArgs(argv: string[]): CreateArgs {
  const args: CreateArgs = { source: "", publish: false, cover: true, baseUrl: defaultBaseUrl(), json: false, wait: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--source":
        args.source = argv[++i] ?? "";
        break;
      case "--brief":
        args.brief = argv[++i];
        break;
      case "--title":
        args.title = argv[++i];
        break;
      case "--minutes": {
        const raw = argv[++i];
        const parsed = raw !== undefined ? Number(raw) : NaN;
        if (!Number.isFinite(parsed)) throw new Error(`invalid --minutes value: ${raw}`);
        args.minutes = parsed;
        break;
      }
      case "--series":
        args.series = argv[++i];
        break;
      case "--language": {
        const raw = argv[++i];
        if (raw !== "de" && raw !== "en") throw new Error(`invalid --language value: ${raw} (expected "de" or "en")`);
        args.language = raw;
        break;
      }
      case "--publish":
        args.publish = true;
        break;
      case "--no-cover":
        args.cover = false;
        break;
      case "--base-url":
        args.baseUrl = argv[++i] ?? args.baseUrl;
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--json":
        args.json = true;
        break;
      case "--no-wait":
        args.wait = false;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.source) throw new Error("--source is required");
  return args;
}

/** Shared `--base-url`/`--json` flags for the `status`/`list`/`publish` subcommands, returning the remaining positional args. */
function parseSubcommandFlags(argv: string[]): { baseUrl: string; json: boolean; positional: string[] } {
  let baseUrl = defaultBaseUrl();
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url") {
      baseUrl = argv[++i] ?? baseUrl;
    } else if (arg === "--json") {
      json = true;
    } else {
      positional.push(arg as string);
    }
  }
  return { baseUrl, json, positional };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return { "x-audio-source": "claude-code", authorization: `Bearer ${process.env["AUDIO_TOKEN"] ?? "claude-code"}` };
}

async function apiFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function readSource(source: string): Promise<string> {
  if (source === "-") return await Bun.stdin.text();
  return await Bun.file(source).text();
}

// ---------------------------------------------------------------------------
// Progress + summary rendering
// ---------------------------------------------------------------------------

function formatMmSs(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return "?:??";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function printProgressLine(job: PodcastJobPublic): void {
  const stage = job.progress?.stage ?? job.status;
  const done = job.progress?.done ?? 0;
  const total = job.progress?.total ?? 0;
  const line = `[${job.status}] ${stage} ${done}/${total}`;
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}\x1b[K`);
  } else {
    console.log(line);
  }
}

/** A rolling deploy answers 503 for a few seconds; a job runs for minutes — don't abandon it over one bad poll. */
const POLL_TRANSIENT_MAX = 12;

async function pollUntilDone(baseUrl: string, id: string): Promise<PodcastJobPublic> {
  let transientFailures = 0;
  for (;;) {
    let job: PodcastJobPublic;
    try {
      job = await apiFetch<PodcastJobPublic>(baseUrl, `/v1/podcasts/${id}`);
      transientFailures = 0;
    } catch (err) {
      transientFailures++;
      if (transientFailures > POLL_TRANSIENT_MAX) throw err;
      console.error(`poll failed (${transientFailures}/${POLL_TRANSIENT_MAX}), retrying: ${err instanceof Error ? err.message : String(err)}`);
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }
    printProgressLine(job);
    if (TERMINAL_STATUSES.has(job.status)) {
      if (process.stdout.isTTY) process.stdout.write("\n");
      return job;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function downloadArtifact(baseUrl: string, link: string | null, outDir: string, filename: string): Promise<string | null> {
  if (!link) return null;
  const res = await fetch(`${baseUrl}${link}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`download ${link} failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const path = join(outDir, filename);
  await writeFile(path, bytes);
  return path;
}

async function downloadArtifacts(baseUrl: string, job: PodcastJobPublic, outDir: string): Promise<{ audio: string | null; cover: string | null; script: string | null }> {
  await mkdir(outDir, { recursive: true });
  return {
    audio: await downloadArtifact(baseUrl, job.links.audio, outDir, "episode.mp3"),
    cover: await downloadArtifact(baseUrl, job.links.cover, outDir, "cover.png"),
    script: await downloadArtifact(baseUrl, job.links.script, outDir, "script.json"),
  };
}

function printSummary(job: PodcastJobPublic, paths: { audio: string | null; cover: string | null; script: string | null }): void {
  console.log("");
  console.log(job.title ?? "(untitled)");
  console.log(`duration ${formatMmSs(job.duration_seconds)} · ${job.turns ?? "?"} turns · $${job.cost_usd?.toFixed(2) ?? "?"}`);
  if (job.chapters?.length) {
    console.log("chapters:");
    for (const c of job.chapters) console.log(`  ${formatMmSs(c.start_ms / 1000)}  ${c.title}`);
  }
  if (job.abs) console.log(`audiobookshelf: ${job.abs.url}`);
  if (paths.audio) console.log(`audio:  ${paths.audio}`);
  if (paths.cover) console.log(`cover:  ${paths.cover}`);
  if (paths.script) console.log(`script: ${paths.script}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runCreate(args: CreateArgs): Promise<void> {
  const source = await readSource(args.source);
  const body: Record<string, unknown> = { source, publish: args.publish, cover: args.cover };
  if (args.brief !== undefined) body["brief"] = args.brief;
  if (args.title !== undefined) body["title"] = args.title;
  if (args.minutes !== undefined) body["minutes"] = args.minutes;
  if (args.series !== undefined) body["series"] = args.series;
  if (args.language !== undefined) body["language"] = args.language;

  const created = await apiFetch<{ id: string; status: string }>(args.baseUrl, "/v1/podcasts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(created.id);

  if (!args.wait) {
    if (args.json) console.log(JSON.stringify(created, null, 2));
    return;
  }

  const job = await pollUntilDone(args.baseUrl, created.id);

  if (args.json) {
    console.log(JSON.stringify(job, null, 2));
    if (job.status === "failed") process.exit(1);
    return;
  }

  if (job.status === "failed") {
    console.error(`podcast generation failed: ${job.error}`);
    process.exit(1);
  }

  const outDir = args.out ?? join("./out/podcasts", job.id);
  const paths = await downloadArtifacts(args.baseUrl, job, outDir);
  printSummary(job, paths);
}

async function runStatus(argv: string[]): Promise<void> {
  const { baseUrl, json, positional } = parseSubcommandFlags(argv);
  const id = positional[0];
  if (!id) throw new Error("status requires a job id: bun run podcast -- status <id>");
  const job = await apiFetch<PodcastJobPublic>(baseUrl, `/v1/podcasts/${id}`);
  if (json) {
    console.log(JSON.stringify(job, null, 2));
    return;
  }
  printProgressLine(job);
  console.log("");
  if (job.error) console.log(`error: ${job.error}`);
}

async function runList(argv: string[]): Promise<void> {
  const { baseUrl, json } = parseSubcommandFlags(argv);
  const { jobs } = await apiFetch<{ jobs: PodcastJobPublic[] }>(baseUrl, "/v1/podcasts");
  if (json) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  for (const job of jobs) {
    console.log(`${job.id}  [${job.status}]  ${job.title ?? "(untitled)"}  ${job.created_at}`);
  }
}

async function runPublish(argv: string[]): Promise<void> {
  const { baseUrl, json, positional } = parseSubcommandFlags(argv);
  const id = positional[0];
  if (!id) throw new Error("publish requires a job id: bun run podcast -- publish <id>");
  const job = await apiFetch<PodcastJobPublic>(baseUrl, `/v1/podcasts/${id}/publish`, { method: "POST" });
  if (json) {
    console.log(JSON.stringify(job, null, 2));
    return;
  }
  console.log(`[${job.status}] ${job.title ?? "(untitled)"}`);
  if (job.abs) console.log(`audiobookshelf: ${job.abs.url}`);
  if (job.error) console.log(`error: ${job.error}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  const [command, ...rest] = argv;
  if (command === "status") return await runStatus(rest);
  if (command === "list") return await runList(rest);
  if (command === "publish") return await runPublish(rest);

  await runCreate(parseCreateArgs(argv));
}

await main();
