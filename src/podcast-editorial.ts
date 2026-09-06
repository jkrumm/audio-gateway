import { log } from "./log";
import { callAndParse, callPodcastLlm, extractJsonObject, planSegmentCount, type PodcastHost } from "./podcast-script";
import type { Dossier, EpisodeBrief, EpisodeSummary, HumorLevel } from "./podcast-types";

// The editorial room: one model call between research and the writers' room
// that decides what KIND of episode this material deserves — format, roles,
// tone, humor, opening, closing, rhythm, length — and hands the writers a
// brief. It exists because five produced episodes were the same episode: the
// show bible and the outline prompt prescribed one shape, so every topic got
// that shape. The formula is gone from the spec; this call replaces it with a
// decision per episode, taken against the material AND against the profiles
// of the recent episodes, so the show varies on purpose.
//
// Best-effort by contract (docs/podcast-editorial-room.md, Decision 7): a
// parse failure or an LLM error yields `defaultEpisodeBrief` — a neutral
// conversation at the requested length — never the old formula, and never a
// failed job.

/** How much of the raw source the editor sees. It reads the dossier summary for meaning; the head is only there to feel the material's texture. */
const SOURCE_HEAD_CHARS = 6000;

/** Attempts at a parseable brief before falling back to the neutral default. */
const EDITORIAL_ATTEMPTS = 2;

/** Visible output is small (a JSON object of a few hundred words); the headroom is for the model's reasoning. */
const EDITORIAL_TOKEN_BUDGET = 20000;

const MIN_BRIEF_SEGMENTS = 1;
const MAX_BRIEF_SEGMENTS = 9;

const HUMOR_LEVELS: readonly HumorLevel[] = ["none", "sparse", "natural"];

export interface EditorialInput {
  dossier: Dossier;
  /** The verbatim source; only its head reaches the prompt. */
  source: string;
  brief?: string;
  title?: string;
  language: "de" | "en";
  /** Requested length — a hint unless `pinMinutes`. */
  minutes: number;
  pinMinutes: boolean;
  bounds: { minMinutes: number; maxMinutes: number };
  series: string;
  hosts: [PodcastHost, PodcastHost];
  /** Recent episodes, newest first. */
  history: EpisodeSummary[];
  showBible: string;
}

const LANGUAGE_LABEL: Record<"de" | "en", string> = { de: "German", en: "English" };

/** Format name is spoken language; everything else is instructions for the writers' room, so English. */
const DEFAULT_FORMAT: Record<"de" | "en", string> = { de: "Gespräch", en: "Conversation" };

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Keep one cell readable — the table is the editor's whole view of the show's recent past, not an archive dump. */
const CELL_MAX_CHARS = 60;

