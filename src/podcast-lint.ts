import type { ReviewNote, ScriptSegment } from "./podcast-script";

/**
 * Deterministic script lint — the cheap, measurable half of the review. Every rule comes from a
 * failure pattern found in the 2026-10-26 writer bake-off (seven writers, one outline): echoed
 * reactions, lecture turns, hosts that never ask, stock phrases, and names used before anyone
 * says what they are. Findings are advisory facts for the reviewers; only the unambiguous ones
 * (stock phrases, unintroduced terms) become revision notes on their own.
 */

export interface LintFinding {
  segmentIndex: number;
  turnIndex: number | null;
  rule: "stock-phrase" | "monologue" | "echo-reaction" | "no-questions" | "uniform-turns" | "unintroduced-term";
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
  segment.turns.forEach((turn, i) => {
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
  return { metrics, findings };
}

/** The measured facts, as a block the reviewers read next to the draft. */
export function renderLintReport(report: LintReport): string {
  const lines = report.metrics.map(
    (m, i) =>
      `[${i}] ${m.words} words, ${m.turns} turns, mean ${m.meanTurnWords} words/turn, longest ${m.maxTurnWords}, turn-length CV ${m.turnLengthCv}, ${Math.round(m.shortTurnShare * 100)}% short turns, questions A/B ${m.questionTurns.A}/${m.questionTurns.B}, echoed reactions ${m.echoReactions}`,
  );
  const findings = report.findings.map((f) => `- segment ${f.segmentIndex}${f.turnIndex === null ? "" : `, turn ${f.turnIndex}`}: ${f.message}`);
  return `${lines.join("\n")}\n${findings.length > 0 ? findings.join("\n") : "- no findings"}`;
}

/** The findings unambiguous enough to send to the writer without a reviewer's judgement. */
export function lintNotes(report: LintReport): ReviewNote[] {
  return report.findings
    .filter((f) => f.rule === "stock-phrase" || f.rule === "unintroduced-term")
    .map((f) => ({ segmentIndex: f.segmentIndex, turnIndex: f.turnIndex, reviewer: "lint", note: f.message }));
}
