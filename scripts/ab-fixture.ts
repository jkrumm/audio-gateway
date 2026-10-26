/**
 * ab-fixture — compare two finished podcast jobs of the same topic on the Wave 3 lint metrics.
 *
 *   bun scripts/ab-fixture.ts <v1 job id prefix> <v2 job id prefix>
 *
 * Prints a markdown table (meta-hedges, notes-ignorance, host balance, questions, tags, deliveries, humor profile).
 * Both scripts are linted by the CURRENT lint, so the v1 numbers show what the old pipeline would be flagged for today.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

process.env["IU_API_KEY"] ??= "x";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
const { lintSegments, expressionSummary } = await import("../src/podcast-lint");

const dir = (prefix: string): string => {
  const hit = readdirSync("./data/podcasts").find((d) => d.startsWith(prefix));
  if (!hit) throw new Error(`no job directory for ${prefix}`);
  return `./data/podcasts/${hit}`;
};
const readJson = async <T>(path: string): Promise<T | null> => (existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as T) : null);

interface Script { title: string; segments: Array<{ title: string; turns: Array<{ speaker: "A" | "B"; text: string; delivery?: string }> }> }

async function measure(prefix: string): Promise<Record<string, string | number>> {
  const d = dir(prefix);
  const script = await readJson<Script>(`${d}/script.json`);
  if (!script) throw new Error(`${d}/script.json missing`);
  const dossier = await readJson<{ glossary?: Array<{ term: string }> }>(`${d}/dossier.json`);
  const brief = await readJson<{ humor?: string }>(`${d}/brief.json`);
  const report = lintSegments(script.segments, { glossaryTerms: (dossier?.glossary ?? []).map((g) => g.term), hostNames: ["Jonas", "Lena"] });
  const count = (rule: string): number => report.findings.filter((f) => f.rule === rule).length;
  const turns = report.metrics.reduce((n, m) => n + m.turns, 0);
  const words = report.metrics.reduce((n, m) => n + m.words, 0);
  const expr = report.metrics.reduce((n, m) => ({ tags: n.tags + m.tags, deliveries: n.deliveries + m.deliveries }), { tags: 0, deliveries: 0 });
  const qA = report.metrics.reduce((n, m) => n + m.questionTurns.A, 0);
  const qB = report.metrics.reduce((n, m) => n + m.questionTurns.B, 0);
  const aWords = script.segments.flatMap((s) => s.turns).filter((t) => t.speaker === "A").reduce((n, t) => n + (t.text.match(/\S+/g) ?? []).length, 0);
  return {
    job: prefix,
    words,
    turns,
    "meta-hedge": count("meta-hedge"),
    "notes-ignorance": count("notes-ignorance"),
    "host-imbalance": count("host-imbalance"),
    "A word share": `${Math.round((aWords / Math.max(1, words)) * 100)}%`,
    "questions A/B": `${qA}/${qB}`,
    tags: expr.tags,
    deliveries: expr.deliveries,
    "tags per 10 turns": Math.round((expr.tags / Math.max(1, turns)) * 100) / 10,
    "expression findings": Object.values(expressionSummary(report).findings).reduce((n, v) => n + (v ?? 0), 0),
    "all lint findings": report.findings.length,
    "unintroduced terms": count("unintroduced-term"),
    "brief humor": brief?.humor ?? "n/a",
  };
}

const [a, b] = process.argv.slice(2);
if (!a || !b) throw new Error("usage: bun scripts/ab-fixture.ts <v1 id> <v2 id>");
const rows = [await measure(a), await measure(b)];
const keys = Object.keys(rows[0]!);
console.log(`| metric | v1 ${a} | v2 ${b} |\n|-|-|-|`);
for (const k of keys.slice(1)) console.log(`| ${k} | ${rows[0]![k]} | ${rows[1]![k]} |`);
