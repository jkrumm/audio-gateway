/**
 * writer-bakeoff — blind comparison of podcast voice-owner models.
 *
 * Takes one finished episode's request + brief + dossier, freezes ONE outline, then for each
 * candidate runs the production per-segment flow (draft → reviewer panel → the candidate's own
 * revision/tightening) for two segments (the opening and the segment with the most host
 * interaction), synthesizes both with the production Gemini multi-speaker path and records
 * words, wall time, tokens, list-price cost and tag violations. Everything is cached under
 * data/writer-bakeoff/ so a rerun skips finished work.
 *
 * Run (never against a running podcast job's instance — this is a separate process):
 *   secrets-run run --env-file=.env.tpl --env-file=.env.mini.tpl -- bun scripts/writer-bakeoff.ts [--only id,id] [--no-synth] [--episode <job id>]
 * Grok is not on IU: set OPENROUTER_API_KEY (op://common/openrouter/API_KEY) to include it; the route is
 * swapped in around the writer calls only (the reviewers always stay on IU).
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = "./data/writer-bakeoff";
const USAGE_DB = join(DATA_DIR, "usage.db");
mkdirSync(join(DATA_DIR, "audio"), { recursive: true });
// A private usage ledger: the bake-off must never write into the production usage sink or push to Argo.
process.env["USAGE_DB"] = USAGE_DB;
process.env["USAGE_SINK"] = "sqlite";

const { config } = await import("../src/config");
const { SPEECH_TAGS, TAG_PATTERN } = await import("../src/gemini-tts-core");
const script = await import("../src/podcast-script");
import * as inputs from "./lib/bakeoff-inputs";
import { synthesizeSegment } from "./lib/bakeoff-synth";
const { resolveReasoningEffort } = await import("../src/model-resolution");
type Outline = import("../src/podcast-script").Outline;
type ScriptSegment = import("../src/podcast-script").ScriptSegment;
type ReviewNote = import("../src/podcast-script").ReviewNote;
type PodcastScriptRequest = import("../src/podcast-script").PodcastScriptRequest;

// ---------------------------------------------------------------------------
// Candidates and list prices (USD per 1M tokens, short-context tier, researched 2026-10-25)
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  /** Model id on the wire. */
  model: string;
  route: "iu" | "openrouter";
  input: number;
  output: number;
  priceSource: string;
}

const CANDIDATES: Candidate[] = [
  { id: "claude-opus-5-5", model: "claude-opus-5-5", route: "iu", input: 4, output: 20, priceSource: "platform.claude.com/docs/en/about-claude/pricing" },
  { id: "deepseek-v4.1-flash", model: "deepseek-v4.1-flash", route: "iu", input: 0.3, output: 1.2, priceSource: "api-docs.deepseek.com/quick_start/pricing (peak rate)" },
  { id: "claude-haiku-5-5", model: "claude-haiku-5-5", route: "iu", input: 0.1, output: 0.5, priceSource: "platform.claude.com/docs/en/about-claude/pricing (≤100k prompt)" },
  { id: "glm-5.3", model: "glm-5.3", route: "iu", input: 1.4, output: 4.4, priceSource: "docs.z.ai/guides/overview/pricing" },
  { id: "grok-4.7", model: "x-ai/grok-4.7", route: "openrouter", input: 2, output: 6, priceSource: "openrouter.ai/x-ai/grok-4.7" },
  { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", route: "iu", input: 2, output: 10, priceSource: "platform.claude.com/docs/en/about-claude/pricing" },
  { id: "gpt-6-sol", model: "gpt-6-sol", route: "iu", input: 2, output: 10, priceSource: "developers.openai.com/api/docs/models/gpt-6-sol" },
  { id: "kimi-k3", model: "kimi-k3", route: "iu", input: 0.202, output: 16, priceSource: "openrouter.ai/moonshotai/kimi-k3 (Moonshot's own table unreadable)" },
];

/** Prices for the shared roles (outline, reviewers) — cost bookkeeping only. */
const SHARED_PRICES: Record<string, [number, number]> = {
  "deepseek-v4.1-flash": [0.3, 1.2],
  "gemini-3.8-flash": [0.75, 3.75],
};

const IU_CAP_USD = 4;
const OPENROUTER_CAP_USD = 0.5;
const WORDS_PER_MINUTE = 145;

// ---------------------------------------------------------------------------
// Args and small helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EPISODE_ID = flag("--episode") ?? inputs.DEFAULT_EPISODE_ID;
const ONLY = flag("--only")?.split(",");
const SKIP_SYNTH = argv.includes("--no-synth");

const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;
const segWords = (seg: ScriptSegment): number => seg.turns.reduce((n, t) => n + countWords(t.text), 0);
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
const writeJson = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value, null, 2), "utf8");

