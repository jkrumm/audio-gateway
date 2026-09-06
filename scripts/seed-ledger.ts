/**
 * seed-ledger — copy the VPS podcast job ledger (SQLite) and its episode
 * artifact directory onto this machine, so the mini's new podcast instance
 * starts with the existing episodes as memory (`past_episodes`/`recentEpisodes`
 * read the same ledger the editorial stage consults). One-shot, run once
 * before the mini instance's first job.
 *
 * `state_json` (src/podcasts.ts's `PodcastJobState`) stores each job's
 * `files.audio|cover|script` as ABSOLUTE paths built from `config.podcastDataDir`
 * (`join(config.podcastDataDir, job.id, …)`). On the VPS that config value is
 * the CONTAINER path `/data/podcasts` (see vps/apps/audio-gateway/compose.yml),
 * bind-mounted from the host's `/var/lib/audio-gateway/podcasts` — so the
 * persisted paths may carry either prefix depending on how they were read.
 * Both are rewritten to this machine's absolute `<repo>/data/podcasts` so the
 * copied episodes resolve locally.
 *
 * Usage: bun scripts/seed-ledger.ts [--force]
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DATA_DIR = resolve(REPO_ROOT, "data");
const DB_PATH = resolve(DATA_DIR, "podcasts.db");
const DB_WAL_PATH = `${DB_PATH}-wal`;
const DB_SHM_PATH = `${DB_PATH}-shm`;
const LOCAL_PODCASTS_DIR = resolve(DATA_DIR, "podcasts");

const REMOTE_DB_GLOB = "vps:/var/lib/audio-gateway/podcasts.db*";
const REMOTE_PODCASTS_DIR = "vps:/var/lib/audio-gateway/podcasts";

/** Old absolute prefixes a `files.*` path may carry, in the persisted JSON. */
const OLD_PREFIXES = ["/var/lib/audio-gateway/podcasts/", "/data/podcasts/"];

function parseArgs(argv: string[]): { force: boolean } {
  return { force: argv.includes("--force") };
}

async function scp(args: string[], description: string): Promise<void> {
  const proc = Bun.spawnSync(["scp", "-q", ...args], { stdout: "inherit", stderr: "inherit" });
  if (!proc.success) throw new Error(`${description} failed (exit ${proc.exitCode})`);
}

/** Rewrite every occurrence of an OLD_PREFIXES entry inside `state_json`'s `files.*` paths. Returns the rewritten JSON and whether anything changed. */
function rewriteStateJson(stateJson: string): { rewritten: string; changed: boolean } {
  const state = JSON.parse(stateJson) as { files?: { audio?: string | null; cover?: string | null; script?: string | null } };
  let changed = false;
  if (state.files) {
    for (const key of ["audio", "cover", "script"] as const) {
      const value = state.files[key];
      if (!value) continue;
      for (const prefix of OLD_PREFIXES) {
        if (value.startsWith(prefix)) {
          state.files[key] = resolve(LOCAL_PODCASTS_DIR, value.slice(prefix.length));
          changed = true;
          break;
        }
      }
    }
  }
  return { rewritten: JSON.stringify(state), changed };
}

async function main(): Promise<void> {
  const { force } = parseArgs(process.argv.slice(2));

  // Checked (and, with --force, removed) together: `existsSync(DB_PATH)` alone
  // missed a leftover WAL/SHM sidecar (replayed into the fresh db on open) and
  // a leftover data/podcasts dir (which turns `scp -r .../podcasts <dest>/`
  // into a nested `<dest>/podcasts/podcasts/`).
  const targets = [DB_PATH, DB_WAL_PATH, DB_SHM_PATH, LOCAL_PODCASTS_DIR];
  const existing = targets.filter((path) => existsSync(path));
  if (existing.length > 0 && !force) {
    console.error(`refusing to run: ${existing.join(", ")} already exist — pass --force to overwrite.`);
    process.exit(1);
  }
  if (existing.length > 0) {
    console.log(`--force: removing ${existing.join(", ")} before copying ...`);
    await Promise.all(existing.map((path) => rm(path, { recursive: true, force: true })));
  }

  await mkdir(DATA_DIR, { recursive: true });

  console.log(`copying ledger from ${REMOTE_DB_GLOB} ...`);
  await scp([REMOTE_DB_GLOB, `${DATA_DIR}/`], "scp podcasts.db");

  console.log(`copying episode artifacts from ${REMOTE_PODCASTS_DIR} ...`);
  await scp(["-r", REMOTE_PODCASTS_DIR, `${DATA_DIR}/`], "scp podcasts/");

  const db = new Database(DB_PATH);
  try {
    const rows = db.query("SELECT id, state_json FROM podcast_job").all() as { id: string; state_json: string }[];
    let rewrittenCount = 0;
    const update = db.query("UPDATE podcast_job SET state_json = ? WHERE id = ?");
    for (const row of rows) {
      const { rewritten, changed } = rewriteStateJson(row.state_json);
      if (changed) {
        update.run(rewritten, row.id);
        rewrittenCount++;
      }
    }
    console.log(`jobs copied: ${rows.length}`);
    console.log(`paths rewritten in: ${rewrittenCount} job(s)`);
  } finally {
    db.close();
  }
}

await main();
