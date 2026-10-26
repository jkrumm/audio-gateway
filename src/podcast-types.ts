// Shared shapes of the v2 podcast pipeline (docs/podcast-editorial-room.md):
// what the researcher hands the editor, what the editor hands the writers'
// room, and what the ledger remembers per episode. Pure types — no imports —
// so research, editorial, script and ledger modules depend on this file, not
// on each other.

/** One tool invocation made by the research loop, for the job record and the OTel span. */
export interface ToolCallRecord {
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
}

/** What the research stage learned — everything the writers may use in addition to the verbatim source. */
export interface Dossier {
  /** What the source is about, 3–8 sentences, written for the editor. */
  summary: string;
  /** Extra material; `source` names its provenance ("brain: Areas/…", "research: <query>", "episode: <id>"). */
  additions: Array<{ source: string; text: string }>;
  /** Names, places, terms the listener may not know, with the plain-words handle the hosts should use. */
  glossary: Array<{ term: string; plain: string }>;
  /** What earlier episodes already covered on this topic, so the writers don't repeat it. */
  priorCoverage: Array<{ episodeId: string; title: string; covered: string }>;
  openQuestions: string[];
  toolCalls: ToolCallRecord[];
  /** research-gateway spend of this run, USD, as the gateway reported it. */
  researchUsd?: number;
}

export const EMPTY_DOSSIER: Dossier = Object.freeze({
  summary: "",
  additions: [],
  glossary: [],
  priorCoverage: [],
  openQuestions: [],
  toolCalls: [],
}) as Dossier;

export type HumorLevel = "none" | "sparse" | "natural";

/** The editor's decision for ONE episode — free-form where it matters, bounded in code where it must be. */
export interface EpisodeBrief {
  /** Free-text format name in the episode language ("Erklärstück", "Streitgespräch", "Kurzbriefing", "Interview", …). */
  format: string;
  /** Why this format for this material and what it deliberately does differently from the recent episodes. */
  rationale: string;
  /** Target minutes — may deviate from the request when not pinned; clamped to the request bounds. */
  minutes: number;
  /** 1–9, clamped in code. */
  segments: number;
  /** What each host is in THIS episode. Either may lead; one may barely speak. */
  roles: { A: string; B: string };
  tone: string;
  humor: HumorLevel;
  /** How the episode starts — free; "no cold open, straight in" is a valid answer. */
  opening: string;
  closing: string;
  /** Monologue share, pace, where long explanations go, where quick exchanges belong. */
  rhythm: string;
  /** Dramaturgy devices worth using here (motif, reveals, digressions; a live disagreement only for a genuinely contested source). May be empty. */
  devices: string[];
  /** Patterns from recent episodes NOT to repeat. */
  avoid: string[];
  /** How to introduce unfamiliar names/terms in this episode (uses the glossary). */
  glossaryPolicy: string;
  /** The listener's concrete questions and habits from the brief/source ("raw carrots, unwashed, from the bag"), each owed an explicit verdict. */
  asks?: string[];
}

/** What the ledger remembers about a finished episode — the editor's history and the `past_episodes` tool read this. */
export interface EpisodeProfile {
  format: string;
  /** Computed from word share, not asked: within 10 points → "balanced". */
  lead: "A" | "B" | "balanced";
  humor: HumorLevel;
  /** The brief's opening, one line. */
  opening: string;
  /** Planned minutes. */
  minutes: number;
  /** Measured, filled after mastering. */
  durationSeconds: number | null;
  topics: string[];
  segmentCount: number;
  toolCalls: number;
  researchCalls: number;
  /** research-gateway spend, USD (absent before 2026-10-26). */
  researchUsd?: number;
  /** Deterministic expression lint of the final script (podcast-lint.ts): allowed tags, writer-set deliveries, findings per rule. Absent on episodes before 2026-10-26. */
  expression?: { tags: number; deliveries: number; findings: Record<string, number> };
  /** The agentic writer's loops (podcast-agent.ts): runs, model rounds, rejected submits, loops that ended without an accepted submit. Absent when the single-shot writer ran. */
  agent?: { runs: number; rounds: number; rejections: number; fellBack: number };
  /** The length the caller asked for; `minutes` is what the editor planned (it may shorten by at most 20%). */
  requestedMinutes?: number;
  /** Final spoken words, and their ratio to the requested length at 145 words/minute; `lengthShort` when under 80%. */
  words?: number;
  lengthVsRequested?: number;
  lengthShort?: boolean;
  /** Listener asks (editor-extracted): how many, how many have no verdict turn in their segment, and whether the opening frames the question. */
  asks?: { total: number; uncovered: number | null; openingFramed: boolean | null };
  /** Multi-speaker request segmentation of the synth stage (lintSegmentation); absent on the ElevenLabs lane and older episodes. */
  segmentation?: { units: number; minChars: number; meanChars: number; maxChars: number; findings: string[] };
}

/** A past episode as the editor and the researcher see it. */
export interface EpisodeSummary {
  id: string;
  /** ISO timestamp of job creation. */
  createdAt: string;
  title: string;
  description: string;
  profile: EpisodeProfile | null;
}

/** The ledger side of the research tools — a port, so the research module never touches SQLite. */
export interface EpisodeHistory {
  recent(limit: number): EpisodeSummary[];
  /** Markdown transcript of a finished episode, or null when unknown / not finished. */
  transcript(id: string): string | null;
}