// ---------------------------------------------------------------------------
// Usage ledger → tokens and cost per window
// ---------------------------------------------------------------------------

const usageDb = new Database(USAGE_DB, { create: true });
interface UsageRow { id: number; endpoint: string; model: string; status: number; latency_ms: number; input_tokens: number | null; output_tokens: number | null }
const maxUsageId = (): number => (usageDb.query("SELECT COALESCE(MAX(id), 0) AS m FROM usage_record").get() as { m: number }).m;
const usageSince = (afterId: number, untilId: number): UsageRow[] =>
  usageDb.query("SELECT id, endpoint, model, status, latency_ms, input_tokens, output_tokens FROM usage_record WHERE id > ? AND id <= ?").all(afterId, untilId) as UsageRow[];

function priceOf(model: string): [number, number] | undefined {
  const cand = CANDIDATES.find((c) => c.model === model);
  return cand ? [cand.input, cand.output] : SHARED_PRICES[model];
}

function costOf(rows: UsageRow[]): { usd: number; inputTokens: number; outputTokens: number } {
  let usd = 0, inputTokens = 0, outputTokens = 0;
  for (const r of rows) {
    const p = priceOf(r.model);
    inputTokens += r.input_tokens ?? 0;
    outputTokens += r.output_tokens ?? 0;
    if (p) usd += ((r.input_tokens ?? 0) * p[0] + (r.output_tokens ?? 0) * p[1]) / 1e6;
  }
  return { usd, inputTokens, outputTokens };
}

/** Total list-price spend per route recorded so far (the cap check). */
function spend(): { iu: number; openrouter: number } {
  const rows = usageSince(0, maxUsageId());
  const or = rows.filter((r) => r.model.startsWith("x-ai/"));
  return { iu: costOf(rows.filter((r) => !r.model.startsWith("x-ai/"))).usd, openrouter: costOf(or).usd };
}

// ---------------------------------------------------------------------------
// OpenRouter route — script-local: swap the IU base URL/key around writer calls only
// ---------------------------------------------------------------------------

const mutableConfig = config as unknown as { iuBaseUrl: string; iuApiKey: string };
const iuRoute = { baseUrl: mutableConfig.iuBaseUrl, apiKey: mutableConfig.iuApiKey };

async function onRoute<T>(route: Candidate["route"], fn: () => Promise<T>): Promise<T> {
  if (route === "iu") return fn();
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  mutableConfig.iuBaseUrl = "https://openrouter.ai/api/v1";
  mutableConfig.iuApiKey = key;
  try {
    return await fn();
  } finally {
    mutableConfig.iuBaseUrl = iuRoute.baseUrl;
    mutableConfig.iuApiKey = iuRoute.apiKey;
  }
}

// ---------------------------------------------------------------------------
// Episode inputs and the frozen outline
// ---------------------------------------------------------------------------

const loadRequest = (): Promise<PodcastScriptRequest> =>
  inputs.loadRequest({
    episodeId: EPISODE_ID,
    hosts: [
      { id: "A", name: config.podcastHostNames[0], voice: config.podcastVoices[0], speed: config.podcastSpeeds[0] },
      { id: "B", name: config.podcastHostNames[1], voice: config.podcastVoices[1], speed: config.podcastSpeeds[1] },
    ],
  });

