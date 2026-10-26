import { DELIVERY_KEYS } from "./gemini-tts-core";
import { runToolLoop, usesResponsesTransport, type ToolDef, type ToolLoopFetch } from "./llm-tools";
import { log } from "./log";
import { resolveReasoningEffort } from "./model-resolution";
import { lintSegmentation, lintSegments, TAG_BAND_PER_TEN_TURNS, type LintFinding, type LintOptions } from "./podcast-lint";
import { buildResearchTools } from "./podcast-research";
import {
  buildRevisionUserContent,
  buildSegmentUserContent,
  revisionPrompt,
  sanitizeTurns,
  segmentPrompt,
  writerBudget,
  type Outline,
  type PodcastScriptRequest,
  type ReviewNote,
  type ScriptSegment,
  type ScriptTurn,
} from "./podcast-script";
import { turnsForSynthesis, unitsForMultiSpeaker } from "./podcast-synth";
import type { ToolCallRecord } from "./podcast-types";

// The agentic segment writer: a draft or a revision as a tool loop on `runToolLoop` (llm-tools.ts), so the writer
// can MEASURE its own text before it hands it in — words against the target, rhythm, tags and deliveries, names
// used before they are introduced — and look names up (glossary, brain) instead of guessing. `submit_segment` is
// the only way out: it rejects with the lint findings until they are fixed, or until the model explicitly accepts
// the remaining advisory ones with a reason. Claude runs on the same OpenAI-dialect route as every other model
// (IU serves its tools there, with automatic prompt caching — probed 2026-10-26).

/** Mechanical rules the writer must fix; everything else is advisory and may be accepted with a reason. */
const BLOCKING_RULES = new Set<LintFinding["rule"]>([
  "stock-phrase",
  "monologue",
  "tag-not-allowed",
  "tag-leads-short-turn",
  "tags-adjacent",
  "delivery-unknown",
  "delivery-streak",
  "delivery-short-turn",
  "caps-emphasis",
  "notes-ignorance",
]);
/** A segment more than this over its target is blocking (the length governor's tolerance); under is advisory. */
const OVER_LENGTH = 0.2;
const MIN_REASON_CHARS = 12;

/** The segment writers' interface as `writePodcastScript` and `reviseSegments` see it — implemented here, injected by the orchestrator (podcast-script.ts cannot import this module). */
export interface SegmentAgent {
  draft(params: { req: PodcastScriptRequest; outline: Outline; index: number; total: number; showBible: string; voice: string }): Promise<ScriptTurn[]>;
  revise(params: { req: PodcastScriptRequest; outline: Outline; segments: ScriptSegment[]; index: number; total: number; notes: ReviewNote[]; showBible: string; voice: string }): Promise<ScriptTurn[]>;
}

export interface SegmentAgentOptions {
  model: string;
  /** Already resolved for `model` (Claude takes "high" on the OpenAI route; unknown families omit it). */
  reasoningEffort?: string;
  /** Brain vault root for `brain_search`/`brain_read`; empty → those tools are absent. */
  brainDir?: string;
  /** Multi-speaker request ceiling, to report the synth unit size (config.podcastMultiSpeakerMaxChars). */
  maxUnitChars: number;
  /** Test seam. */
  fetchImpl?: ToolLoopFetch;
  /** Reports each finished loop (rounds, tool calls, rejections) — the harnesses record it. */
  onRun?: (run: AgentRun) => void;
}

export interface AgentRun {
  mode: "draft" | "revise";
  index: number;
  rounds: number;
  calls: ToolCallRecord[];
  submits: number;
  rejections: number;
  accepted: Array<{ rule: string; reason: string }>;
  /** True when the loop ended without an accepted submit and the last measured draft was used. */
  fellBack: boolean;
}

const TURNS_SCHEMA = {
  type: "array",
  description: "The segment's turns, in order.",
  items: {
    type: "object",
    properties: {
      speaker: { type: "string", enum: ["A", "B"] },
      text: { type: "string" },
      delivery: { type: "string", enum: DELIVERY_KEYS, description: "Optional: only where the moment changes. Omit on a baseline turn." },
    },
    required: ["speaker", "text"],
  },
} as const;

