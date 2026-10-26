/**
 * wave3-inputs — regenerate the writer-rematch inputs for one finished episode with the PRODUCTION research stage ON:
 * dossier (glossary, prior coverage) -> editor brief -> a fresh frozen outline from the current prompts.
 *
 *   secrets-run run --env-file=.env.tpl --env-file=.env.mini.tpl -- bun scripts/wave3-inputs.ts [--episode <job id>]
 *
 * Writes data/wave3/{dossier,brief,outline}.json. Spend goes to data/wave3/usage.db under the Wave 3 cap ($4, checked before every IU request).
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as inputs from "./lib/bakeoff-inputs";
import { SpendLedger } from "./lib/spend";

mkdirSync("./data/wave3", { recursive: true });
process.env["USAGE_DB"] = "./data/wave3/usage.db";
process.env["USAGE_SINK"] = "sqlite";

const { config } = await import("../src/config");
const script = await import("../src/podcast-script");
const { runPodcastResearch } = await import("../src/podcast-research");
const { decideEpisodeBrief } = await import("../src/podcast-editorial");
const { renderTranscriptMarkdown } = await import("../src/podcasts");
const { resolveReasoningEffort } = await import("../src/model-resolution");

const ledger = new SpendLedger("./data/wave3/usage.db", Number(process.env["WAVE3_CAP_USD"] ?? 4), 0.4, Number(process.env["WAVE3_PRIOR_USD"] ?? 0.12));
ledger.installFetchGuard([new URL(config.iuBaseUrl).host]);

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const episodeId = flag("--episode") ?? inputs.DEFAULT_EPISODE_ID;
const hosts: [import("../src/podcast-script").PodcastHost, import("../src/podcast-script").PodcastHost] = [
  { id: "A", name: config.podcastHostNames[0], voice: config.podcastVoices[0], speed: config.podcastSpeeds[0] },
  { id: "B", name: config.podcastHostNames[1], voice: config.podcastVoices[1], speed: config.podcastSpeeds[1] },
];
const base = await inputs.loadRequest({ episodeId, hosts });
const showBible = await script.loadShowBible(config.podcastShowBible);
const voice = await script.loadVoiceGuide(config.podcastVoicePath);

// Only what existed before the episode — the researcher and the editor must not see its own successors.
const db = new Database("./data/podcasts.db", { readonly: true });
const target = db.query("SELECT created_at FROM podcast_job WHERE id = ?").get(episodeId) as { created_at: string };
const past = db.query("SELECT id, created_at, state_json FROM podcast_job WHERE status = 'done' AND created_at < ? ORDER BY created_at DESC LIMIT 8").all(target.created_at) as Array<{ id: string; created_at: string; state_json: string }>;
db.close();
const summaries = past.map((row) => {
  const state = JSON.parse(row.state_json) as { title?: string; description?: string; profile?: import("../src/podcast-types").EpisodeProfile | null };
  return { id: row.id, createdAt: row.created_at, title: state.title ?? "", description: state.description ?? "", profile: state.profile ?? null };
});
const history = {
  recent: (limit: number) => summaries.slice(0, limit),
  transcript: (id: string): string | null => {
    const path = join("./data/podcasts", id, "script.json");
    if (!existsSync(path)) return null;
    try {
      return renderTranscriptMarkdown(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  },
};

console.log(`research (brain ${config.brainDir ? "on" : "OFF"}, gateway ${config.researchApiKey ? "on" : "OFF"}, max ${config.podcastResearchMaxCalls || "unlimited"} calls)`);
ledger.guard(0.3);
const dossier = await runPodcastResearch(
  { source: base.source, brief: base.brief, title: base.title, language: base.language, series: base.series },
  {
    brainDir: config.brainDir || undefined,
    research: config.researchApiKey ? { url: config.researchGatewayUrl, apiKey: config.researchApiKey, ...(config.podcastResearchMaxCalls > 0 && { maxCalls: config.podcastResearchMaxCalls }) } : undefined,
    history,
    model: config.podcastResearchModel,
    reasoningEffort: resolveReasoningEffort(config.podcastResearchModel, config.podcastResearchEffort),
  },
);
await writeFile("./data/wave3/dossier.json", JSON.stringify(dossier, null, 2));
const byTool = dossier.toolCalls.reduce<Record<string, number>>((m, c) => ({ ...m, [c.tool]: (m[c.tool] ?? 0) + 1 }), {});
console.log(`dossier: glossary ${dossier.glossary.length} terms, additions ${dossier.additions.length}, prior coverage ${dossier.priorCoverage.length}, tool calls ${JSON.stringify(byTool)}`);
console.log(`glossary: ${dossier.glossary.map((g) => g.term).join(", ")}`);

ledger.guard(0.1);
const episodeBrief = await decideEpisodeBrief(
  { dossier, source: base.source, brief: base.brief, title: base.title, language: base.language, minutes: base.minutes, pinMinutes: false, bounds: { minMinutes: 5, maxMinutes: 30 }, series: base.series, hosts, history: summaries, showBible },
  { model: config.podcastEditorialModel, reasoningEffort: resolveReasoningEffort(config.podcastEditorialModel, config.podcastEditorialEffort) },
);
await writeFile("./data/wave3/brief.json", JSON.stringify(episodeBrief, null, 2));
console.log(`brief: ${episodeBrief.format} (${episodeBrief.minutes} min, ${episodeBrief.segments} segments)`);

const req = { ...base, dossier, episodeBrief };
const segmentCount = Math.min(9, Math.max(1, Math.round(episodeBrief.segments)));
const targetWords = Math.round(episodeBrief.minutes * 145);
ledger.guard(0.2);
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
  (raw) => script.normalizeOutlineTargets(script.pruneUnrequestedDevices(script.parseOutline(raw), episodeBrief), targetWords),
);
await writeFile("./data/wave3/outline.json", JSON.stringify(outline, null, 2));
outline.segments.forEach((s, i) => console.log(`  seg ${i}: ${s.title} | ${s.targetWords} words | ${s.keyFacts.length} key facts`));
console.log(`spent so far (Wave 3 ledger + prior): $${ledger.spent().toFixed(3)} of $${ledger.capUsd}`);