function cell(value: string | number | null | undefined): string {
  const text = String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  return text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS - 1)}…` : text;
}

/**
 * The recent episodes as the editor sees them: one row per episode, newest
 * first, carrying exactly the axes the editor is asked to vary on — format,
 * who led, humor, how it opened, how long it ran. Episodes from before the
 * profile existed still show up (with dashes), because "we have made episodes
 * about this before" is itself information.
 */
export function renderHistoryTable(history: EpisodeSummary[]): string {
  if (history.length === 0) return "(no previous episodes)";
  const rows = history.map((episode) => {
    const p = episode.profile;
    const date = (episode.createdAt ?? "").slice(0, 10);
    return `| ${cell(date)} | ${cell(episode.title)} | ${cell(p?.format)} | ${cell(p?.lead)} | ${cell(p?.humor)} | ${cell(p?.opening)} | ${cell(p?.minutes)} |`;
  });
  return ["| Date | Title | Format | Lead | Humor | Opening | Minutes |", "|-|-|-|-|-|-|-|", ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Brief: default + parsing
// ---------------------------------------------------------------------------

/**
 * The neutral brief: a real conversation both hosts carry, sparse humor, no
 * forced devices, straight into the topic, at the requested length. This is
 * what an unreachable or unparseable editor falls back to — deliberately NOT
 * the old formula, so a failed editorial call cannot resurrect the shape v2
 * exists to kill.
 */
export function defaultEpisodeBrief(input: Pick<EditorialInput, "minutes" | "language" | "hosts">): EpisodeBrief {
  const [hostA, hostB] = input.hosts;
  return {
    format: DEFAULT_FORMAT[input.language],
    rationale: "No editorial decision was available for this episode, so it is written as a plain, honest conversation about the material — no imposed shape, no borrowed dramaturgy.",
    minutes: input.minutes,
    segments: planSegmentCount(input.minutes),
    roles: {
      A: `${hostA.name} carries part of the episode: explains what the material actually says, and asks where it is thin.`,
      B: `${hostB.name} carries the other part: explains what they know, pushes back, and says things back in plain words.`,
    },
    tone: "Curious, concrete, unhurried. Two people who read the same material and are working out what it means.",
    humor: "sparse",
    opening: "Straight in with the topic — no cold open, no staged hook, no station intro beyond the hosts saying who they are.",
    closing: "Land on what the material actually leaves the listener with, then stop. No takeaway count, no outlook, no trailer for a next episode.",
    rhythm: "Whoever is explaining gets the floor for as long as the thought needs; the other reacts with substance. Both hosts should end up carrying comparable weight.",
    devices: [],
    avoid: [],
    glossaryPolicy: "Introduce an unfamiliar name or term as what it IS before what it is CALLED, then reuse one short handle for it.",
  };
}

const str = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() ? value.trim() : fallback);

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : [];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Parse the editor's reply into an {@link EpisodeBrief}. Tolerant by design:
 * every field falls back to the neutral default, `minutes` is clamped to the
 * request's bounds (and pinned to the request itself when the caller pinned
 * it), `segments` to 1..9 and `humor` to the enum. Only a reply with no JSON
 * object in it at all throws — that is the one case a retry can fix.
 */
export function parseEpisodeBrief(
  raw: string,
  input: Pick<EditorialInput, "minutes" | "pinMinutes" | "bounds" | "language" | "hosts">,
): EpisodeBrief {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const fallback = defaultEpisodeBrief(input);

  const minutesRaw = typeof parsed["minutes"] === "number" && Number.isFinite(parsed["minutes"]) ? Math.round(parsed["minutes"]) : input.minutes;
  const minutes = input.pinMinutes
    ? input.minutes
    : clamp(minutesRaw, input.bounds.minMinutes, input.bounds.maxMinutes);

  // When the model left segments out, recompute it against the BRIEF's OWN
  // (already clamped/pinned) minutes — not the requested minutes fallback.segments
  // was built from, which can disagree once pinMinutes/clamping kicked in.
  const segmentsRaw =
    typeof parsed["segments"] === "number" && Number.isFinite(parsed["segments"]) ? Math.round(parsed["segments"]) : planSegmentCount(minutes);

  const humorRaw = typeof parsed["humor"] === "string" ? parsed["humor"].trim().toLowerCase() : "";
  const humor = HUMOR_LEVELS.find((h) => h === humorRaw) ?? "sparse";

  const roles = (parsed["roles"] ?? {}) as Record<string, unknown>;

  return {
    format: str(parsed["format"], fallback.format),
    rationale: str(parsed["rationale"], ""),
    minutes,
    segments: clamp(segmentsRaw, MIN_BRIEF_SEGMENTS, MAX_BRIEF_SEGMENTS),
    roles: { A: str(roles["A"], fallback.roles.A), B: str(roles["B"], fallback.roles.B) },
    tone: str(parsed["tone"], fallback.tone),
    humor,
    opening: str(parsed["opening"], fallback.opening),
    closing: str(parsed["closing"], fallback.closing),
    rhythm: str(parsed["rhythm"], fallback.rhythm),
    devices: strList(parsed["devices"]),
    avoid: strList(parsed["avoid"]),
    glossaryPolicy: str(parsed["glossary_policy"] ?? parsed["glossaryPolicy"], fallback.glossaryPolicy),
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function editorialSystemPrompt(input: EditorialInput): string {
  const [hostA, hostB] = input.hosts;
  const languageLabel = LANGUAGE_LABEL[input.language];
  const lengthRule = input.pinMinutes
    ? `The length is PINNED at ${input.minutes} minutes — return exactly that number.`
    : `The requested ${input.minutes} minutes are a hint, not an order. Argue for shorter or longer whenever the material warrants it and say why in the rationale; you may return anything between ${input.bounds.minMinutes} and ${input.bounds.maxMinutes} minutes.`;

  return `You are the editor of "${input.series}". You do not write the episode; you decide what kind of episode this material deserves and hand the writers' room a brief.

The material decides the show, not a formula. Look at the recent episodes in the table and vary on purpose: if the last ones were "A explains, B asks", flip it, or make it a genuine dialogue of equals; if they all opened on a number and a "wait —", start differently; if they all ran twenty minutes, let a small topic be short.

Match the form to what is actually in front of you. A technical or procedural topic gets a straight, dense walkthrough — long turns, no forced jokes, humor only if it genuinely arises from the material. A decision gets two positions that really disagree. A plan gets the listener's questions, asked hard. A story gets told. Either host may lead. One host may carry most of the episode while the other barely speaks. Five minutes is a valid episode.

Do not invent drama. Do not invent a hook. Do not schedule jokes. Do not reach for a device because podcasts usually have one — a running motif, a withheld reveal, a digression and a set of takeaways are tools, not furniture, and the last five episodes were ruined by having all of them whether the topic wanted them or not.

