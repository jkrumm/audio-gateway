/**
 * writer-rematch — the fair blind rematch of IU-only podcast writers (Wave 3).
 *
 * The agentic writer (podcast-agent.ts: draft and revision as a lint-measuring tool loop) for every candidate; full production per-segment flow INCLUDING tightening (Wave 2 + Wave 3 prompts, the research dossier, the fresh frozen outline from
 * data/wave3/), for the opening and the interaction segment, voiced with the expressive synth (tags + per-turn delivery). Only the voice
 * owner differs; reviewers are the production panel. One hybrid: the best cheap drafter's draft, Opus only for the revision pass.
 *
 *   secrets-run run --env-file=.env.tpl --env-file=.env.mini.tpl -- bun scripts/writer-rematch.ts [--only id,id] [--no-synth]
 *
 * Resumable (data/wave3/run-<id>.json). Spend: data/wave3/usage.db under the Wave 3 cap ($4, checked before every IU request AND per candidate).
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as inputs from "./lib/bakeoff-inputs";
import { rowCost, SpendLedger } from "./lib/spend";

mkdirSync("./data/wave3/audio", { recursive: true });
process.env["USAGE_DB"] = "./data/wave3/usage.db";
process.env["USAGE_SINK"] = "sqlite";

const { config } = await import("../src/config");
const script = await import("../src/podcast-script");
const { lintSegments, lintNotes, renderLintReport, expressionSummary } = await import("../src/podcast-lint");
const agentMod = await import("../src/podcast-agent");
const { synthesizeSegment } = await import("./lib/bakeoff-synth");
type ScriptSegment = import("../src/podcast-script").ScriptSegment;
type Outline = import("../src/podcast-script").Outline;
type ReviewNote = import("../src/podcast-script").ReviewNote;
type PodcastScriptRequest = import("../src/podcast-script").PodcastScriptRequest;

const ledger = new SpendLedger("./data/wave3/usage.db", Number(process.env["WAVE3_CAP_USD"] ?? 4), 0.25, Number(process.env["WAVE3_PRIOR_USD"] ?? 0.12));
ledger.installFetchGuard([new URL(config.iuBaseUrl).host, new URL(config.iuGeminiBaseUrl).host]);

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined);
const ONLY = flag("--only")?.split(",");
const SKIP_SYNTH = argv.includes("--no-synth");

interface Candidate {
  id: string;
  model: string;
  /** Rough IU spend for two segments incl. revision + tightening, before the first measurement. */
  estimateUsd: number;
}
// Cheap first so the cap can only ever cut the expensive tail; the hybrid last (it reuses a finished draft). Opus agentic is ~$1.4 — the cap decides.
const CANDIDATES: Candidate[] = [
  { id: "claude-haiku-5-5", model: "claude-haiku-5-5", estimateUsd: 0.3 },
  { id: "gpt-6-luna", model: "gpt-6-luna", estimateUsd: 0.15 },
  { id: "gpt-6.1-sol", model: "gpt-6.1-sol", estimateUsd: 0.3 },
  { id: "gemini-4-argon", model: "gemini-4-argon", estimateUsd: 0.35 },
  { id: "gemini-3.8-flash", model: "gemini-3.8-flash", estimateUsd: 0.25 },
  { id: "claude-opus-5-5", model: "claude-opus-5-5", estimateUsd: 1.4 },
  { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", estimateUsd: 0.7 },
];

const countWords = (t: string): number => (t.match(/\S+/g) ?? []).length;
const segWords = (s: ScriptSegment): number => s.turns.reduce((n, t) => n + countWords(t.text), 0);
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
const writeJson = (path: string, v: unknown): Promise<void> => writeFile(path, JSON.stringify(v, null, 2), "utf8");

const hosts: PodcastScriptRequest["hosts"] = [
  { id: "A", name: config.podcastHostNames[0], voice: config.podcastVoices[0], speed: config.podcastSpeeds[0] },
  { id: "B", name: config.podcastHostNames[1], voice: config.podcastVoices[1], speed: config.podcastSpeeds[1] },
];
const base = await inputs.loadRequest({ episodeId: inputs.DEFAULT_EPISODE_ID, hosts });
const req: PodcastScriptRequest = { ...base, dossier: await readJson("./data/wave3/dossier.json"), episodeBrief: await readJson("./data/wave3/brief.json") };
const outline = await readJson<Outline>("./data/wave3/outline.json");
const showBible = await script.loadShowBible(config.podcastShowBible);
const voice = await script.loadVoiceGuide(config.podcastVoicePath);
const total = outline.segments.length;
const lintOpts = { glossaryTerms: req.dossier.glossary.map((g) => g.term), hostNames: hosts.map((h) => h.name), source: req.source };

const dbosHit = outline.segments.map((s, i) => ({ i, hit: i > 0 && /dbos/i.test(`${s.title} ${s.goal} ${s.tension}`) ? s.keyFacts.length : -1 })).filter((x) => x.hit >= 0);
const interaction = dbosHit.length > 0 ? dbosHit.reduce((a, b) => (b.hit > a.hit ? b : a)).i : Math.min(1, total - 1);
const picks = [
  { key: "opening" as const, index: 0 },
  { key: "interaction" as const, index: interaction },
];
const subOutline: Outline = { ...outline, segments: picks.map((p) => outline.segments[p.index]!) };
const sparse = (finals: ScriptSegment[]): ScriptSegment[] => {
  const out: ScriptSegment[] = outline.segments.map((s) => ({ title: s.title, turns: [] }));
  picks.forEach((p, i) => { out[p.index] = finals[i]!; });
  return out;
};
console.log(`outline: ${total} segments; picks ${picks.map((p) => `${p.key}=#${p.index} "${outline.segments[p.index]!.title}" (${outline.segments[p.index]!.targetWords}w)`).join(" | ")}`);

interface CandidateRun {
  id: string;
  model: string;
  hybridDrafter?: string;
  segments: Array<{ key: string; index: number; target: number; draftWords: number; finalWords: number; draft: ScriptSegment; final: ScriptSegment; lintFinal: ReturnType<typeof lintSegments>["findings"]; lintDraftFindings: number; expression: ReturnType<typeof expressionSummary> }>;
  notes: ReviewNote[];
  agentRuns: import("../src/podcast-agent").AgentRun[];
  wallMs: { draft: number; review: number; revise: number };
  cost: { draftUsd: number; writerUsd: number; writerUncachedUsd: number; sharedUsd: number; cacheReadTokens: number; cacheWriteTokens: number };
  projectedWriterUsdPerEpisode: number;
  projectedUncachedUsdPerEpisode: number;
  calls: { writer: number; failed: number; parseFailures: number };
  error?: string;
}

function windowCost(model: string, fromId: number, toId: number): { writerUsd: number; writerUncachedUsd: number; sharedUsd: number; cacheRead: number; cacheWrite: number; calls: number; failed: number } {
  let writerUsd = 0, writerUncachedUsd = 0, sharedUsd = 0, cacheRead = 0, cacheWrite = 0, calls = 0, failed = 0;
  for (const row of ledger.rows(fromId, toId)) {
    if (row.endpoint === "speech") continue;
    const usd = rowCost(row);
    if (row.model.replace(/-eu$/, "") !== model) { sharedUsd += usd; continue; }
    writerUsd += usd;
    const usage = row.usage_json ? (JSON.parse(row.usage_json) as Record<string, unknown>) : {};
    const details = (usage["prompt_tokens_details"] ?? {}) as { cached_tokens?: number };
    cacheRead += Number(usage["cache_read_input_tokens"] ?? details.cached_tokens ?? 0);
    cacheWrite += Number(usage["cache_creation_input_tokens"] ?? 0);
    writerUncachedUsd += rowCost({ ...row, usage_json: null });
    calls++;
    if (row.status >= 400) failed++;
  }
  return { writerUsd, writerUncachedUsd, sharedUsd, cacheRead, cacheWrite, calls, failed };
}

const makeAgent = (model: string, runs: import("../src/podcast-agent").AgentRun[]) =>
  agentMod.createSegmentAgent({ model, reasoningEffort: agentMod.agentReasoningEffort(model), brainDir: config.brainDir || undefined, maxUnitChars: config.podcastMultiSpeakerMaxChars, onRun: (r) => runs.push(r) });

async function draftSegment(model: string, index: number, parseFailures: { n: number }, agent: ReturnType<typeof makeAgent>): Promise<ScriptSegment> {
  const spec = outline.segments[index]!;
  const singleShot = (): Promise<ScriptSegment["turns"]> => script.callAndParse(
    `segment ${index + 1} @${model}`,
    (attempt) =>
      script.callPodcastLlm({
        model,
        systemPrompt: script.segmentPrompt({ req, outline, segment: spec, index, total, previous: outline.segments[index - 1], showBible, voice }),
        userContent: script.buildSegmentUserContent({ req, outline, index }),
        maxCompletionTokens: script.writerBudget(spec.targetWords * 6, attempt),
        stage: "segment",
        usageEndpoint: "podcast-segment",
        cacheableSystemPrefix: script.baseSystemPrompt(req, showBible, voice),
        jsonSchema: script.SEGMENT_TURNS_SCHEMA,
      }),
    (raw) => {
      try {
        return script.sanitizeTurns(script.parseSegmentTurns(raw));
      } catch (err) {
        parseFailures.n++;
        throw err;
      }
    },
  );
  const turns = await agent.draft({ req, outline, index, total, showBible, voice }).catch((err: unknown) => {
    console.warn(`agent draft failed for #${index} @${model}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)} — single-shot fallback`);
    return singleShot();
  });
  return { title: spec.title, turns };
}

async function reviewDrafts(drafts: ScriptSegment[]): Promise<ReviewNote[]> {
  const lint = lintSegments(drafts, lintOpts);
  const raw = await script.reviewEpisode({ req, outline: subOutline, segments: drafts, reviewModels: config.podcastReviewModels, reviewEffort: config.podcastReviewEffort, showBible, lintReport: renderLintReport(lint) });
  const remap = (n: ReviewNote): ReviewNote => ({ ...n, segmentIndex: n.segmentIndex === null ? null : picks[n.segmentIndex]?.index ?? null });
  const lengthRemapped = script.lengthNotes(sparse(drafts), outline).filter((n) => picks.some((p) => p.index === n.segmentIndex));
  const lintRemapped = lintNotes(lint).map(remap);
  return [...raw.map(remap), ...lengthRemapped, ...lintRemapped].filter((n) => n.segmentIndex === null || picks.some((p) => p.index === n.segmentIndex));
}

async function reviseAll(model: string, drafts: ScriptSegment[], notes: ReviewNote[], agent: ReturnType<typeof makeAgent>): Promise<ScriptSegment[]> {
  const revise = (segments: ScriptSegment[], withNotes: ReviewNote[]): Promise<ScriptSegment[]> =>
    script.reviseSegments({ req, outline, segments, notes: withNotes, model, concurrency: 3, showBible, voice, agent });
  let final = sparse(drafts);
  if (notes.some((n) => picks.some((p) => p.index === n.segmentIndex))) final = await revise(final, notes);
  const stillLong = script.lengthNotes(final, outline).filter((n) => picks.some((p) => p.index === n.segmentIndex));
  if (stillLong.length > 0) final = await revise(final, stillLong);
  return picks.map((p) => final[p.index]!);
}

async function runCandidate(cand: Candidate, hybrid?: { drafter: string; drafts: ScriptSegment[]; notes: ReviewNote[]; draftWallMs: number; reviewWallMs: number; draftUsd: number; agentRuns: import("../src/podcast-agent").AgentRun[] }): Promise<CandidateRun> {
  const startId = ledger.maxId();
  const parseFailures = { n: 0 };
  const agentRuns: import("../src/podcast-agent").AgentRun[] = [];
  const agent = makeAgent(cand.model, agentRuns);
  const t0 = Date.now();
  const drafts = hybrid?.drafts ?? (await Promise.all(picks.map((p) => draftSegment(cand.model, p.index, parseFailures, agent))));
  const draftMs = hybrid?.draftWallMs ?? Date.now() - t0;
  const draftEndId = ledger.maxId();

  ledger.guard(0.15);
  const t1 = Date.now();
  const notes = hybrid?.notes ?? (await reviewDrafts(drafts));
  const reviewMs = hybrid?.reviewWallMs ?? Date.now() - t1;
  const reviewEndId = ledger.maxId();

  ledger.guard(cand.model === "claude-opus-5-5" ? 0.6 : 0.2);
  const t2 = Date.now();
  const finals = await reviseAll(cand.model, drafts, notes, agent);
  const reviseMs = Date.now() - t2;
  const endId = ledger.maxId();

  // Cost of the writer's own calls: the drafts (unless borrowed) + the revision/tightening; reviewers are the shared panel.
  const draftWindow = hybrid ? { writerUsd: 0, writerUncachedUsd: 0, sharedUsd: 0, cacheRead: 0, cacheWrite: 0, calls: 0, failed: 0 } : windowCost(cand.model, startId, draftEndId);
  const reviseWindow = windowCost(cand.model, reviewEndId, endId);
  const reviewWindow = windowCost(cand.model, draftEndId, reviewEndId);
  // A hybrid borrows the cheap drafter's draft (and its price); Opus only pays for the revision/tightening.
  const draftUsd = hybrid?.draftUsd ?? draftWindow.writerUsd;
  const writerUsd = draftUsd + reviseWindow.writerUsd;
  const writerUncachedUsd = draftWindow.writerUncachedUsd + reviseWindow.writerUncachedUsd;
  const pickTarget = picks.reduce((n, p) => n + outline.segments[p.index]!.targetWords, 0);
  const totalTarget = outline.segments.reduce((n, s) => n + s.targetWords, 0);
  const scale = totalTarget / pickTarget;
  return {
    id: cand.id,
    model: cand.model,
    ...(hybrid && { hybridDrafter: hybrid.drafter }),
    segments: picks.map((p, i) => {
      const lintFinal = lintSegments([finals[i]!], lintOpts);
      return {
        key: p.key,
        index: p.index,
        target: outline.segments[p.index]!.targetWords,
        draftWords: segWords(drafts[i]!),
        finalWords: segWords(finals[i]!),
        draft: drafts[i]!,
        final: finals[i]!,
        lintFinal: lintFinal.findings,
        lintDraftFindings: lintSegments([drafts[i]!], lintOpts).findings.length,
        expression: expressionSummary(lintFinal),
      };
    }),
    notes,
    agentRuns: [...(hybrid?.agentRuns ?? []), ...agentRuns],
    wallMs: { draft: draftMs, review: reviewMs, revise: reviseMs },
    cost: { draftUsd, writerUsd, writerUncachedUsd, sharedUsd: reviewWindow.sharedUsd + reviseWindow.sharedUsd + draftWindow.sharedUsd, cacheReadTokens: draftWindow.cacheRead + reviseWindow.cacheRead, cacheWriteTokens: draftWindow.cacheWrite + reviseWindow.cacheWrite },
    projectedWriterUsdPerEpisode: writerUsd * scale,
    projectedUncachedUsdPerEpisode: writerUncachedUsd * scale,
    calls: { writer: draftWindow.calls + reviseWindow.calls, failed: draftWindow.failed + reviseWindow.failed, parseFailures: parseFailures.n },
  };
}

// Blind letters, assigned as a candidate finishes and kept — a rerun never re-letters.
const lettersPath = "./data/wave3/letters.json";
const letters: Record<string, string> = existsSync(lettersPath) ? await readJson(lettersPath) : {};
async function letterFor(id: string): Promise<string> {
  if (letters[id]) return letters[id]!;
  const free = "ABCDEFGHIJ".split("").filter((l) => !Object.values(letters).includes(l));
  letters[id] = free[Math.floor(Math.random() * free.length)]!;
  await writeJson(lettersPath, letters);
  return letters[id]!;
}
/** Voice a finished candidate right away, so the cap can never leave a written-but-unheard candidate behind. */
async function synthRun(run: CandidateRun): Promise<void> {
  if (SKIP_SYNTH || run.segments.length !== 2) return;
  const letter = await letterFor(run.id);
  for (const seg of run.segments) {
    const out = `./data/wave3/audio/rematch__${letter}__${seg.key}.mp3`;
    if (existsSync(out)) continue;
    try {
      ledger.guard(0.08);
    } catch (err) {
      console.warn(`synth ${run.id}/${seg.key}: SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    await synthesizeSegment(req, seg.final, out);
    console.log(`synthesized ${run.id} ${seg.key} -> ${out}`);
  }
}

const runs: CandidateRun[] = [];
const cachePath = (id: string): string => `./data/wave3/run-${id}.json`;
for (const cand of CANDIDATES) {
  if (ONLY && !ONLY.includes(cand.id)) continue;
  if (existsSync(cachePath(cand.id))) {
    runs.push(await readJson<CandidateRun>(cachePath(cand.id)));
    console.log(`${cand.id}: cached`);
    continue;
  }
  try {
    ledger.guard(cand.estimateUsd);
  } catch (err) {
    console.warn(`${cand.id}: SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  console.log(`${cand.id}: running (spent $${ledger.spent().toFixed(2)})`);
  try {
    const run = await runCandidate(cand);
    await writeJson(cachePath(cand.id), run);
    runs.push(run);
    await synthRun(run);
    console.log(`${cand.id}: ${run.segments.map((s) => `${s.key} ${s.finalWords}/${s.target}w`).join(", ")} writer $${run.cost.writerUsd.toFixed(3)} (proj $${run.projectedWriterUsdPerEpisode.toFixed(2)}/ep) shared $${run.cost.sharedUsd.toFixed(3)} failed ${run.calls.failed}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${cand.id}: FAILED — ${message.slice(0, 300)}`);
    await writeJson(`./data/wave3/fail-${cand.id}.json`, { error: message });
    runs.push({ id: cand.id, model: cand.model, segments: [], notes: [], agentRuns: [], wallMs: { draft: 0, review: 0, revise: 0 }, cost: { draftUsd: 0, writerUsd: 0, writerUncachedUsd: 0, sharedUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, projectedWriterUsdPerEpisode: 0, projectedUncachedUsdPerEpisode: 0, calls: { writer: 0, failed: 0, parseFailures: 0 }, error: message });
  }
}

// The hybrid: the cheapest decent drafter, then Opus only for the revision + tightening.
const hybridId = "hybrid";
if ((!ONLY || ONLY.includes(hybridId)) && !existsSync(cachePath(hybridId))) {
  const pool = runs.filter((r) => r.id !== "claude-opus-5-5" && r.segments.length === 2 && r.projectedWriterUsdPerEpisode < 0.5);
  const score = (r: CandidateRun): number => r.segments.reduce((n, s) => n + s.lintDraftFindings + 6 * Math.abs(s.draftWords / s.target - 1), 0);
  const best = pool.toSorted((a, b) => score(a) - score(b))[0];
  if (best) {
    try {
      ledger.guard(0.9);
      console.log(`hybrid: drafter ${best.id} (draft score ${score(best).toFixed(1)}), Opus revises`);
      const run = await runCandidate({ id: hybridId, model: "claude-opus-5-5", estimateUsd: 0.9 }, { drafter: best.id, drafts: best.segments.map((s) => s.draft), notes: best.notes, draftWallMs: best.wallMs.draft, reviewWallMs: best.wallMs.review, draftUsd: best.cost.draftUsd, agentRuns: best.agentRuns });
      await writeJson(cachePath(hybridId), run);
      runs.push(run);
      await synthRun(run);
      console.log(`hybrid: ${run.segments.map((s) => `${s.key} ${s.finalWords}/${s.target}w`).join(", ")} writer ≤$${run.cost.writerUsd.toFixed(3)}`);
    } catch (err) {
      console.error(`hybrid: FAILED — ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
    }
  } else {
    console.warn("hybrid: no eligible cheap drafter finished");
  }
} else if (existsSync(cachePath(hybridId))) {
  runs.push(await readJson<CandidateRun>(cachePath(hybridId)));
}

const finished = runs.filter((r) => r.segments.length === 2);
for (const run of finished) await synthRun(run);

await writeJson("./data/wave3/summary.json", {
  episode: inputs.DEFAULT_EPISODE_ID,
  picks,
  spentUsd: ledger.spent(),
  runs: runs.map((r) => ({ id: r.id, letter: letters[r.id], hybridDrafter: r.hybridDrafter, error: r.error, projectedWriterUsdPerEpisode: r.projectedWriterUsdPerEpisode, projectedUncachedUsdPerEpisode: r.projectedUncachedUsdPerEpisode, cost: r.cost, wallMs: r.wallMs, calls: r.calls, agent: { runs: r.agentRuns.length, rounds: r.agentRuns.reduce((n, a) => n + a.rounds, 0), rejections: r.agentRuns.reduce((n, a) => n + a.rejections, 0), fellBack: r.agentRuns.filter((a) => a.fellBack).length }, segments: r.segments.map((s) => ({ key: s.key, words: s.finalWords, target: s.target, lintFindings: s.lintFinal.length, expression: s.expression })) })),
});
console.log(`done. Wave 3 spend (ledger + prior) $${ledger.spent().toFixed(3)} of $${ledger.capUsd}`);
