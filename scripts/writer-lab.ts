/**
 * writer-lab — measurements and proofs behind the podcast writer improvements.
 *
 *   secrets-run run --env-file=.env.tpl --env-file=.env.mini.tpl -- bun scripts/writer-lab.ts cache
 *
 * `editor` replays the editorial call on the bake-off material (3 repeats) with the real preceding-episode history; prints each brief's mode/format/devices.
 * `cache`  two sequential Opus segment drafts on the frozen bake-off outline; prints cache write/read tokens and the cost drop.
 * Own usage ledger (data/writer-lab/usage.db), never the production sink. Hard spend cap: LAB_CAP_USD (default 3), checked before every call.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as inputs from "./lib/bakeoff-inputs";

mkdirSync("./data/writer-lab", { recursive: true });
process.env["USAGE_DB"] = "./data/writer-lab/usage.db";
process.env["USAGE_SINK"] = "sqlite";

const { config } = await import("../src/config");
const script = await import("../src/podcast-script");
const { resolveReasoningEffort } = await import("../src/model-resolution");

const CAP_USD = Number(process.env["LAB_CAP_USD"] ?? 3);
if (!Number.isFinite(CAP_USD) || CAP_USD <= 0) throw new Error("LAB_CAP_USD must be a positive number");
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "claude-opus-5-5": { input: 4, cached: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cached: 0.1, output: 10 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
  "deepseek-v4.1-flash": { input: 0.3, cached: 0.06, output: 1.2 },
  "gemini-3.8-flash": { input: 0.75, cached: 0.75, output: 3.75 },
};
const ledger = new Database("./data/writer-lab/usage.db", { create: true });
interface Row { endpoint: string; model: string; input_tokens: number | null; output_tokens: number | null; usage_json: string | null }
const rows = (): Row[] => ledger.query("SELECT endpoint, model, input_tokens, output_tokens, usage_json FROM usage_record ORDER BY id").all() as Row[];
const cachedOf = (r: Row): number => {
  if (!r.usage_json) return 0;
  const u = JSON.parse(r.usage_json) as { cache_read_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  return u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
};
const costOf = (r: Row): number => {
  const p = PRICES[r.model];
  if (!p) return 0;
  const cached = cachedOf(r);
  return (((r.input_tokens ?? 0) - cached) * p.input + cached * p.cached + (r.output_tokens ?? 0) * p.output) / 1e6;
};
const spent = (): number => rows().reduce((n, r) => n + costOf(r), 0);
function guard(estimateUsd: number): void {
  if (spent() + estimateUsd > CAP_USD) throw new Error(`spend cap: $${spent().toFixed(2)} spent + ~$${estimateUsd} would pass $${CAP_USD}`);
}

const hosts = [
  { id: "A", name: config.podcastHostNames[0], voice: config.podcastVoices[0], speed: config.podcastSpeeds[0] },
  { id: "B", name: config.podcastHostNames[1], voice: config.podcastVoices[1], speed: config.podcastSpeeds[1] },
] as const;
const req = await inputs.loadRequest({ episodeId: inputs.DEFAULT_EPISODE_ID, hosts: [hosts[0], hosts[1]] });
const showBible = await script.loadShowBible(config.podcastShowBible);
const voice = await script.loadVoiceGuide(config.podcastVoicePath);

const mode = process.argv[2];
if (mode === "cache") {
  const outline = await inputs.loadFrozenOutline();
  for (const index of [0, 1]) {
    guard(0.5);
    const spec = outline.segments[index]!;
    await script.callPodcastLlm({
      model: "claude-opus-5-5",
      systemPrompt: script.segmentPrompt({ req, outline, segment: spec, index, total: outline.segments.length, previous: outline.segments[index - 1], showBible, voice }),
      userContent: script.buildSegmentUserContent({ req, outline, index }),
      maxCompletionTokens: script.writerBudget(spec.targetWords * 6, 1),
      stage: "segment",
      usageEndpoint: "podcast-segment",
      cacheableSystemPrefix: script.baseSystemPrompt(req, showBible, voice),
    });
  }
  const all = rows();
  all.forEach((r, i) => console.log(`call ${i + 1}: input ${r.input_tokens} (cache read ${cachedOf(r)}) output ${r.output_tokens} -> $${costOf(r).toFixed(4)}`));
  console.log(`spent $${spent().toFixed(3)}`);
} else if (mode === "format") {
  // Sonnet's Wave 1 failure was screenplay text instead of the JSON object; prove output_config.format fixes it on IU.
  const outline = await inputs.loadFrozenOutline();
  const model = process.argv[3] ?? "claude-sonnet-5-5";
  const index = 1;
  guard(0.6);
  const spec = outline.segments[index]!;
  const turns = await script.callAndParse(
    `segment @${model}`,
    (attempt) =>
      script.callPodcastLlm({
        model,
        systemPrompt: script.segmentPrompt({ req, outline, segment: spec, index, total: outline.segments.length, previous: outline.segments[index - 1], showBible, voice }),
        userContent: script.buildSegmentUserContent({ req, outline, index }),
        maxCompletionTokens: script.writerBudget(spec.targetWords * 6, attempt),
        stage: "segment",
        usageEndpoint: "podcast-segment",
        cacheableSystemPrefix: script.baseSystemPrompt(req, showBible, voice),
        jsonSchema: script.SEGMENT_TURNS_SCHEMA,
      }),
    (raw) => script.sanitizeTurns(script.parseSegmentTurns(raw)),
    1,
  );
  console.log(`${model}: ${turns.length} turns, ${turns.filter((t) => t.delivery).length} with delivery, parsed on the first attempt`);
  console.log(`spent $${spent().toFixed(3)}`);
} else if (mode === "editor") {
  const { decideEpisodeBrief } = await import("../src/podcast-editorial");
  const ledgerDb = new Database("./data/podcasts.db", { readonly: true });
  const target = ledgerDb.query("SELECT created_at FROM podcast_job WHERE id = ?").get(inputs.DEFAULT_EPISODE_ID) as { created_at: string };
  const past = ledgerDb.query("SELECT id, created_at, state_json FROM podcast_job WHERE status = 'done' AND created_at < ? ORDER BY created_at DESC LIMIT 8").all(target.created_at) as Array<{ id: string; created_at: string; state_json: string }>;
  ledgerDb.close();
  const history = past.map((row) => {
    const state = JSON.parse(row.state_json) as { title?: string; description?: string; profile?: import("../src/podcast-types").EpisodeProfile | null };
    return { id: row.id, createdAt: row.created_at, title: state.title ?? "", description: state.description ?? "", profile: state.profile ?? null };
  });
  const repeats = Number(process.argv[3] ?? 3);
  for (let i = 0; i < repeats; i++) {
    guard(0.05);
    const brief = await decideEpisodeBrief(
      { dossier: req.dossier, source: req.source, brief: req.brief, title: req.title, language: req.language, minutes: req.minutes, pinMinutes: false, bounds: { minMinutes: 5, maxMinutes: 30 }, series: req.series, hosts: req.hosts, history, showBible },
      { model: config.podcastEditorialModel, reasoningEffort: config.podcastEditorialEffort },
    );
    console.log(`#${i + 1} format: ${brief.format} | ${brief.minutes} min, ${brief.segments} segments\n  rationale: ${brief.rationale}\n  roles A: ${brief.roles.A}\n  roles B: ${brief.roles.B}\n  devices: ${JSON.stringify(brief.devices)}\n  avoid: ${JSON.stringify(brief.avoid)}`);
  }
} else if (mode === "prove") {
  // The improved pipeline end to end on the bake-off material: new editor brief -> new outline -> one segment per writer
  // (draft -> lint -> production reviewers + lint -> revision), voiced. Compared with the bake-off finals by lint metrics.
  const { decideEpisodeBrief } = await import("../src/podcast-editorial");
  const { lintSegments, lintNotes, renderLintReport } = await import("../src/podcast-lint");
  const { synthesizeSegment } = await import("./lib/bakeoff-synth");
  const { writeFile } = await import("node:fs/promises");
  mkdirSync("./data/writer-lab/audio", { recursive: true });

  const ledgerDb = new Database("./data/podcasts.db", { readonly: true });
  const target = ledgerDb.query("SELECT created_at FROM podcast_job WHERE id = ?").get(inputs.DEFAULT_EPISODE_ID) as { created_at: string };
  const past = ledgerDb.query("SELECT id, created_at, state_json FROM podcast_job WHERE status = 'done' AND created_at < ? ORDER BY created_at DESC LIMIT 8").all(target.created_at) as Array<{ id: string; created_at: string; state_json: string }>;
  ledgerDb.close();
  const history = past.map((row) => {
    const state = JSON.parse(row.state_json) as { title?: string; description?: string; profile?: import("../src/podcast-types").EpisodeProfile | null };
    return { id: row.id, createdAt: row.created_at, title: state.title ?? "", description: state.description ?? "", profile: state.profile ?? null };
  });
  guard(0.1);
  const episodeBrief = await decideEpisodeBrief(
    { dossier: req.dossier, source: req.source, brief: req.brief, title: req.title, language: req.language, minutes: req.minutes, pinMinutes: false, bounds: { minMinutes: 5, maxMinutes: 30 }, series: req.series, hosts: req.hosts, history, showBible },
    { model: config.podcastEditorialModel, reasoningEffort: config.podcastEditorialEffort },
  );
  const req2 = { ...req, episodeBrief };
  await writeFile("./data/writer-lab/brief.json", JSON.stringify(episodeBrief, null, 2));
  console.log(`new brief: ${episodeBrief.format} (${episodeBrief.minutes} min, ${episodeBrief.segments} segments)\n  ${episodeBrief.rationale.slice(0, 300)}\n  devices: ${JSON.stringify(episodeBrief.devices)}`);

  const segmentCount = Math.min(9, Math.max(1, Math.round(episodeBrief.segments)));
  const targetWords = Math.round(episodeBrief.minutes * 145);
  guard(0.1);
  const outline = await script.callAndParse(
    "outline",
    (attempt) =>
      script.callPodcastLlm({
        model: config.podcastOutlineModel,
        systemPrompt: script.outlinePrompt(req2, segmentCount, targetWords, showBible, voice),
        userContent: script.buildOutlineUserContent(req2),
        maxCompletionTokens: script.writerBudget(8000, attempt),
        stage: "outline",
        usageEndpoint: "podcast-outline",
        reasoningEffort: resolveReasoningEffort(config.podcastOutlineModel, config.podcastOutlineEffort),
        retryOnTruncation: true,
      }),
    (raw) => script.normalizeOutlineTargets(script.pruneUnrequestedDevices(script.parseOutline(raw), episodeBrief), targetWords),
  );
  await writeFile("./data/writer-lab/outline.json", JSON.stringify(outline, null, 2));
  const pull = (i: number): string => `${outline.segments[i]!.title} | pull: ${outline.segments[i]!.tension}`;
  outline.segments.forEach((_, i) => console.log(`  seg ${i}: ${pull(i)}`));
  const dbosIndexes = outline.segments.map((seg, i) => ({ i, hit: /dbos/i.test(`${seg.title} ${seg.goal} ${seg.tension}`) ? seg.keyFacts.length : -1 })).filter((x) => x.hit >= 0);
  const index = dbosIndexes.length > 0 ? dbosIndexes.reduce((a, b) => (b.hit > a.hit ? b : a)).i : Math.min(1, outline.segments.length - 1);
  const spec = outline.segments[index]!;
  console.log(`proving on seg ${index}: ${spec.title}`);

  const writers = (process.argv[3] ?? "claude-opus-5-5,gpt-6-sol").split(",");
  for (const writer of writers) {
    guard(writer.startsWith("claude") ? 0.8 : 0.3);
    const startRow = rows().length;
    const draftTurns = await script.callAndParse(
      `segment @${writer}`,
      (attempt) =>
        script.callPodcastLlm({
          model: writer,
          systemPrompt: script.segmentPrompt({ req: req2, outline, segment: spec, index, total: outline.segments.length, previous: outline.segments[index - 1], showBible, voice }),
          userContent: script.buildSegmentUserContent({ req: req2, outline, index }),
          maxCompletionTokens: script.writerBudget(spec.targetWords * 6, attempt),
          stage: "segment",
          usageEndpoint: "podcast-segment",
          cacheableSystemPrefix: script.baseSystemPrompt(req2, showBible, voice),
        }),
      (raw) => script.sanitizeTurns(script.parseSegmentTurns(raw)),
    );
    const draft = { title: spec.title, turns: draftTurns };
    const lintOpts = { glossaryTerms: req.dossier.glossary.map((g) => g.term), hostNames: req.hosts.map((h) => h.name), source: req.source };
    const lint = lintSegments([draft], lintOpts);
    const subOutline = { ...outline, segments: [spec] };
    guard(0.2);
    const reviewNotes = await script.reviewEpisode({ req: req2, outline: subOutline, segments: [draft], reviewModels: config.podcastReviewModels, reviewEffort: config.podcastReviewEffort, showBible, lintReport: renderLintReport(lint) });
    const notes = [...reviewNotes, ...script.lengthNotes([draft], subOutline), ...lintNotes(lint)];
    guard(writer.startsWith("claude") ? 0.5 : 0.2);
    let final = [draft];
    if (notes.length > 0) final = await script.reviseSegments({ req: req2, outline: subOutline, segments: [draft], notes, model: writer, concurrency: 1, showBible, voice });
    const after = lintSegments(final, lintOpts);
    const bundle = { writer, brief: episodeBrief.format, segment: spec.title, draft, final: final[0], lintDraft: lint, lintFinal: after, notes: notes.length, spentUsd: rows().slice(startRow).reduce((n, r) => n + costOf(r), 0) };
    await writeFile(`./data/writer-lab/prove-${writer}.json`, JSON.stringify(bundle, null, 2));
    const m = after.metrics[0]!;
    console.log(`${writer}: words ${m.words}/${spec.targetWords} turns ${m.turns} cv ${m.turnLengthCv} max ${m.maxTurnWords} short ${m.shortTurnShare} q ${m.questionTurns.A}/${m.questionTurns.B} echo ${m.echoReactions} findings ${after.findings.length} notes ${notes.length} spent $${bundle.spentUsd.toFixed(3)}`);
    await synthesizeSegment(req2, final[0]!, `./data/writer-lab/audio/${writer}__after.mp3`);
  }
  console.log(`lab spend $${spent().toFixed(3)}`);
} else {
  console.error("usage: writer-lab.ts cache|format [model]|editor [repeats]|prove [writers]");
  process.exit(2);
}