async function frozenOutline(req: PodcastScriptRequest, showBible: string, voice: string): Promise<Outline> {
  const path = join(DATA_DIR, "outline.json");
  if (existsSync(path)) return readJson<Outline>(path);
  const segmentCount = Math.min(9, Math.max(1, Math.round(req.episodeBrief.segments)));
  const targetWords = Math.round(req.episodeBrief.minutes * WORDS_PER_MINUTE);
  const outline = await script.callAndParse(
    "outline",
    (attempt) =>
      script.callPodcastLlm({
        model: config.podcastOutlineModel,
        systemPrompt: script.outlinePrompt(req, segmentCount, targetWords, showBible, voice),
        userContent: script.buildOutlineUserContent(req),
        maxCompletionTokens: script.writerBudget(8000, attempt),
        stage: "outline",
        usageEndpoint: "podcast-outline",
        reasoningEffort: resolveReasoningEffort(config.podcastOutlineModel, config.podcastOutlineEffort),
        retryOnTruncation: true,
      }),
    (raw) => script.normalizeOutlineTargets(script.pruneUnrequestedDevices(script.parseOutline(raw), req.episodeBrief), targetWords),
  );
  await writeJson(path, outline);
  return outline;
}

/** The segment with the most host friction: the one whose tension/goal names the open disagreement, else the most digression/reveal-laden. */
function interactionIndex(outline: Outline, req: PodcastScriptRequest): number {
  const candidates = outline.segments.map((_, i) => i).filter((i) => i > 0);
  const disagree = /(streit|disagree|dbos|gegen|versus|vs\.?|opponent|dagegen)/i;
  const score = (i: number): number => {
    const s = outline.segments[i]!;
    return (disagree.test(`${s.tension} ${s.goal} ${s.title}`) ? 10 : 0)
      + outline.digressions.filter((d) => d.segmentIndex === i).length * 2
      + outline.reveals.filter((r) => r.segmentIndex === i).length
      + (req.episodeBrief.roles.B.length > 0 ? s.tension.length / 200 : 0);
  };
  return candidates.reduce((best, i) => (score(i) > score(best) ? i : best), candidates[0] ?? 0);
}

// ---------------------------------------------------------------------------
// One candidate: draft → reviewer panel → candidate revision
// ---------------------------------------------------------------------------

interface SegmentRun {
  key: "opening" | "interaction";
  index: number;
  target: number;
  draft: ScriptSegment;
  final: ScriptSegment;
  draftWords: number;
  finalWords: number;
  revised: boolean;
  tagViolationsRaw: number;
  tagViolationsFinal: number;
  parseFailures: number;
}

interface CandidateRun {
  id: string;
  model: string;
  route: string;
  input: number;
  output: number;
  priceSource: string;
  segments: SegmentRun[];
  notes: ReviewNote[];
  timings: { draftMs: number; reviewMs: number; reviseMs: number };
  draftCost: { usd: number; inputTokens: number; outputTokens: number };
  reviseCost: { usd: number; inputTokens: number; outputTokens: number };
  reviewCost: { usd: number; inputTokens: number; outputTokens: number };
  writerCalls: { segment: number; revise: number; failed: number };
  projectedWriterUsdPerEpisode: number;
  errors: string[];
}

const violations = (text: string): number => (text.match(TAG_PATTERN) ?? []).filter((t) => !(SPEECH_TAGS as readonly string[]).includes(t.toLowerCase())).length;

