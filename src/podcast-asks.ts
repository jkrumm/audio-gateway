// The listener's concrete asks ("can I eat raw carrots unwashed?") are the episode's contract: each one gets an explicit
// verdict in the script. The editor extracts them, the outline assigns each to a segment, lint and the reviewers check
// them. Matching is deliberately cheap (a v1 script that answered correctly scores 0.43, the v2 script that swapped the ask for carrot greens 0.29 — real fixtures) — German-friendly 5-letter prefixes — because it is a tripwire, not a judge:
// the dramaturge reads the same list and decides whether a verdict is actually spoken.

const MIN_TOKEN_CHARS = 4;
const PREFIX_CHARS = 5;
/** Share of an ask's distinctive words that must show up for the ask to count as addressed. */
export const ASK_COVERAGE_MIN = 0.4;

const STOP = new Set(["aber", "auch", "dass", "eine", "einen", "einem", "einer", "oder", "sind", "wird", "kann", "darf", "ohne", "nicht", "gibt", "habe", "haben", "wenn", "dann", "wann", "welche", "welcher", "wieso", "warum", "über", "noch", "diese", "dieser", "sein", "ist", "the", "and", "with", "from", "that", "this", "what", "does", "should"]);

function prefixes(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-zäöüß]+/g) ?? []) {
    if (raw.length < MIN_TOKEN_CHARS || STOP.has(raw)) continue;
    out.add(raw.slice(0, PREFIX_CHARS));
  }
  return out;
}

/** Share (0..1) of the ask's distinctive words that appear in `text`; 1 for an ask with no distinctive words. */
export function askCoverage(ask: string, text: string): number {
  const wanted = prefixes(ask);
  if (wanted.size === 0) return 1;
  const have = prefixes(text);
  let hit = 0;
  for (const p of wanted) if (have.has(p)) hit++;
  return hit / wanted.size;
}

export interface AskSegmentSpec {
  title: string;
  goal: string;
  keyFacts: string[];
  /** Asks the outline writer assigned to this segment (verbatim from the brief's list). */
  answers?: string[];
}

/**
 * Every ask ends up in exactly one segment: keep the outline writer's assignment where it named the ask (matched by
 * coverage, so a paraphrase still counts), otherwise give it to the segment whose title/goal/key facts overlap most.
 * Pure — returns new segment answers, same order.
 */
export function assignAsks<T extends AskSegmentSpec>(segments: T[], asks: string[]): T[] {
  if (segments.length === 0 || asks.length === 0) return segments.map((s) => ({ ...s, answers: [] }));
  const answers: string[][] = segments.map(() => []);
  for (const ask of asks) {
    // The segment whose own answer matches best claims the ask — not the first one that loosely overlaps ("schälen" vs "waschen" share most words).
    const claims = segments.map((s) => Math.max(0, ...(s.answers ?? []).map((a) => Math.min(askCoverage(ask, a), askCoverage(a, ask)))));
    const best = Math.max(...claims);
    let target = best >= ASK_COVERAGE_MIN ? claims.indexOf(best) : -1;
    if (target < 0) {
      const scores = segments.map((s) => askCoverage(ask, `${s.title} ${s.goal} ${s.keyFacts.join(" ")}`));
      target = scores.indexOf(Math.max(...scores));
    }
    answers[target]!.push(ask);
  }
  return segments.map((s, i) => ({ ...s, answers: answers[i]! }));
}
