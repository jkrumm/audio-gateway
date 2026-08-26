/**
 * usage:tail — print a readable per-request timeline from the usage DB, for
 * reviewing TTS/STT quality (mode, timings, spoken text) request by request.
 *
 * Dependency-free (Bun built-ins only): reads `usage_record` via bun:sqlite,
 * joins request-summary rows with their chunk/prep/stt siblings on
 * request_id (usage-report.ts), and prints one line per request plus a
 * per-lane/mode rollup footer for the window.
 *
 * Usage:
 *   bun run usage:tail [--db <path>] [--prod] [--since 30m|2h|1d|<ISO>] [--limit N] [--json]
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequestLines, computeRollups, formatLine, formatRollup, parseSince, type UsageDbRow } from "../src/usage-report";

interface Args {
  db: string;
  prod: boolean;
  since: string;
  limit: number;
  json: boolean;
}

const DEFAULTS: Args = { db: "./data/usage.db", prod: false, since: "2h", limit: 30, json: false };

/** Prod source, as deployed by the Dockerfile/compose volume mount. */
const PROD_DB_GLOB = "vps:/var/lib/audio-gateway/usage.db*";

function parseArgs(argv: string[]): Args {
  const args: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--db":
        args.db = argv[++i] ?? args.db;
        break;
      case "--prod":
        args.prod = true;
        break;
      case "--since":
        args.since = argv[++i] ?? args.since;
        break;
      case "--limit": {
        const raw = argv[++i];
        const parsed = raw !== undefined ? Number(raw) : NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid --limit value: ${raw}`);
        args.limit = parsed;
        break;
      }
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

/** scp the prod SQLite file (+ WAL/SHM sidecars) into a temp dir; caller must call `cleanup()`. */
function fetchProdDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "audio-gateway-usage-prod-"));
  const proc = Bun.spawnSync(["scp", "-q", PROD_DB_GLOB, `${dir}/`], { stdout: "inherit", stderr: "inherit" });
  if (!proc.success) throw new Error(`scp from vps failed (exit ${proc.exitCode})`);
  return { path: join(dir, "usage.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2));

  let dbPath = args.db;
  let cleanup: (() => void) | null = null;
  if (args.prod) {
    const prod = fetchProdDb();
    dbPath = prod.path;
    cleanup = prod.cleanup;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const since = parseSince(args.since).toISOString();
    const rows = db
      .query("SELECT * FROM usage_record WHERE ts >= $since ORDER BY ts ASC")
      .all({ $since: since }) as UsageDbRow[];
    db.close();

    // Rollups reflect the whole --since window; --limit only trims how many
    // individual lines get printed (newest last).
    const allLines = buildRequestLines(rows);
    const shown = allLines.slice(-args.limit);
    const rollups = computeRollups(allLines);

    if (args.json) {
      console.log(JSON.stringify({ since, limit: args.limit, lines: shown, rollups }, null, 2));
      return;
    }

    for (const line of shown) console.log(formatLine(line));

    if (rollups.length > 0) {
      console.log("");
      console.log(`— rollup (since ${args.since}, ${allLines.length} request${allLines.length === 1 ? "" : "s"}) —`);
      for (const rollup of rollups) console.log(formatRollup(rollup));
    }
  } finally {
    cleanup?.();
  }
}

main();
