/**
 * wave3-publish — put the Wave 3 blind questions on modelpick's /tts: copies the mp3s into modelpick's data/tts-compare/audio and
 * appends their samples to manifest.json (idempotent: a sample id is replaced, never duplicated).
 *
 *   bun scripts/wave3-publish.ts expression|rematch [--modelpick ~/SourceRoot/modelpick]
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const mode = process.argv[2];
const mpFlag = process.argv.indexOf("--modelpick");
const MODELPICK = mpFlag >= 0 ? process.argv[mpFlag + 1]! : `${process.env["HOME"]}/SourceRoot/modelpick`;
const DIR = join(MODELPICK, "data", "tts-compare");
const AUDIO = join(DIR, "audio");
mkdirSync(AUDIO, { recursive: true });
const manifestPath = join(DIR, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { generated_at: string; texts: Record<string, string>; samples: Array<Record<string, unknown>> };
const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf8")) as T;

const duration = (file: string): number => {
  const out = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Math.round(Number(new TextDecoder().decode(out.stdout).trim()) * 10) / 10;
};
const countWords = (t: string): number => (t.match(/\S+/g) ?? []).length;
type Turn = { speaker: "A" | "B"; text: string; delivery?: string };
const render = (turns: Turn[], names: [string, string]): string => turns.map((t) => `${t.speaker === "A" ? names[0] : names[1]}: ${t.text}${t.delivery ? `  {${t.delivery}}` : ""}`).join("\n");
const NAMES: [string, string] = ["Jonas", "Lena"];

function add(sample: Record<string, unknown>, source: string): void {
  const file = `${sample["id"]}.mp3`;
  copyFileSync(source, join(AUDIO, file));
  const entry: Record<string, unknown> = {
    model: "gemini-3.8-flash-tts", voice: "Charon + Erinome", gender: "mixed", file, latency_ms: null, first_audio_ms: null,
    cost_usd: null, cost_per_min: null, cost_source: "n/a", verbatim: null, diff: "", streaming: "", aa_rank: null,
    duration_s: duration(source), ...sample,
  };
  const at = manifest.samples.findIndex((s) => s["id"] === entry["id"]);
  if (at >= 0) manifest.samples[at] = entry;
  else manifest.samples.push(entry);
}

if (mode === "expression") {
  const lettersPath = "./data/wave3/expression-letters.json";
  // Letters are shuffled per row once and kept, so a re-publish never changes which audio is which.
  let letters: Record<string, Record<string, string>> = existsSync(lettersPath) ? await readJson(lettersPath) : {};
  const shuffle = (xs: string[]): string[] => xs.toSorted(() => Math.random() - 0.5);
  const versions = {
    podcast: ["a", "b", "c"],
    briefing: ["a", "c"],
    chat: ["a", "c"],
  } as const;
  const label: Record<string, string> = { a: "Flat — constant style, no tags (as today)", b: "Tags only — a few well-placed pauses and reactions", c: "Tags + per-turn delivery" };
  if (Object.keys(letters).length === 0) {
    letters = Object.fromEntries(Object.entries(versions).map(([row, vs]) => [row, Object.fromEntries(shuffle([...vs]).map((v, i) => [v, ["a", "b", "c"][i]!]))]));
    await writeFile(lettersPath, JSON.stringify(letters, null, 2));
  }
  const podcast = {
    a: await readJson<{ turns: Turn[] }>("./data/wave3/expr-b.json").then((s) => ({ turns: s.turns.map((t) => ({ speaker: t.speaker, text: t.text.replace(/<[^<>\n]{1,24}>\s*/g, "").replace(/\s+/g, " ").trim() })) })),
    b: await readJson<{ turns: Turn[] }>("./data/wave3/expr-b.json"),
    c: await readJson<{ turns: Turn[] }>("./data/wave3/expr-c.json"),
  };
  const files = (row: string, v: string): string => (row === "podcast" ? `./data/wave3/audio/expr__${v}.mp3` : `./data/wave3/audio/${row}__${v === "a" ? (row === "briefing" ? "baseline" : "plain") : row === "briefing" ? "expressive" : "tagged"}.mp3`);
  const briefingPrep = await readJson<{ chunks: Array<{ style: string; text: string }> }>("./data/wave3/briefing-prep.json");
  const text = (row: string, v: string): string => {
    if (row === "podcast") return render(podcast[v as "a" | "b" | "c"].turns, NAMES);
    if (row === "briefing") return v === "a" ? briefingPrep.chunks.map((c) => c.text.replace(/<[^<>\n]{1,24}>\s*/g, "")).join("\n") : briefingPrep.chunks.map((c) => `${c.style ? `{${c.style}} ` : ""}${c.text}`).join("\n");
    return v === "a"
      ? "Klar, das habe ich gemacht. Der Termin ist eingetragen, und ich erinnere dich eine Stunde vorher. Übrigens: Der Zug fällt aus, den du nehmen wolltest. Soll ich dir eine Alternative suchen?"
      : "{warm} Klar, das habe ich gemacht. <short pause> Der Termin ist eingetragen, und ich erinnere dich eine Stunde vorher. Übrigens: <long pause> Der Zug fällt aus, den du nehmen wolltest. <sigh> Soll ich dir eine Alternative suchen?";
  };
  for (const [row, vs] of Object.entries(versions)) {
    for (const v of vs) {
      const letter = letters[row]![v]!;
      const script = text(row, v);
      add(
        { id: `expr__${row}__${letter}`, preset: row, mode: row === "podcast" ? "multi" : row === "briefing" ? "concat" : "single", chars: script.length, set: "expression", writer: { model: label[v]!, script, words: countWords(script), targetWords: countWords(script) } },
        files(row, v),
      );
    }
  }
} else if (mode === "rematch") {
  const letters = await readJson<Record<string, string>>("./data/wave3/letters.json");
  const summary = await readJson<{ runs: Array<{ id: string; letter?: string; hybridDrafter?: string; projectedWriterUsdPerEpisode: number; wallMs: { draft: number; review: number; revise: number }; segments: Array<{ key: string; words: number; target: number; lintFindings: number }> }> }>("./data/wave3/summary.json");
  const OUT_PRICE: Record<string, number> = { "claude-opus-5-5": 20, "claude-sonnet-5-5": 10, "claude-haiku-5-5": 0.5, "gpt-6.1-sol": 10, "gpt-6-luna": 0.5, "gemini-4-argon": 10, "gemini-3.8-flash": 3.75, hybrid: 20 };
  // Owner 2026-10-26: Argon and Opus are too expensive per episode — measured, but not put to the ears.
  const OUT_OF_THE_BLIND = new Set(["gemini-4-argon", "claude-opus-5-5", "hybrid"]);
  for (const run of summary.runs) {
    if (OUT_OF_THE_BLIND.has(run.id)) continue;
    const letter = letters[run.id];
    if (!letter || run.segments.length !== 2) continue;
    const full = await readJson<{ segments: Array<{ key: string; final: { turns: Turn[] } }> }>(`./data/wave3/run-${run.id}.json`);
    for (const seg of full.segments) {
      const source = `./data/wave3/audio/rematch__${letter}__${seg.key}.mp3`;
      if (!existsSync(source)) continue;
      const stats = run.segments.find((s) => s.key === seg.key)!;
      const script = render(seg.final.turns, NAMES);
      add(
        {
          id: `writerrematch__${seg.key}__${letter.toLowerCase()}`, preset: "podcast", mode: "multi", chars: script.length, set: "writer",
          writer: {
            model: run.hybridDrafter ? `hybrid: ${run.hybridDrafter} drafts, claude-opus-5-5 revises` : run.id,
            script, words: stats.words, targetWords: stats.target,
            wallSeconds: Math.round((run.wallMs.draft + run.wallMs.review + run.wallMs.revise) / 1000),
            costUsdPerEpisode: Math.round(run.projectedWriterUsdPerEpisode * 100) / 100,
            outputPricePerM: OUT_PRICE[run.id],
            tagViolations: stats.lintFindings,
          },
        },
        source,
      );
    }
  }
} else {
  console.error("usage: wave3-publish.ts expression|rematch");
  process.exit(2);
}
manifest.generated_at = new Date().toISOString().slice(0, 10);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest now ${manifest.samples.length} samples`);