Hosts: A = ${hostA.name}, B = ${hostB.name}. Their personalities are in the show bible; what each of them IS in this episode is your call.

${lengthRule}

Decide, and return as JSON:
- format: a free name for this episode's form, in ${languageLabel} ("Erklärstück", "Streitgespräch", "Kurzbriefing", "Interview", whatever fits). Not from a menu.
- rationale: 2 to 5 sentences — why this form for this material, and what it deliberately does differently from the recent episodes.
- minutes: the target length.
- segments: 1 to 9. Roughly four minutes each is a guide, not a rule — a tight briefing may be one segment.
- roles: what ${hostA.name} (A) and ${hostB.name} (B) each ARE in this episode, given their personalities. Be concrete about who explains, who asks, who leads, and whether the split is even.
- tone: how the episode should feel, in one or two sentences.
- humor: exactly one of "none", "sparse", "natural". "none" is the right answer for a dense technical topic.
- opening: how the episode starts. "Straight in with the topic, no cold open" is a perfectly good answer.
- closing: how it ends. "Stop when the argument is finished" is a perfectly good answer.
- rhythm: monologue share, pace, where the long explanations go and where quick exchanges belong.
- devices: dramaturgy devices that genuinely fit THIS material — a motif, a withheld reveal, a planned digression, a live disagreement. An empty array is the normal answer; only list what earns its place.
- avoid: concrete patterns from the recent episodes that this one must not repeat.
- glossary_policy: how unfamiliar names and terms from the glossary get introduced in this episode.

Write "format" in ${languageLabel}; write every other field in English — it is instruction for the writers' room, not a line anyone says on air.

Return STRICT JSON only, no markdown, no commentary:
{"format":"","rationale":"","minutes":0,"segments":0,"roles":{"A":"","B":""},"tone":"","humor":"none|sparse|natural","opening":"","closing":"","rhythm":"","devices":[],"avoid":[],"glossary_policy":""}`;
}

function buildEditorialUserContent(input: EditorialInput): string {
  const { dossier } = input;
  const parts: Array<string | undefined> = [
    input.showBible.trim() ? `SHOW BIBLE (the hosts' personalities and the house rules on speech):\n${input.showBible.trim()}` : undefined,
    `RECENT EPISODES (newest first — vary against these):\n${renderHistoryTable(input.history)}`,
    input.brief ? `LISTENER BRIEF (who this is for / what they want from it):\n${input.brief}` : undefined,
    input.title ? `TITLE HINT: ${input.title}` : undefined,
    dossier.summary.trim() ? `WHAT THE MATERIAL IS ABOUT (from the research stage):\n${dossier.summary.trim()}` : undefined,
    dossier.glossary.length > 0
      ? `GLOSSARY (names/terms the listener may not know):\n${dossier.glossary.map((g) => `${g.term} — ${g.plain}`).join("\n")}`
      : undefined,
    dossier.priorCoverage.length > 0
      ? `PRIOR COVERAGE (already covered in earlier episodes):\n${dossier.priorCoverage.map((p) => `- ${p.title}: ${p.covered}`).join("\n")}`
      : undefined,
    dossier.openQuestions.length > 0 ? `OPEN QUESTIONS:\n${dossier.openQuestions.map((q) => `- ${q}`).join("\n")}` : undefined,
    `SOURCE (the first ${SOURCE_HEAD_CHARS} characters, so you can feel the material — not the whole of it):\n${input.source.slice(0, SOURCE_HEAD_CHARS)}`,
  ];
  return parts.filter((p): p is string => Boolean(p)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Decide this episode's brief. Never throws: an LLM error or a reply that
 * still does not parse after {@link EDITORIAL_ATTEMPTS} attempts logs a
 * warning and yields {@link defaultEpisodeBrief}, because an episode written
 * to a neutral brief beats no episode.
 */
export async function decideEpisodeBrief(input: EditorialInput, opts: { model: string }): Promise<EpisodeBrief> {
  try {
    const brief = await callAndParse(
      "editorial",
      (attempt) =>
        callPodcastLlm({
          model: opts.model,
          systemPrompt: editorialSystemPrompt(input),
          userContent: buildEditorialUserContent(input),
          maxCompletionTokens: EDITORIAL_TOKEN_BUDGET * attempt,
          stage: "editorial",
          usageEndpoint: "podcast-editorial",
        }),
      (raw) => parseEpisodeBrief(raw, input),
      EDITORIAL_ATTEMPTS,
    );
    log.info("podcast editorial brief", {
      format: brief.format,
      minutes: brief.minutes,
      segments: brief.segments,
      humor: brief.humor,
      devices: brief.devices.length,
    });
    return brief;
  } catch (err) {
    log.warn("podcast editorial failed, falling back to the neutral default brief", {
      model: opts.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return defaultEpisodeBrief(input);
  }
}