const agentAddendum = (hasBrain: boolean): string => `

HOW YOU WORK IN THIS SESSION — you are not limited to one shot. You have tools, and you deliver by tool call, not by replying with JSON:
1. Write the segment (or revise it), then call lint_segment with your turns. It measures the text: words against the target, turn lengths, questions, inline tags and deliveries per ten turns, the synth request size, and flags stock phrases, lectures, misused tags/deliveries and names used before they are introduced.
2. Fix what it reports and measure again. Look up a name with glossary_lookup (the research dossier)${hasBrain ? " or brain_search/brain_read (the listener's notes)" : ""} before you explain it — never guess what something is.
3. Finish by calling submit_segment with the final turns. It re-checks the text: BLOCKING findings are rejected until fixed; ADVISORY findings are rejected once, and you may resubmit with acceptAdvisory (rule + a concrete reason) when a finding is wrong for this segment. submit_segment is the only way to finish; the text of your last message is ignored.
The JSON output format described above is the shape of submit_segment's "turns" argument — do not print it.`;

const countWords = (text: string): number => (text.replace(/<[^<>\n]{1,24}>/g, " ").match(/\S+/g) ?? []).length;

/** Parse the `turns` argument of lint_segment/submit_segment; throws a message the model can act on. */
function turnsFromArgs(args: unknown): ScriptTurn[] {
  const raw = (args as { turns?: unknown } | null)?.turns;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('"turns" must be a non-empty array of {speaker, text, delivery?}');
  const turns: ScriptTurn[] = [];
  raw.forEach((item, i) => {
    const t = (item ?? {}) as Record<string, unknown>;
    const speaker = typeof t["speaker"] === "string" ? t["speaker"].trim().toUpperCase() : "";
    const text = typeof t["text"] === "string" ? t["text"].trim() : "";
    if (speaker !== "A" && speaker !== "B") throw new Error(`turn ${i}: speaker must be "A" or "B"`);
    if (!text) throw new Error(`turn ${i}: empty text`);
    const delivery = typeof t["delivery"] === "string" ? t["delivery"].trim().toLowerCase() : "";
    turns.push({ speaker, text, ...(delivery && { delivery }) });
  });
  return turns;
}

interface Measured {
  turns: ScriptTurn[];
  report: string;
  blocking: LintFinding[];
  advisory: Array<{ rule: string; text: string }>;
}

/** Measure a draft the way the pipeline will: sanitize, lint with the episode's own glossary, length against the target, synth segmentation. */
function measure(params: { turns: ScriptTurn[]; title: string; target: number; req: PodcastScriptRequest; lintOpts: LintOptions; maxUnitChars: number }): Measured {
  const { title, target, req, lintOpts, maxUnitChars } = params;
  const turns = sanitizeTurns(params.turns);
  const segment: ScriptSegment = { title, turns };
  const lint = lintSegments([segment], lintOpts);
  // sanitizeTurns already strips invented tags and tags on short lines, so those two rules only exist on the RAW turns — the writer must be told, not silently corrected.
  const rawFindings = lintSegments([{ title, turns: params.turns }], lintOpts).findings.filter((f) => f.rule === "tag-not-allowed" || f.rule === "tag-leads-short-turn");
  lint.findings.push(...rawFindings);
  const m = lint.metrics[0]!;
  const words = m.words;
  const over = target > 0 ? words / target - 1 : 0;

  const synthTurns = turnsForSynthesis([segment], req.hosts, req.language);
  const units = unitsForMultiSpeaker(synthTurns, [turns.length], maxUnitChars);
  const seg = lintSegmentation({ texts: synthTurns.map((t) => t.text), segmentLengths: [turns.length], units, maxChars: maxUnitChars });

  const blocking = lint.findings.filter((f) => BLOCKING_RULES.has(f.rule));
  const advisoryFindings = lint.findings.filter((f) => !BLOCKING_RULES.has(f.rule));
  const advisory: Measured["advisory"] = advisoryFindings.map((f) => ({ rule: f.rule, text: `turn ${f.turnIndex ?? "—"}: ${f.message}` }));
  const extra: string[] = [];
  const lengthFindings: LintFinding[] = [];
  if (over > OVER_LENGTH) {
    const message = `LENGTH: ${words} words against a target of ${target} (+${Math.round(over * 100)}%) — cut restatements, second examples and warm-up lines; keep every key fact.`;
    extra.push(message);
    lengthFindings.push({ segmentIndex: 0, turnIndex: null, rule: "monologue", message });
  }
  else if (over < -0.3) advisory.push({ rule: "length-under", text: `${words} words against a target of ${target} (${Math.round(over * 100)}%) — fine only if every key fact is spoken.` });
  for (const f of seg.findings) advisory.push({ rule: "segmentation", text: f });

  const perTen = m.turns > 0 ? Math.round((m.tags / m.turns) * 100) / 10 : 0;
  const report = [
    `METRICS: ${words} words (target ${target}, ${over >= 0 ? "+" : ""}${Math.round(over * 100)}%) | ${m.turns} turns, mean ${m.meanTurnWords} words, longest ${m.maxTurnWords}, length CV ${m.turnLengthCv}, ${Math.round(m.shortTurnShare * 100)}% short | questions A/B ${m.questionTurns.A}/${m.questionTurns.B} | tags ${m.tags} (${perTen} per ten turns; band ${TAG_BAND_PER_TEN_TURNS.min}–${TAG_BAND_PER_TEN_TURNS.max}), deliveries ${m.deliveries} | synth: ${seg.units} request(s), largest ${seg.maxChars} chars`,
    blocking.length + extra.length > 0
      ? `BLOCKING (fix before submit):\n${[...blocking.map((f) => `- turn ${f.turnIndex ?? "—"}: ${f.message}`), ...extra.map((e) => `- ${e}`)].join("\n")}`
      : "BLOCKING: none",
    advisory.length > 0 ? `ADVISORY (fix, or accept with a reason on submit):\n${advisory.map((a) => `- [${a.rule}] ${a.text}`).join("\n")}` : "ADVISORY: none",
  ].join("\n");
  return { turns, report, blocking: [...blocking, ...lengthFindings], advisory };
}