async function runCandidate(params: {
  cand: Candidate;
  req: PodcastScriptRequest;
  outline: Outline;
  picks: Array<{ key: "opening" | "interaction"; index: number }>;
  showBible: string;
  voice: string;
}): Promise<CandidateRun> {
  const { cand, req, outline, picks, showBible, voice } = params;
  const total = outline.segments.length;
  const errors: string[] = [];
  const parseFailures = new Map<number, number>();

  // 1. drafts — the production segment call, the candidate as voice owner
  const draftStartId = maxUsageId();
  const draftT0 = Date.now();
  const drafts = await onRoute(cand.route, () =>
    Promise.all(
          picks.map(async ({ index }) => {
            const spec = outline.segments[index]!;
            const turns = await script.callAndParse(
              `segment ${index + 1} @${cand.id}`,
              (attempt) =>
                script.callPodcastLlm({
                  model: cand.model,
                  systemPrompt: script.segmentPrompt({ req, outline, segment: spec, index, total, previous: outline.segments[index - 1], showBible, voice }),
                  userContent: script.buildSegmentUserContent({ req, outline, index }),
                  maxCompletionTokens: script.writerBudget(spec.targetWords * 6, attempt),
                  stage: "segment",
                  usageEndpoint: "podcast-segment",
                }),
              (raw) => {
                try {
                  const turns = script.parseSegmentTurns(raw);
                  rawViolations.set(index, violations(turns.map((t) => t.text).join(" ")));
                  return script.sanitizeTurns(turns);
                } catch (err) {
                  parseFailures.set(index, (parseFailures.get(index) ?? 0) + 1);
                  throw err;
                }
              },
            );
            return { title: spec.title, turns } satisfies ScriptSegment;
          }),
    ),
  );
  const draftMs = Date.now() - draftT0;
  const draftEndId = maxUsageId();

  // 2. reviewer panel — production roles and models, over the two drafts as a 2-segment episode
  const reviewT0 = Date.now();
  const subOutline: Outline = { ...outline, segments: picks.map((p) => outline.segments[p.index]!) };
  const rawNotes = await script.reviewEpisode({
    req,
    outline: subOutline,
    segments: drafts,
    reviewModels: config.podcastReviewModels,
    reviewEffort: config.podcastReviewEffort,
    showBible,
  });
  const reviewMs = Date.now() - reviewT0;
  const reviewEndId = maxUsageId();
  // Remap sub-episode indices back onto the real outline.
  const remap = (n: ReviewNote): ReviewNote => ({ ...n, segmentIndex: n.segmentIndex === null ? null : picks[n.segmentIndex]?.index ?? null });
  const sparse: ScriptSegment[] = outline.segments.map((s) => ({ title: s.title, turns: [] }));
  picks.forEach((p, i) => { sparse[p.index] = drafts[i]!; });
  const notes = [...rawNotes.map(remap), ...script.lengthNotes(sparse, outline)].filter((n) => n.segmentIndex === null || picks.some((p) => p.index === n.segmentIndex));

  // 3. revision + the tightening pass — the candidate again
  const reviseT0 = Date.now();
  let final = sparse;
  const revise = (segments: ScriptSegment[], withNotes: ReviewNote[]): Promise<ScriptSegment[]> =>
    onRoute(cand.route, () => script.reviseSegments({ req, outline, segments, notes: withNotes, model: cand.model, concurrency: 2, showBible, voice }));
  const pickNotes = (withNotes: ReviewNote[]): ReviewNote[] => withNotes.filter((n) => picks.some((p) => p.index === n.segmentIndex));
  if (pickNotes(notes).length > 0) final = await revise(sparse, notes);
  const stillLong = script.lengthNotes(final, outline);
  if (stillLong.length > 0) final = await revise(final, stillLong);
  const reviseMs = Date.now() - reviseT0;
  const reviseEndId = maxUsageId();

  const draftCost = costOf(usageSince(draftStartId, draftEndId));
  const reviewCost = costOf(usageSince(draftEndId, reviewEndId));
  const reviseCost = costOf(usageSince(reviewEndId, reviseEndId));
  const writerRows = [...usageSince(draftStartId, draftEndId), ...usageSince(reviewEndId, reviseEndId)].filter((r) => r.model === cand.model);
  const segmentCalls = writerRows.filter((r) => r.endpoint === "podcast-segment").length;
  const segments: SegmentRun[] = picks.map((p, i) => {
    const finalSeg = final[p.index]!;
    const text = finalSeg.turns.map((t) => t.text).join(" ");
    return {
      key: p.key,
      index: p.index,
      target: outline.segments[p.index]!.targetWords,
      draft: drafts[i]!,
      final: finalSeg,
      draftWords: segWords(drafts[i]!),
      finalWords: segWords(finalSeg),
      revised: finalSeg.turns !== drafts[i]!.turns,
      tagViolationsRaw: rawViolations.get(p.index) ?? 0,
      tagViolationsFinal: violations(text),
      parseFailures: parseFailures.get(p.index) ?? 0,
    };
  });

  // Projected writer cost per episode: cost per target word, scaled to the whole outline; revisions at the measured share.
  const pickTarget = segments.reduce((n, s) => n + s.target, 0);
  const totalTarget = outline.segments.reduce((n, s) => n + s.targetWords, 0);
  const revisedTarget = segments.filter((s) => s.revised).reduce((n, s) => n + s.target, 0);
  const projected = (draftCost.usd / pickTarget) * totalTarget + (revisedTarget > 0 ? (reviseCost.usd / revisedTarget) * totalTarget * (revisedTarget / pickTarget) : 0);

  return {
    id: cand.id,
    model: cand.model,
    route: cand.route,
    input: cand.input,
    output: cand.output,
    priceSource: cand.priceSource,
    segments,
    notes,
    timings: { draftMs, reviewMs, reviseMs },
    draftCost,
    reviseCost,
    reviewCost,
    writerCalls: { segment: segmentCalls, revise: writerRows.length - segmentCalls, failed: writerRows.filter((r) => r.status >= 400).length },
    projectedWriterUsdPerEpisode: projected,
    errors,
  };
}
const rawViolations = new Map<number, number>();

