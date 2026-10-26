import { DELIVERY_STYLES, endsOnQuestion, isDeliveryKey, SPEECH_TAGS, TAG_PATTERN } from "./gemini-tts-core";
import type { ReviewNote, ScriptSegment } from "./podcast-script";

/**
 * Deterministic script lint — the cheap, measurable half of the review. Every rule comes from a
 * failure pattern found in the 2026-10-26 writer bake-off (seven writers, one outline): echoed
 * reactions, lecture turns, hosts that never ask, stock phrases, and names used before anyone
 * says what they are. Findings are advisory facts for the reviewers; only the unambiguous ones
 * (stock phrases, unintroduced terms) become revision notes on their own.
 */

/** The deterministic expression rules (tags, per-turn delivery, CAPS emphasis); the findings are advisory facts for the reviewers. */
export type ExpressionRule =
  | "tag-not-allowed"
  | "tag-leads-short-turn"
  | "tags-adjacent"
  | "tags-below-band"
  | "tags-above-band"
  | "delivery-unknown"
  | "delivery-streak"
  | "delivery-short-turn"
  | "caps-emphasis";

export interface LintFinding {
  segmentIndex: number;
  turnIndex: number | null;
  rule: ExpressionRule | "meta-hedge" | "notes-ignorance" | "host-imbalance" | "stock-phrase" | "monologue" | "echo-reaction" | "no-questions" | "uniform-turns" | "unintroduced-term";
  message: string;
}

export interface SegmentMetrics {
  words: number;
  turns: number;
  meanTurnWords: number;
  /** Coefficient of variation of turn length; low = metronomic turn-taking. */
  turnLengthCv: number;
  maxTurnWords: number;
  /** Share of turns with at most {@link SHORT_TURN_WORDS} words. */
  shortTurnShare: number;
  /** Turns that contain a question mark, per host id. */
  questionTurns: { A: number; B: number };
  echoReactions: number;
  /** Allowed inline tags in the segment. */
  tags: number;
  /** Turns carrying a writer-set `delivery`. */
  deliveries: number;
}

export interface LintReport {
  metrics: SegmentMetrics[];
  findings: LintFinding[];
}

export interface LintOptions {
  /** Terms the research stage says the listener may not know (`dossier.glossary[].term`). */
  glossaryTerms?: string[];
  /** Host display names — never treated as terms to introduce. */
  hostNames?: string[];
  /** The episode source. When given, an all-caps token only counts as an acronym if the source spells it that way — the writer uses single CAPS words for emphasis ("KEIN Run"). */
  source?: string;
}

const SHORT_TURN_WORDS = 8;
/** Below this many words a tag is the whole delivery of the line (mirrors the sanitizer's floor in podcast-script.ts). */
const TAG_MIN_TURN_WORDS = 12;
/** A segment this long is measured against the tag band; a shorter one is too small to judge. */
const MIN_TURNS_FOR_TAG_BAND = 10;
/** Inline tags per ten turns: the band the writer prompt asks for ("one every four to eight turns" = 1.25–2.5; the lint is looser). Set from the 2026-10-26 listening proof. */
export const TAG_BAND_PER_TEN_TURNS = { min: 1, max: 3.5 } as const;
/** A non-baseline delivery on this many consecutive turns is a habit, not a moment. */
const DELIVERY_STREAK = 3;
/** A delivery on a line shorter than this has no time to land. */
const DELIVERY_MIN_WORDS = 8;
const ALLOWED_TAGS = new Set<string>(SPEECH_TAGS.map((t) => t.toLowerCase()));
/** Above this a turn is a lecture: the fast, interactive pace the owner wants breaks down. */
const MONOLOGUE_WORDS = 130;
const MIN_TURNS_FOR_RHYTHM = 8;
const UNIFORM_CV = 0.35;
/** A first sentence this short that only repeats the previous turn's words adds nothing. */
const ECHO_MAX_WORDS = 6;