function glossaryTool(req: PodcastScriptRequest, hasBrain: boolean): ToolDef {
  return {
    name: "glossary_lookup",
    description: "Look a name or term up in the episode's research dossier (glossary entries and the additions the researcher found). Returns the plain-words handle to use. Use it before you explain a name.",
    parameters: { type: "object", properties: { term: { type: "string" } }, required: ["term"] },
    execute: async (args) => {
      const term = String((args as { term?: unknown }).term ?? "").toLowerCase().trim();
      if (!term) return "error: give a term";
      const glossary = req.dossier.glossary.filter((g) => g.term.toLowerCase().includes(term) || term.includes(g.term.toLowerCase()));
      const additions = req.dossier.additions.filter((a) => a.text.toLowerCase().includes(term)).slice(0, 3);
      if (glossary.length === 0 && additions.length === 0) return `nothing in the dossier for "${term}" — say only what the SOURCE implies${hasBrain ? ", or search the brain" : ""}`;
      return [
        ...glossary.map((g) => `${g.term}: ${g.plain}`),
        ...additions.map((a) => `[${a.source}] ${a.text.slice(0, 600)}`),
      ].join("\n");
    },
  };
}

/** One loop: `mode` draft or revise. Throws when the loop ends with nothing usable; the caller falls back to the single-shot writer. */
async function runAgent(opts: SegmentAgentOptions, params: { mode: "draft" | "revise"; req: PodcastScriptRequest; outline: Outline; index: number; total: number; systemPrompt: string; userContent: string }): Promise<ScriptTurn[]> {
  const { req, outline, index, mode } = params;
  const spec = outline.segments[index];
  if (!spec) throw new Error(`outline segment ${index} out of range`);
  const lintOpts: LintOptions = { glossaryTerms: req.dossier.glossary.map((g) => g.term), hostNames: req.hosts.map((h) => h.name), source: req.source };
  const measureTurns = (turns: ScriptTurn[]): Measured => measure({ turns, title: spec.title, target: spec.targetWords, req, lintOpts, maxUnitChars: opts.maxUnitChars });

  let lastMeasured: Measured | undefined;
  let accepted: ScriptTurn[] | undefined;
  let submits = 0;
  let rejections = 0;
  const acceptedAdvisory: Array<{ rule: string; reason: string }> = [];
  const submitted = new Set<string>();

  const tools: ToolDef[] = [
    {
      name: "lint_segment",
      description: "Measure a draft of this segment without submitting it: words vs target, rhythm, tags/deliveries, names used before they are introduced, synth request size. Returns metrics, BLOCKING and ADVISORY findings by turn index.",
      parameters: { type: "object", properties: { turns: TURNS_SCHEMA }, required: ["turns"] },
      execute: async (args) => {
        const measured = measureTurns(turnsFromArgs(args));
        lastMeasured = measured;
        return measured.report;
      },
    },
    glossaryTool(req, Boolean(opts.brainDir)),
    ...buildResearchTools({ brainDir: opts.brainDir, history: { recent: () => [], transcript: () => null }, model: opts.model }).filter((t) => t.name === "brain_search" || t.name === "brain_read"),
    {
      name: "submit_segment",
      description: "Deliver the segment. Rejected with the findings while BLOCKING ones remain; ADVISORY ones are rejected once — resubmit with acceptAdvisory [{rule, reason}] to keep what is right for this segment. Ends the session when accepted.",
      parameters: {
        type: "object",
        properties: {
          turns: TURNS_SCHEMA,
          acceptAdvisory: {
            type: "array",
            description: "Advisory findings you keep on purpose, each with a concrete reason.",
            items: { type: "object", properties: { rule: { type: "string" }, reason: { type: "string" } }, required: ["rule", "reason"] },
          },
        },
        required: ["turns"],
      },
      execute: async (args) => {
        submits++;
        const measured = measureTurns(turnsFromArgs(args));
        lastMeasured = measured;
        if (measured.blocking.length > 0) {
          rejections++;
          return `REJECTED — blocking findings:\n${measured.report}`;
        }
        const wanted = ((args as { acceptAdvisory?: Array<{ rule?: unknown; reason?: unknown }> }).acceptAdvisory ?? [])
          .map((a) => ({ rule: String(a.rule ?? ""), reason: String(a.reason ?? "").trim() }))
          .filter((a) => a.reason.length >= MIN_REASON_CHARS);
        const open = measured.advisory.filter((a) => !wanted.some((w) => w.rule === a.rule));
        // An unchanged resubmit with the same open findings goes through: the writer has seen them and chose not to act.
        const fingerprint = JSON.stringify(measured.advisory.map((a) => a.text));
        if (open.length > 0 && !submitted.has(fingerprint)) {
          submitted.add(fingerprint);
          rejections++;
          return `REJECTED once — advisory findings (fix them, or resubmit the same turns with acceptAdvisory and a reason for each rule):\n${measured.report}`;
        }
        acceptedAdvisory.push(...wanted);
        accepted = measured.turns;
        return "ACCEPTED";
      },
    },
  ];

  const result = await runToolLoop({
    model: opts.model,
    systemPrompt: params.systemPrompt + agentAddendum(Boolean(opts.brainDir)),
    userContent: params.userContent,
    tools,
    maxCompletionTokens: writerBudget(spec.targetWords * 6, 1),
    stage: mode === "draft" ? "segment" : "revise",
    usageEndpoint: "podcast-segment",
    reasoningEffort: opts.reasoningEffort,
    fetchImpl: opts.fetchImpl,
    shouldStop: () => accepted !== undefined,
  });

  const fellBack = accepted === undefined;
  const turns = accepted ?? lastMeasured?.turns;
  opts.onRun?.({ mode, index, rounds: result.rounds, calls: result.calls, submits, rejections, accepted: acceptedAdvisory, fellBack });
  if (!turns || turns.length === 0) throw new Error(`segment agent ${mode} ${index + 1} ended without a measured draft`);
  // A draft the gate itself rejects never ships: the caller falls back to the single-shot writer.
  if (fellBack && lastMeasured && lastMeasured.blocking.length > 0) throw new Error(`segment agent ${mode} ${index + 1} ended on a draft with ${lastMeasured.blocking.length} blocking finding(s)`);
  if (fellBack) log.warn("segment agent ended without an accepted submit, using the last measured draft (no blocking findings)", { mode, index, rounds: result.rounds, submits, rejections });
  return turns;
}