// ---------------------------------------------------------------------------
// Synthesis — the production Gemini multi-speaker path, one mp3 per segment
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const req = await loadRequest();
const showBible = await script.loadShowBible(config.podcastShowBible);
const voice = await script.loadVoiceGuide(config.podcastVoicePath);
const outline = await frozenOutline(req, showBible, voice);
const picks: Array<{ key: "opening" | "interaction"; index: number }> = [
  { key: "opening", index: 0 },
  { key: "interaction", index: interactionIndex(outline, req) },
];
console.log(`outline frozen: ${outline.segments.length} segments; picks: ${picks.map((p) => `${p.key}=#${p.index} "${outline.segments[p.index]!.title}"`).join(" | ")}`);
await writeJson(join(DATA_DIR, "picks.json"), picks.map((p) => ({ ...p, title: outline.segments[p.index]!.title, targetWords: outline.segments[p.index]!.targetWords })));

const results: CandidateRun[] = [];
for (const cand of CANDIDATES) {
  if (ONLY && !ONLY.includes(cand.id)) continue;
  const cachePath = join(DATA_DIR, `run-${cand.id}.json`);
  let run: CandidateRun;
  if (existsSync(cachePath)) {
    run = await readJson<CandidateRun>(cachePath);
    console.log(`${cand.id}: cached`);
  } else {
    const s = spend();
    const iuLeft = IU_CAP_USD - s.iu;
    // Keep headroom: an expensive writer can add ~$1 for two segments plus revisions.
    const need = cand.output >= 10 ? 1.2 : 0.4;
    if (cand.route === "iu" && iuLeft < need) { console.warn(`${cand.id}: SKIPPED — IU spend $${s.iu.toFixed(2)} of $${IU_CAP_USD}`); continue; }
    if (cand.route === "openrouter" && (!process.env["OPENROUTER_API_KEY"] || OPENROUTER_CAP_USD - s.openrouter < 0.2)) { console.warn(`${cand.id}: SKIPPED — no OpenRouter key or cap reached`); continue; }
    console.log(`${cand.id}: running (IU so far $${s.iu.toFixed(3)}, OpenRouter $${s.openrouter.toFixed(3)})`);
    try {
      run = await runCandidate({ cand, req, outline, picks, showBible, voice });
    } catch (err) {
      console.error(`${cand.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      await writeJson(join(DATA_DIR, `fail-${cand.id}.json`), { error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    await writeJson(cachePath, run);
  }
  if (!SKIP_SYNTH) {
    for (const seg of run.segments) {
      const audio = join(DATA_DIR, "audio", `${cand.id}__${seg.key}.mp3`);
      if (existsSync(audio)) continue;
      await synthesizeSegment(req, seg.final, audio);
      console.log(`${cand.id}: synthesized ${seg.key}`);
    }
  }
  results.push(run);
}

const final = spend();
await writeJson(join(DATA_DIR, "summary.json"), { episode: EPISODE_ID, picks, spendUsd: final, runs: results.map((r) => ({ id: r.id, projectedWriterUsdPerEpisode: r.projectedWriterUsdPerEpisode })) });
console.log(`done. list-price spend: IU $${final.iu.toFixed(3)} / OpenRouter $${final.openrouter.toFixed(3)}`);