/** Stock phrases from the show bible's "Verboten" list and the bake-off drafts. German, matched case-insensitively. */
const STOCK_PHRASES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bes ist erwähnenswert\b/i, label: "Es ist erwähnenswert" },
  { pattern: /\bnicht zuletzt\b/i, label: "Nicht zuletzt" },
  { pattern: /\bzusammenfassend (lässt sich|kann man)\b/i, label: "Zusammenfassend lässt sich sagen" },
  { pattern: /\bim folgenden\b/i, label: "Im Folgenden" },
  { pattern: /\bdas schöne daran\b/i, label: "Das Schöne daran" },
  { pattern: /\bdive into\b|\btauchen wir ein\b/i, label: "dive in / tauchen wir ein" },
  { pattern: /^(spannend|wow|absolut|krass|interessant)[.!]?\s*$/i, label: "Reaktion ohne Substanz" },
  { pattern: /\bnicht [^.,;:!?]{1,40}, sondern\b/i, label: "nicht X, sondern Y" },
];

/** Words in a normalized, lowercase form for overlap checks. */
const wordsOf = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 0);
const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;
const TAG = /<[^<>\n]{1,24}>/g;
const tagsIn = (text: string): string[] => text.match(TAG_PATTERN) ?? [];
const stripTags = (text: string): string => text.replace(TAG, " ").replace(/\s+/g, " ").trim();
const firstSentence = (text: string): string => stripTags(text).split(/(?<=[.!?])\s+/)[0] ?? "";

/** Content words that make an echo: long enough to carry meaning, or numeric. */
const contentWords = (sentence: string): string[] => wordsOf(sentence).filter((w) => w.length >= 5 || /\d/.test(w));

function isEcho(turn: string, previous: string | undefined): boolean {
  if (!previous) return false;
  const sentence = firstSentence(turn);
  if (countWords(sentence) > ECHO_MAX_WORDS) return false;
  const content = contentWords(sentence);
  if (content.length === 0) return false;
  const prior = new Set(wordsOf(previous));
  return content.every((w) => prior.has(w));
}

function metricsFor(segment: ScriptSegment): SegmentMetrics {
  const lengths = segment.turns.map((t) => countWords(stripTags(t.text)));
  const words = lengths.reduce((a, b) => a + b, 0);
  const mean = lengths.length > 0 ? words / lengths.length : 0;
  const variance = lengths.length > 0 ? lengths.reduce((a, l) => a + (l - mean) ** 2, 0) / lengths.length : 0;
  const questionTurns = { A: 0, B: 0 };
  let echoReactions = 0;
  let tags = 0;
  let deliveries = 0;
  segment.turns.forEach((turn, i) => {
    tags += tagsIn(turn.text).filter((t) => ALLOWED_TAGS.has(t.toLowerCase())).length;
    if (turn.delivery) deliveries++;
    if (turn.text.includes("?")) questionTurns[turn.speaker]++;
    if (isEcho(turn.text, segment.turns[i - 1]?.text)) echoReactions++;
  });
  return {
    words,
    turns: lengths.length,
    meanTurnWords: Math.round(mean * 10) / 10,
    turnLengthCv: mean > 0 ? Math.round((Math.sqrt(variance) / mean) * 100) / 100 : 0,
    maxTurnWords: Math.max(0, ...lengths),
    shortTurnShare: lengths.length > 0 ? Math.round((lengths.filter((l) => l <= SHORT_TURN_WORDS).length / lengths.length) * 100) / 100 : 0,
    questionTurns,
    echoReactions,
    tags,
    deliveries,
  };
}

/** Acronyms (DBOS, ADR, AGPL) are the one class of name a regex can spot reliably in German, where every noun is capitalised. */
const ACRONYM = /\b[A-ZÄÖÜ][A-ZÄÖÜ0-9]{1,}\b/g;
/** Spoken forms that introduce a term on their own: naming verbs, "kurz", "sprich", "das heißt". */
const INTRO_CUE = /\b(heißt|heißen|genannt|nennt|nennen|steht für|bedeutet|kurz|sprich|nämlich|das heißt|so etwas wie)\b/i;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "<term> ist ein/der/die/das …" within a few words, or the term followed by an apposition dash/colon/comma-article. */
function isDefinedAfter(term: string, window: string): boolean {
  const t = escapeRegExp(term);
  const copula = new RegExp(`${t}(\\s+\\S+){0,3}?\\s+(ist|sind|war)\\s+(ein|eine|der|die|das|dein|deine|unser|unsere)\\b`, "i");
  const apposition = new RegExp(`${t}\\s*([:–—]|,\\s+(ein|eine|der|die|das)\\b)`, "i");
  return copula.test(window) || apposition.test(window);
}