/** Claude takes `reasoning_effort` on IU's OpenAI route (probed 2026-10-26) though the single-shot native route used adaptive thinking; other families per `resolveReasoningEffort`. */
/** gpt-6.x on chat/completions rejects function tools combined with any reasoning effort but "none" (503 "set reasoning_effort to 'none'", probed 2026-10-26 — omitting the field falls into the same default), so a tool loop sends "none". */
export const agentReasoningEffort = (model: string): string | undefined => {
  if (model.startsWith("claude-")) return "high";
  if (usesResponsesTransport(model)) return "high";
  if (model.startsWith("gpt-6")) return "none";
  return resolveReasoningEffort(model, "high");
};

export function createSegmentAgent(opts: SegmentAgentOptions): SegmentAgent {
  return {
    draft: async ({ req, outline, index, total, showBible, voice }) => {
      const spec = outline.segments[index];
      if (!spec) throw new Error(`outline segment ${index} out of range`);
      return runAgent(opts, {
        mode: "draft",
        req,
        outline,
        index,
        total,
        systemPrompt: segmentPrompt({ req, outline, segment: spec, index, total, previous: outline.segments[index - 1], showBible, voice }),
        userContent: buildSegmentUserContent({ req, outline, index }),
      });
    },
    revise: async ({ req, outline, segments, index, total, notes, showBible, voice }) => {
      const spec = outline.segments[index];
      if (!spec) throw new Error(`outline segment ${index} out of range`);
      return runAgent(opts, {
        mode: "revise",
        req,
        outline,
        index,
        total,
        systemPrompt: revisionPrompt({ req, outline, segment: spec, index, total, showBible, voice }),
        userContent: buildRevisionUserContent({ req, outline, segments, index, notes }),
      });
    },
  };
}