function termsIn(text: string, own: Set<string>, sourceAcronyms: Set<string> | undefined): string[] {
  const found = new Set<string>();
  for (const match of stripTags(text).matchAll(ACRONYM)) {
    if (own.has(match[0].toLowerCase())) continue;
    if (sourceAcronyms && !sourceAcronyms.has(match[0])) continue;
    found.add(match[0]);
  }
  return [...found];
}

/** Names/terms used before a clause says what they are. Advisory: the cue test is a heuristic, not a parse. */
function unintroducedTerms(segments: ScriptSegment[], opts: LintOptions): LintFinding[] {
  const own = new Set((opts.hostNames ?? []).map((n) => n.toLowerCase()));
  const glossary = (opts.glossaryTerms ?? []).filter((t) => t.trim().length > 0);
  const sourceAcronyms = opts.source === undefined ? undefined : new Set(opts.source.match(ACRONYM) ?? []);
  const seen = new Set<string>();
  const findings: LintFinding[] = [];
  segments.forEach((segment, segmentIndex) => {
    segment.turns.forEach((turn, turnIndex) => {
      const text = stripTags(turn.text);
      const candidates = [
        ...termsIn(text, own, sourceAcronyms),
        ...glossary.filter((g) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(g)}($|[^\\p{L}\\p{N}])`, "iu").test(text)),
      ];
      for (const term of candidates) {
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const sentences = text.split(/(?<=[.!?])\s+/);
        const at = sentences.findIndex((s) => s.toLowerCase().includes(key));
        const window = sentences.slice(Math.max(0, at), at + 2).join(" ");
        if (!INTRO_CUE.test(window) && !isDefinedAfter(term, window)) {
          findings.push({
            segmentIndex,
            turnIndex,
            rule: "unintroduced-term",
            message: `"${term}" is used here for the first time without a clause saying what it is and why it matters. Introduce it in one plain clause (what it is, then what it is called), or cut it.`,
          });
        }
      }
    });
  });
  return findings;
}


/** Words of a turn with its tags removed. */
const spokenWords = (text: string): number => countWords(stripTags(text.replace(TAG_PATTERN, " ")));

/** CAPS emphasis: an all-caps token that is not an acronym the source spells that way or a host name. */
function capsEmphasis(text: string, own: Set<string>, sourceAcronyms: Set<string> | undefined): number {
  const stripped = text.replace(TAG_PATTERN, " ");
  return (stripped.match(ACRONYM) ?? []).filter((w) => !own.has(w.toLowerCase()) && !(sourceAcronyms?.has(w) ?? false)).length;
}

/** Tags, per-turn delivery and CAPS emphasis — the measurable half of "expressiveness on purpose". */
function expressionFindings(segments: ScriptSegment[], opts: LintOptions, metrics: SegmentMetrics[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const own = new Set((opts.hostNames ?? []).map((n) => n.toLowerCase()));
  const sourceAcronyms = opts.source === undefined ? undefined : new Set(opts.source.match(ACRONYM) ?? []);
  segments.forEach((segment, segmentIndex) => {
    let streak = 0;
    let streakKey = "";
    segment.turns.forEach((turn, turnIndex) => {
      const found = tagsIn(turn.text);
      for (const tag of found) {
        if (!ALLOWED_TAGS.has(tag.toLowerCase())) {
          findings.push({ segmentIndex, turnIndex, rule: "tag-not-allowed", message: `Tag ${tag} is not in the allowed list (${SPEECH_TAGS.join(" ")}). Remove it or use an allowed one.` });
        }
      }
      if (found.length > 0 && /^\s*(<[^<>\n]{1,24}>|\[[^\]\n]+\])/.test(turn.text) && spokenWords(turn.text) < TAG_MIN_TURN_WORDS) {
        findings.push({ segmentIndex, turnIndex, rule: "tag-leads-short-turn", message: `A tag is the first word of a short line (${spokenWords(turn.text)} words) — it sounds staged. Put the tag between two sentences of a longer turn, or drop it.` });
      }
      if (/<[^<>\n]{1,24}>\s*<[^<>\n]{1,24}>/.test(turn.text)) {
        findings.push({ segmentIndex, turnIndex, rule: "tags-adjacent", message: "Two tags side by side — keep one." });
      }
      if (turn.delivery !== undefined) {
        if (!isDeliveryKey(turn.delivery)) {
          findings.push({ segmentIndex, turnIndex, rule: "delivery-unknown", message: `Delivery "${turn.delivery}" is not in the vocabulary (${Object.keys(DELIVERY_STYLES).join(", ")}); the voice ignores it. Use one of those or none.` });
        } else if (spokenWords(turn.text) < DELIVERY_MIN_WORDS) {
          findings.push({ segmentIndex, turnIndex, rule: "delivery-short-turn", message: `Delivery "${turn.delivery}" on a ${spokenWords(turn.text)}-word line — too short to land. Drop it.` });
        }
        streak = turn.delivery === streakKey ? streak + 1 : 1;
        streakKey = turn.delivery;
        if (streak === DELIVERY_STREAK) {
          findings.push({ segmentIndex, turnIndex, rule: "delivery-streak", message: `Delivery "${turn.delivery}" on ${DELIVERY_STREAK} turns in a row — a habit, not a moment. Keep it where the moment changes, baseline elsewhere.` });
        }
      } else {
        streak = 0;
        streakKey = "";
      }
      const caps = capsEmphasis(turn.text, own, sourceAcronyms);
      if (caps > 1) {
        findings.push({ segmentIndex, turnIndex, rule: "caps-emphasis", message: `${caps} CAPS words in one turn — emphasis is one word, once.` });
      }
    });
    const m = metrics[segmentIndex];
    if (m && m.turns >= MIN_TURNS_FOR_TAG_BAND) {
      const perTen = (m.tags / m.turns) * 10;
      if (perTen < TAG_BAND_PER_TEN_TURNS.min) {
        findings.push({ segmentIndex, turnIndex: null, rule: "tags-below-band", message: `${m.tags} tag(s) in ${m.turns} turns — flat. A few well-placed pauses and real reactions belong here (about one every four to eight turns).` });
      } else if (perTen > TAG_BAND_PER_TEN_TURNS.max) {
        findings.push({ segmentIndex, turnIndex: null, rule: "tags-above-band", message: `${m.tags} tags in ${m.turns} turns — a tic. Keep the pauses and reactions that earn their place.` });
      }
    }
  });
  return findings;
}

/** Counts per expression rule, for the job profile. */
export function expressionSummary(report: LintReport): { tags: number; deliveries: number; findings: Partial<Record<ExpressionRule, number>> } {
  const findings: Partial<Record<ExpressionRule, number>> = {};
  for (const f of report.findings) {
    if (EXPRESSION_RULES.has(f.rule)) findings[f.rule as ExpressionRule] = (findings[f.rule as ExpressionRule] ?? 0) + 1;
  }
  return { tags: report.metrics.reduce((n, m) => n + m.tags, 0), deliveries: report.metrics.reduce((n, m) => n + m.deliveries, 0), findings };
}
const EXPRESSION_RULES = new Set<string>(["tag-not-allowed", "tag-leads-short-turn", "tags-adjacent", "tags-below-band", "tags-above-band", "delivery-unknown", "delivery-streak", "delivery-short-turn", "caps-emphasis"]);

export interface SegmentationReport {
  units: number;
  minChars: number;
  meanChars: number;
  maxChars: number;
  findings: string[];
}

/**
 * Segmentation of the multi-speaker requests: every unit within `maxChars` (a single over-long turn excepted),
 * never across a segment, no unit ending on a question whose answer opens the next unit. Pure; takes the turn
 * texts, the segment sizes and the planned units.
 */
export function lintSegmentation(params: {
  texts: string[];
  segmentLengths: number[];
  units: Array<{ turnIndexes: number[] }>;
  maxChars: number;
}): SegmentationReport {
  const { texts, segmentLengths, units, maxChars } = params;
  const segmentOf: number[] = segmentLengths.flatMap((length, s) => Array.from({ length }, () => s));
  const sizes = units.map((u) => u.turnIndexes.reduce((n, t) => n + (texts[t]?.length ?? 0), 0));
  const findings: string[] = [];
  units.forEach((unit, u) => {
    if (unit.turnIndexes.length > 1 && (sizes[u] ?? 0) > maxChars) findings.push(`unit ${u}: ${sizes[u]} chars over the ${maxChars} limit`);
    if (new Set(unit.turnIndexes.map((t) => segmentOf[t])).size > 1) findings.push(`unit ${u}: spans a segment boundary`);
    const last = unit.turnIndexes[unit.turnIndexes.length - 1];
    const next = units[u + 1]?.turnIndexes[0];
    if (last !== undefined && next !== undefined && segmentOf[last] === segmentOf[next] && unit.turnIndexes.length > 1 && endsOnQuestion(texts[last] ?? "")) {
      findings.push(`unit ${u}: ends on a question whose answer opens unit ${u + 1}`);
    }
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  return { units: units.length, minChars: sizes.length > 0 ? Math.min(...sizes) : 0, meanChars: units.length > 0 ? Math.round(total / units.length) : 0, maxChars: sizes.length > 0 ? Math.max(...sizes) : 0, findings };
}


/** The notes named as the place something is missing — never on air (job 503c28f0 said it nine times). */
const NOTES_IGNORANCE = /\b(steht|stand|stehen|ist|sind|findet sich|fehlt)\s+(\w+\s+){0,3}(nicht|nirgends|kein\w*)\s+(\w+\s+){0,3}in\s+(deinen|den|diesen|euren|unseren)\s+(notizen|unterlagen)\b|\bin\s+(deinen|den|diesen)\s+(notizen|unterlagen)\s+(steht|stand|findet sich|fehlt|gibt es)\s+(\w+\s+){0,3}(nicht|nichts|nirgends|kein\w*)|\bnicht\s+in\s+(deinen|den|diesen)\s+(notizen|unterlagen)\b/i;
/** The "we don't know" tic. */
const KNOWLEDGE_HEDGE = /\b(das|dies|es)\s+wissen\s+wir\s+(noch\s+|schlicht\s+|einfach\s+)?(nicht|nicht genau)\b|\bwissen\s+wir\s+(noch\s+)?nicht\b|\bdas\s+weiß\s+(man|ich|keiner|niemand)\s+(noch\s+)?nicht\b/i;
/** More hedges than this per episode is a tic, not an honesty. */
const MAX_HEDGES_PER_EPISODE = 2;
/** The quieter host owns less than this share of a segment's words, with turns this short on average, only prompts. */
const MIN_HOST_SHARE = 0.25;
const PROMPT_ONLY_MEAN_WORDS = 15;

/** Hedge/meta-notes phrases per episode, and a host that only prompts. */
function conversationFindings(segments: ScriptSegment[], metrics: SegmentMetrics[]): LintFinding[] {
  const findings: LintFinding[] = [];
  let hedges = 0;
  segments.forEach((segment, segmentIndex) => {
    segment.turns.forEach((turn, turnIndex) => {
      const text = stripTags(turn.text);
      if (NOTES_IGNORANCE.test(text)) {
        findings.push({ segmentIndex, turnIndex, rule: "notes-ignorance", message: 'The notes are named as the place something is missing ("steht nicht in deinen Notizen"). Never on air: say what is unknown about the listener as conditional advice ("Falls bei dir …"), or state a genuine evidence gap once, in natural words.' });
      }
      if (KNOWLEDGE_HEDGE.test(text) && ++hedges > MAX_HEDGES_PER_EPISODE) {
        findings.push({ segmentIndex, turnIndex, rule: "meta-hedge", message: `"Das wissen wir nicht" for the ${hedges}th time in this episode — a tic. Say a real evidence gap once where it matters; elsewhere give conditional advice or cut the hedge.` });
      }
    });
    const m = metrics[segmentIndex];
    if (!m || m.turns < 8) return;
    const words = { A: 0, B: 0 };
    const turns = { A: 0, B: 0 };
    for (const turn of segment.turns) {
      words[turn.speaker] += countWords(stripTags(turn.text));
      turns[turn.speaker]++;
    }
    const total = words.A + words.B;
    const quiet: "A" | "B" = words.A <= words.B ? "A" : "B";
    if (total > 0 && words[quiet] / total < MIN_HOST_SHARE && turns[quiet] > 0 && words[quiet] / turns[quiet] < PROMPT_ONLY_MEAN_WORDS) {
      findings.push({ segmentIndex, turnIndex: null, rule: "host-imbalance", message: `Host ${quiet} has ${Math.round((words[quiet] / total) * 100)}% of the words in ${Math.round(words[quiet] / turns[quiet])}-word turns — only prompts. Give them something to own: a related fact from the material, their own reaction as a listener, the everyday example, the punchline.` });
    }
  });
  return findings;
}

export function lintSegments(segments: ScriptSegment[], opts: LintOptions = {}): LintReport {
  const metrics = segments.map(metricsFor);
  const findings: LintFinding[] = [];
  let standIns = 0;

  segments.forEach((segment, segmentIndex) => {
    const m = metrics[segmentIndex]!;
    segment.turns.forEach((turn, turnIndex) => {
      const text = stripTags(turn.text);
      for (const { pattern, label } of STOCK_PHRASES) {
        if (pattern.test(text)) findings.push({ segmentIndex, turnIndex, rule: "stock-phrase", message: `Stock phrase "${label}" — say it the way a person would, or cut it.` });
      }
      if (/\bstell dir vor\b/i.test(text) && ++standIns > 1) {
        findings.push({ segmentIndex, turnIndex, rule: "stock-phrase", message: `"Stell dir vor" a second time in one episode.` });
      }
      const words = countWords(text);
      if (words > MONOLOGUE_WORDS) {
        findings.push({ segmentIndex, turnIndex, rule: "monologue", message: `${words}-word turn — a lecture. Break it where the other host would naturally ask, or hand a piece of it over.` });
      }
      if (isEcho(turn.text, segment.turns[turnIndex - 1]?.text)) {
        findings.push({ segmentIndex, turnIndex, rule: "echo-reaction", message: `Opens by repeating the previous turn ("${firstSentence(turn.text)}"). A reaction adds something: a question, a consequence, a number.` });
      }
    });
    if (m.turns >= MIN_TURNS_FOR_RHYTHM && m.questionTurns.A + m.questionTurns.B === 0) {
      findings.push({ segmentIndex, turnIndex: null, rule: "no-questions", message: "Neither host asks a single question in this segment — nobody is curious. The listener's questions go in the hosts' mouths." });
    }
    if (m.turns >= MIN_TURNS_FOR_RHYTHM && m.turnLengthCv < UNIFORM_CV) {
      findings.push({ segmentIndex, turnIndex: null, rule: "uniform-turns", message: `Turn lengths are nearly uniform (CV ${m.turnLengthCv}) — metronomic. Mix a long explanation with quick exchanges.` });
    }
  });

  findings.push(...unintroducedTerms(segments, opts));
  findings.push(...expressionFindings(segments, opts, metrics));
  findings.push(...conversationFindings(segments, metrics));
  return { metrics, findings };
}

/** The measured facts, as a block the reviewers read next to the draft. */
export function renderLintReport(report: LintReport): string {
  const lines = report.metrics.map(
    (m, i) =>
      `[${i}] ${m.words} words, ${m.turns} turns, mean ${m.meanTurnWords} words/turn, longest ${m.maxTurnWords}, turn-length CV ${m.turnLengthCv}, ${Math.round(m.shortTurnShare * 100)}% short turns, questions A/B ${m.questionTurns.A}/${m.questionTurns.B}, echoed reactions ${m.echoReactions}, tags ${m.tags}, deliveries ${m.deliveries}`,
  );
  const findings = report.findings.map((f) => `- segment ${f.segmentIndex}${f.turnIndex === null ? "" : `, turn ${f.turnIndex}`}: ${f.message}`);
  return `${lines.join("\n")}\n${findings.length > 0 ? findings.join("\n") : "- no findings"}`;
}

/** The findings unambiguous enough to send to the writer without a reviewer's judgement. */
export function lintNotes(report: LintReport): ReviewNote[] {
  return report.findings
    .filter((f) => f.rule === "stock-phrase" || f.rule === "unintroduced-term" || f.rule === "notes-ignorance" || f.rule === "meta-hedge")
    .map((f) => ({ segmentIndex: f.segmentIndex, turnIndex: f.turnIndex, reviewer: "lint", note: f.message }));
}
