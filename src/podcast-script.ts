import { synthConcurrent } from "./gemini-tts-core";
import { rawFetch } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { withSpan } from "./otel";
import { recordUsage } from "./usage";

// Podcast script writer: turns a person's research notes into a two-host
// podcast episode, run as a "writers' room" with a role split and one voice
// owner. The OUTLINE model plans the story (through-line, cold-open hook,
// reveals, digressions, segments); the WRITE model is the sole voice owner —
// it writes every segment AND every revision/tightening pass, so the whole
// episode reads as one voice; every reviewer role (dramaturge, conversation
// coach, fact & speech editor) runs on EVERY listed review model, in
// parallel, advisory notes only — they point, they never draft; segments
// with notes are rewritten once more, by the write model, against just those
// notes; a final METADATA model writes the locked episode's title/
// description/cover prompt/genres/chapter titles once the script is done.
// The review and metadata passes are optional (`ScriptWriterOptions.review`/
// `metadata`, default on) so a cheap/test run can stop after the segment
// pass. A show bible (house style) is injected verbatim into the outline/
// segment/revision/review prompts when configured.
// Pure, config-free otherwise: every knob (models, concurrency, language,
// hosts, ...) is an explicit parameter — the orchestrator wires config in.

export interface PodcastHost {
  id: "A" | "B";
  name: string;
  voice: string;
  /** ElevenLabs speed (0.7–1.2); omitted = the model's own pace. Lets a fast host be slowed a notch. */
  speed?: number;
}

export interface PodcastScriptRequest {
  /** Raw notes/markdown the episode is about (may be 5-100k chars). */
  source: string;
  /** What the listener wants from this episode / who they are. */
  brief?: string;
  /** Optional episode title hint — the outline still decides the final title. */
  title?: string;
  language: "de" | "en";
  /** Target length; ~150 spoken words per minute. */
  minutes: number;
  hosts: [PodcastHost, PodcastHost];
  /** Show name, for the intro. */
  series: string;
}

export interface ScriptTurn {
  speaker: "A" | "B";
  text: string;
}

export interface ScriptSegment {
  title: string;
  turns: ScriptTurn[];
}

export interface PodcastScript {
  title: string;
  /** 2-4 sentences, show-notes style, in `language`. */
  description: string;
  /** English, for an image model. */
  coverPrompt: string;
  genres: string[];
  language: "de" | "en";
  segments: ScriptSegment[];
  wordCount: number;
}

export interface ScriptWriterOptions {
  /**
   * OpenAI-dialect chat model ids on the IU endpoint, one per role:
   * `outline` plans the story; `write` is the VOICE OWNER — it writes every
   * segment AND every revision/tightening pass, so the whole episode reads
   * as one voice; `review` is the reviewer roster (every role runs on every
   * listed model, in parallel); `metadata` writes the final title/
   * description/cover prompt/genres/chapter titles after the script locks.
   */
  models: { outline: string; write: string; review: string[]; metadata: string };
  /** Parallel segment writes. */
  concurrency: number;
  /** Run the multi-angle review + revision passes after the segments are written. Default true. */
  review?: boolean;
  /** Run the final metadata pass after the script is final. Default true. */
  metadata?: boolean;
  /** House-style rules injected verbatim into the outline/segment/revision/review prompts. Path to a file; missing → no section, logged once. */
  showBiblePath?: string;
  onProgress?: (stage: string, done: number, total: number) => void;
}

/** One segment spec from the outline pass — the brief for its own segment-writing call. */
interface OutlineSegmentSpec {
  title: string;
  goal: string;
  /** Verbatim facts/numbers from the source that MUST be spoken in this segment. */
  keyFacts: string[];
  targetWords: number;
  /** The question/disagreement this segment turns on. */
  tension: string;
}

/** A fact/twist/decision deliberately withheld until a specific later segment. */
export interface OutlineReveal {
  text: string;
  /** 0-based index of the segment this reveal lands in. */
  segmentIndex: number;
}

/** A planned side-trip (joke, anecdote, example, "what if") assigned to one segment. */
export interface OutlineDigression {
  beat: string;
  /** 0-based index of the segment that hosts this digression. */
  segmentIndex: number;
  /** The line that pulls the conversation back to the main thread afterward. */
  returnHook: string;
}

export interface Outline {
  title: string;
  description: string;
  coverPrompt: string;
  genres: string[];
  /** The running joke or motif the outline wants the hosts to return to across the episode. */
  motif: string;
  /** The one question the episode is really answering, revealed progressively rather than stated. */
  throughLine: string;
  /** The concrete cold-open beat — must not summarize the episode. */
  hook: string;
  reveals: OutlineReveal[];
  digressions: OutlineDigression[];
  segments: OutlineSegmentSpec[];
}

/** A note from one reviewer pass, targeting a segment/turn or the whole episode (`segmentIndex: null`). */
export interface ReviewNote {
  segmentIndex: number | null;
  turnIndex: number | null;
  /** `<role>@<model>` — who said this, so the writer (and the reader of a log) can weigh it. */
  reviewer: string;
  note: string;
}

/**
 * Allowed ElevenLabs v3 audio tags — only cues that appear as examples in the
 * official v3 docs. Anything outside that set ([thoughtful], [emphasized],
 * [hesitates] …) is not reliably interpreted and tends to be READ ALOUD as
 * text, which is exactly what the first episode did (2026-09-02).
 */
export const V3_PODCAST_TAGS = [
  "[laughs]", "[chuckles]", "[sighs]", "[exhales]", "[whispers]", "[excited]",
  "[curious]", "[clears throat]", "[pause]", "[short pause]",
] as const;

/** Below this many words a tag is the whole delivery — v3 then tends to speak it; strip instead. */
const TAG_MIN_TURN_WORDS = 12;

const ALLOWED_TAG_SET = new Set<string>(V3_PODCAST_TAGS.map((t) => t.toLowerCase()));

/** Planning rate. Measured on five produced episodes (ElevenLabs v3, German, two hosts, gaps included): 135–149 wpm; 150 planned 22 minutes and delivered 25–36. */
const WORDS_PER_MINUTE = 140;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 9;
const MINUTES_PER_SEGMENT = 4;
const DEFAULT_SPLIT_MAX_CHARS = 1400;
/** Safety ceiling on turn length — enforced here, not preached in the prompt (the writer decides rhythm). */
const MAX_TURN_WORDS = 180;
/** A turn shorter than this is a fragment ("Echt?", "Mhm.") worth folding into its neighbour. */
const MERGE_SHORT_TURN_CHARS = 40;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** ~4 minutes per segment, clamped to a sane 3..9 range regardless of episode length. */
export function planSegmentCount(minutes: number): number {
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(minutes / MINUTES_PER_SEGMENT)));
}

/** One in-flight/loaded read per path — a missing file logs its warning exactly once, not once per prompt. */
/**
 * Load the show bible (house style, binding) from disk. Read on every call —
 * it is a few KB, a job builds a dozen prompts, and not caching keeps this
 * module free of process-wide state (a test or a mounted volume can change
 * the file between jobs). A missing file is not fatal — the show bible is
 * polish, not the episode — so it resolves to an empty string with a warning.
 * Exported for tests.
 */
export async function loadShowBible(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch (err) {
    log.warn("podcast show bible not found, continuing without it", { path, error: err instanceof Error ? err.message : String(err) });
    return "";
  }
}

/** Render the show bible as a binding section appended to a system prompt; omitted entirely when blank. */
function showBibleSection(showBible: string): string {
  if (!showBible.trim()) return "";
  return `\n\nSHOW BIBLE (house style — binding):\n${showBible.trim()}`;
}

/** Strip ```json fences and leading/trailing prose, returning the first balanced-looking `{...}` slice. */
function extractJsonObject(raw: string): string {
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`expected a JSON object, got: ${raw.slice(0, 200)}`);
  }
  return fenced.slice(start, end + 1);
}

/** Clamp a reveal/digression's 0-based segment index onto a real segment, defensively. */
function clampSegmentIndex(value: number, segmentCount: number): number {
  return Math.min(Math.max(Math.round(value), 0), Math.max(segmentCount - 1, 0));
}

function parseReveals(raw: unknown, segmentCount: number): OutlineReveal[] {
  if (!Array.isArray(raw)) return [];
  const out: OutlineReveal[] = [];
  for (const item of raw) {
    const obj = (item ?? {}) as Record<string, unknown>;
    const text = typeof obj["text"] === "string" ? obj["text"].trim() : "";
    if (!text || typeof obj["segment"] !== "number") continue;
    out.push({ text, segmentIndex: clampSegmentIndex(obj["segment"], segmentCount) });
  }
  return out;
}

function parseDigressions(raw: unknown, segmentCount: number): OutlineDigression[] {
  if (!Array.isArray(raw)) return [];
  const out: OutlineDigression[] = [];
  for (const item of raw) {
    const obj = (item ?? {}) as Record<string, unknown>;
    const beat = typeof obj["beat"] === "string" ? obj["beat"].trim() : "";
    if (!beat || typeof obj["segment"] !== "number") continue;
    out.push({
      beat,
      segmentIndex: clampSegmentIndex(obj["segment"], segmentCount),
      returnHook: typeof obj["return_hook"] === "string" ? obj["return_hook"].trim() : "",
    });
  }
  return out;
}

/**
 * Parse the outline LLM's reply into an {@link Outline}. Tolerant of markdown
 * fences and leading prose (see `extractJsonObject`); missing/malformed
 * per-segment fields fall back to safe defaults rather than throwing, since a
 * partially-broken outline is still usable — only a wholly missing
 * `segments` array is fatal. The dramaturgy fields (`through_line`, `hook`,
 * `reveals`, `digressions`) default to empty/blank so older fixtures and a
 * writer reply that omits them still parse.
 */
export function parseOutline(raw: string): Outline {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    title?: unknown;
    description?: unknown;
    cover_prompt?: unknown;
    genres?: unknown;
    motif?: unknown;
    through_line?: unknown;
    hook?: unknown;
    reveals?: unknown;
    digressions?: unknown;
    segments?: unknown;
  };
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error(`outline returned no segments: ${raw.slice(0, 200)}`);
  }

  const segments: OutlineSegmentSpec[] = parsed.segments.map((raw, i) => {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const keyFacts = Array.isArray(obj["key_facts"])
      ? obj["key_facts"].filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];
    return {
      title: typeof obj["title"] === "string" && obj["title"].trim() ? obj["title"].trim() : `Segment ${i + 1}`,
      goal: typeof obj["goal"] === "string" ? obj["goal"].trim() : "",
      keyFacts,
      targetWords: typeof obj["target_words"] === "number" && obj["target_words"] > 0 ? Math.round(obj["target_words"]) : 200,
      tension: typeof obj["tension"] === "string" ? obj["tension"].trim() : "",
    };
  });

  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    description: typeof parsed.description === "string" ? parsed.description.trim() : "",
    coverPrompt: typeof parsed.cover_prompt === "string" ? parsed.cover_prompt.trim() : "",
    genres: Array.isArray(parsed.genres) ? parsed.genres.filter((g): g is string => typeof g === "string") : [],
    motif: typeof parsed.motif === "string" ? parsed.motif.trim() : "",
    throughLine: typeof parsed.through_line === "string" ? parsed.through_line.trim() : "",
    hook: typeof parsed.hook === "string" ? parsed.hook.trim() : "",
    reveals: parseReveals(parsed.reveals, segments.length),
    digressions: parseDigressions(parsed.digressions, segments.length),
    segments,
  };
}

/**
 * Parse a reviewer LLM's reply into its notes + one-line verdict. Same
 * fence/prose tolerance as {@link parseOutline}; a note missing its `note`
 * text is dropped, `segment`/`turn` default to `null` (episode-wide). Every
 * note is stamped with `reviewer` (`<role>@<model>`) so the revision pass
 * (and the logs) can see who said what.
 */
export function parseReviewNotes(raw: string, reviewer: string): { notes: ReviewNote[]; verdict: string } {
  const parsed = JSON.parse(extractJsonObject(raw)) as { notes?: unknown; verdict?: unknown };
  const notesRaw = Array.isArray(parsed.notes) ? parsed.notes : [];
  const notes: ReviewNote[] = [];
  for (const item of notesRaw) {
    const obj = (item ?? {}) as Record<string, unknown>;
    const note = typeof obj["note"] === "string" ? obj["note"].trim() : "";
    if (!note) continue;
    notes.push({
      segmentIndex: typeof obj["segment"] === "number" ? Math.round(obj["segment"]) : null,
      turnIndex: typeof obj["turn"] === "number" ? Math.round(obj["turn"]) : null,
      reviewer,
      note,
    });
  }
  return { notes, verdict: typeof parsed.verdict === "string" ? parsed.verdict.trim() : "" };
}

/** A short "Name:" / "A:" label the model leaked at the start of a turn's text, despite the JSON `speaker` field. */
const LEAKED_LABEL = /^[A-ZÄÖÜ][\wÄÖÜäöüß'-]{0,20}:\s+/;

/**
 * Parse a segment LLM's reply into {@link ScriptTurn}s. Same fence/prose
 * tolerance as {@link parseOutline}; drops turns with no usable speaker/text,
 * and strips a leaked speaker label the model sometimes repeats inside the
 * text itself even though the JSON already carries `speaker`.
 */
export function parseSegmentTurns(raw: string): ScriptTurn[] {
  const parsed = JSON.parse(extractJsonObject(raw)) as { turns?: unknown };
  if (!Array.isArray(parsed.turns)) {
    throw new Error(`segment reply returned no turns: ${raw.slice(0, 200)}`);
  }

  const turns: ScriptTurn[] = [];
  for (const raw of parsed.turns) {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const speakerRaw = typeof obj["speaker"] === "string" ? obj["speaker"].trim().toUpperCase() : "";
    const speaker: "A" | "B" | null = speakerRaw === "A" || speakerRaw === "B" ? speakerRaw : null;
    const text = typeof obj["text"] === "string" ? obj["text"].trim().replace(LEAKED_LABEL, "") : "";
    if (!speaker || !text) continue;
    turns.push({ speaker, text });
  }
  return turns;
}

/** Remove a `[bracketed]` tag unless it's in the allowed v3 vocabulary (case-insensitive match). */
function stripDisallowedTags(text: string): string {
  return text.replace(/\[[^\]\n]+\]/g, (m) => (ALLOWED_TAG_SET.has(m.toLowerCase()) ? m : ""));
}

/** A tag on a short line ("[laughs] Da ist sie.") is what v3 reads aloud most often — drop every tag below the word floor. */
function stripTagsOnShortTurn(text: string): string {
  const words = text.replace(/\[[^\]\n]+\]/g, "").trim().split(/\s+/).filter(Boolean).length;
  if (words >= TAG_MIN_TURN_WORDS) return text;
  return collapseWhitespace(text.replace(/\[[^\]\n]+\]/g, ""));
}

/** Strip markdown decoration, bullets and emoji left over from the LLM's reply — numbers/digits are left alone. */
function stripMarkdown(text: string): string {
  return text
    .replace(/[*_`#>]+/g, "")
    .replace(/^[\s]*[-•●▪◦*]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "");
}

const collapseWhitespace = (text: string): string => text.replace(/[ \t]{2,}/g, " ").replace(/\s+/g, " ").trim();

/** Split terminal-punctuated sentences, keeping the punctuation — good enough for spoken-turn seams. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Break one over-long turn into consecutive turns by the SAME speaker, at
 * sentence boundaries. Splits on whichever safety ceiling is hit first —
 * chars or words — since the writer prompt no longer preaches a word quota.
 */
function splitLongTurn(turn: ScriptTurn, maxChars: number, maxWords: number): ScriptTurn[] {
  if (turn.text.length <= maxChars && countWords(turn.text) <= maxWords) return [turn];
  const sentences = splitSentences(turn.text);
  const out: ScriptTurn[] = [];
  let buf = "";
  for (const sentence of sentences) {
    const merged = buf ? `${buf} ${sentence}` : sentence;
    if (buf && (merged.length > maxChars || countWords(merged) > maxWords)) {
      out.push({ speaker: turn.speaker, text: buf });
      buf = sentence;
    } else {
      buf = merged;
    }
  }
  if (buf) out.push({ speaker: turn.speaker, text: buf });
  return out.length > 0 ? out : [turn];
}

/**
 * Fold a turn into its predecessor when they share a speaker and the first is
 * a short fragment ("Echt?", "Mhm.") — unless doing so would push the merged
 * turn past `maxChars` (it runs after `splitLongTurn`, which already sized
 * turns to fit).
 */
function mergeShortAdjacent(turns: ScriptTurn[], maxChars: number): ScriptTurn[] {
  const out: ScriptTurn[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === turn.speaker && prev.text.length < MERGE_SHORT_TURN_CHARS) {
      const merged = `${prev.text} ${turn.text}`.trim();
      if (merged.length <= maxChars) {
        prev.text = merged;
        continue;
      }
    }
    out.push({ ...turn });
  }
  return out;
}

/**
 * Clean up one segment's turns for synthesis: drop disallowed audio tags,
 * strip markdown/emoji/bullets and collapse whitespace, split any turn over
 * `maxChars` at sentence boundaries (same speaker throughout), then merge a
 * short leading fragment into its same-speaker predecessor.
 */
export function sanitizeTurns(turns: ScriptTurn[], maxChars = DEFAULT_SPLIT_MAX_CHARS, maxWords = MAX_TURN_WORDS): ScriptTurn[] {
  const cleaned = turns
    .map((t) => ({ speaker: t.speaker, text: collapseWhitespace(stripMarkdown(stripDisallowedTags(t.text))) }))
    .map((t) => ({ speaker: t.speaker, text: stripTagsOnShortTurn(t.text) }))
    .filter((t) => t.text.length > 0);
  const split = cleaned.flatMap((t) => splitLongTurn(t, maxChars, maxWords));
  return mergeShortAdjacent(split, maxChars);
}

const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const LANGUAGE_LABEL: Record<"de" | "en", string> = { de: "German", en: "English" };

/** The shared, non-negotiable rules — identical for the outline and every segment call. */
function baseSystemPrompt(req: PodcastScriptRequest, showBible: string): string {
  const [hostA, hostB] = req.hosts;
  const languageLabel = LANGUAGE_LABEL[req.language];
  return `You are the head writer of "${req.series}", a two-host podcast that turns one person's research notes into an episode that sounds like a real, well-produced show — not a read-aloud summary.

Hosts: A = ${hostA.name} — has studied the SOURCE inside out (the notes belong to the listener or a third party, never to the host; never claim to have written or researched them); knows the plan, the numbers, the trade-offs; warm, precise, occasionally dry. B = ${hostB.name} — the curious co-host; asks what the listener would ask, pushes back, plays devil's advocate, summarizes in plain words, brings the human angle ("wie fühlt sich das an, wenn…"). Both are the listener's friends, on a first-name basis, addressing the listener as "du" (German) / "you". Neither is an assistant; nobody says "als KI".

Non-negotiables:
1. Every fact, number, place name, price, date and rule comes from the SOURCE. Never invent. If the source flags something as open/unverified, the hosts say so ("das ist noch offen"). You may add widely-known general context only when it helps understanding and is clearly framed as general ("grundsätzlich…").
2. Real-podcast texture: a cold open that hooks without giving away where the episode is going, a short natural intro, signposting between topics, callbacks to earlier points, at least one genuine disagreement or "wait, really?" moment per segment, one running joke or motif across the episode, planned digressions that always find their way back to the point, and a wrap-up with three concrete takeaways plus the open questions. The episode has one through-line — the question it is really answering — revealed progressively, never spoiled in the opening. Banter is fine but never filler — every exchange moves a fact, a decision, or the through-line forward.
3. It is a CONVERSATION with real weight, not ping-pong. Whoever is explaining gets the floor for as long as the thought needs — a real walk-through, an example, a small story — and the other host listens, then reacts with weight, not a one-liner. Vary the rhythm on purpose: a long stretch, a quick exchange, a pause, a digression that comes back. Interjections exist but are rare and earned. Never alternate mechanically; never let both hosts speak in the same length all the time. No lists read aloud — turn any list into back-and-forth or a walked-through explanation.
4. Written for the EAR in ${languageLabel}: numbers, prices, times, units, dates and abbreviations fully spelled out as spoken (German: "dreihundertdreißig Euro", "hundertfünf Stundenkilometer", "elfter September", "zwei Meter fünfzig"); no digits, no symbols, no URLs, no markdown, no emoji, no parentheses. Place names in their local form. Expand every acronym once.
5. Expressiveness comes from punctuation first — ellipses, dashes, short sentences, a question left hanging. ElevenLabs v3 audio tags ONLY from this list: ${V3_PODCAST_TAGS.join(" ")}. Very sparse: at most one tag every six turns, only inside turns of twelve words or more, placed at the start of a sentence in the middle of the turn — never as the first word of a short line, never translated, never invented. Most turns carry NO tag.
6. The episode is for the listener described in the brief; when the notes are the listener's own plan, the hosts talk about it as THEIR listener's plan ("du fährst…", "dein Van…") and give advice, not a travelogue.
7. Output STRICT JSON only, no commentary, no code fences.${showBibleSection(showBible)}`;
}

function outlinePrompt(req: PodcastScriptRequest, segmentCount: number, targetWords: number, showBible: string): string {
  const languageLabel = LANGUAGE_LABEL[req.language];
  return `${baseSystemPrompt(req, showBible)}

You are writing the OUTLINE for this episode — decide its shape AND its dramaturgy, like a writers' room breaking a story before anyone drafts a line.
- Produce exactly ${segmentCount} segments. The first segment is the cold open plus a short intro to the show and its hosts; the last segment is the wrap-up (three concrete takeaways, the open questions, and a sign-off).
- The segments' target_words must sum to about ${targetWords} words in total (roughly ${Math.round(targetWords / segmentCount)} per segment) — the whole episode is meant to run about ${req.minutes} minutes at roughly ${WORDS_PER_MINUTE} spoken words per minute. target_words is a soft budget for the whole segment, not a per-turn quota — how the words are spent inside a segment is the segment writer's call.
- cover_prompt: a concrete, painterly, text-free square podcast-cover brief in English, mentioning the subject and mood.
- genres: 1 to 3 short English genre labels (e.g. "Travel", "Planning").
- motif: one running joke or motif the hosts can return to, lightly, across the episode — since segments are written independently, this is the only thread tying them together.
- through_line: the ONE question this episode is really answering. The hosts circle it and build toward it, they do not state it outright early on — write it as a single sentence for the writers' room, never as a line a host actually says in the cold open.
- hook: the cold-open beat itself — a concrete scene, a striking number, or a live disagreement. It must be gripping and it must NOT summarize the episode or preview the takeaways; it only earns the next ten seconds.
- reveals: 2 to 4 things worth deliberately withholding — a number, a decision, a twist — each tied to the 0-based index of the segment where it should land. Segments before that index may gesture at it without giving it away.
- digressions: 2 to 4 planned side-trips (a joke, a short anecdote, a concrete example, a "what if") — each tied to the 0-based index of the segment that should host it, plus a one-line return_hook: the line that pulls the conversation back to the main thread afterward.
- Every key_facts entry must be a fact, number or rule taken verbatim (or near-verbatim) from the source — these are the load-bearing details each segment MUST speak aloud.

Return STRICT JSON only, no markdown, no commentary:
{"title":"<episode title>","description":"<2-4 sentence show-notes description in ${languageLabel}>","cover_prompt":"<English image brief>","genres":["..."],"motif":"<the running joke or motif the hosts return to across the episode>","through_line":"<the one question the episode answers, revealed progressively>","hook":"<the concrete cold-open beat, no spoilers>","reveals":[{"text":"<what gets revealed>","segment":<0-based segment index>}],"digressions":[{"beat":"<the side-trip>","segment":<0-based segment index>,"return_hook":"<the line that returns to the thread>"}],"segments":[{"title":"<segment title>","goal":"<what this segment accomplishes>","key_facts":["<verbatim fact from the source>"],"target_words":<number>,"tension":"<the question or disagreement this segment turns on>"}]}`;
}

function segmentPrompt(params: {
  req: PodcastScriptRequest;
  outline: Outline;
  segment: OutlineSegmentSpec;
  index: number;
  total: number;
  previous?: OutlineSegmentSpec;
  showBible: string;
}): string {
  const { req, outline, segment, index, total, previous, showBible } = params;
  const bridgeInstruction = index === 0
    ? "This is the FIRST segment — open with the episode's HOOK (given in the user message) as the cold open, before anything else, then a short natural intro to the show and its two hosts. The hook must not summarize what the episode covers."
    : `The previous segment ended aiming at: "${previous?.goal ?? ""}". Open with a natural bridge from that into this segment — never re-introduce the show.`;
  const wrapInstruction = index === total - 1
    ? "This is the LAST segment — end with three concrete takeaways, the open questions, and a warm sign-off."
    : "End this segment with a hand-off / teaser into the next topic — never a final sign-off.";

  return `${baseSystemPrompt(req, showBible)}

You are writing ONE SEGMENT (${index + 1} of ${total}) of the episode "${outline.title}".
Write ONLY this segment: "${segment.title}". Target about ${segment.targetWords} words — a soft budget for the whole segment, not a per-turn quota.
Segment goal: ${segment.goal}
Central tension for this segment: ${segment.tension}
Key facts this segment MUST speak, verbatim where possible:
${segment.keyFacts.map((f) => `- ${f}`).join("\n")}
${outline.motif ? `\nRunning motif of the episode (return to it once, lightly, if it fits): ${outline.motif}\n` : ""}
${outline.throughLine ? `\nThe episode's through-line (the one question it's really answering — circle it, don't state it outright): ${outline.throughLine}\n` : ""}
If the user message assigns this segment a digression, take it fully — let it breathe — then use its return hook to pull the conversation back. If it assigns reveals, build toward them without giving them away yet. If it lists things reserved for a later segment, do not mention them at all, not even obliquely.
${bridgeInstruction}
${wrapInstruction}

Return STRICT JSON only, no markdown, no commentary:
{"turns":[{"speaker":"A"|"B","text":"<what this host says>"}]}`;
}

function buildOutlineUserContent(req: PodcastScriptRequest): string {
  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    req.brief ? `BRIEF (who the listener is / what they want from this episode):\n${req.brief}` : undefined,
    req.title ? `TITLE HINT: ${req.title}` : undefined,
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n\n");
}

function buildSegmentUserContent(params: { req: PodcastScriptRequest; outline: Outline; index: number }): string {
  const { req, outline, index } = params;
  const segment = outline.segments[index];
  if (!segment) throw new Error(`segment index ${index} out of range`);
  const previous = outline.segments[index - 1];

  const ownReveals = outline.reveals.filter((r) => r.segmentIndex === index);
  const laterReveals = outline.reveals.filter((r) => r.segmentIndex > index);
  const ownDigressions = outline.digressions.filter((d) => d.segmentIndex === index);

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    req.brief ? `BRIEF: ${req.brief}` : undefined,
    `FULL EPISODE OUTLINE (for continuity — you are writing only segment ${index + 1} of ${outline.segments.length}):\n${outline.segments
      .map((s, i) => `${i + 1}. ${s.title} — ${s.goal}`)
      .join("\n")}`,
    previous ? `PREVIOUS SEGMENT (for the bridge — do not repeat it): "${previous.title}" — ended aiming at: ${previous.goal}` : undefined,
    index === 0 && outline.hook ? `HOOK (open this segment with this beat, concrete, no summary of what's coming): ${outline.hook}` : undefined,
    ownReveals.length > 0 ? `REVEALS TO LAND IN THIS SEGMENT:\n${ownReveals.map((r) => `- ${r.text}`).join("\n")}` : undefined,
    laterReveals.length > 0
      ? `DO NOT REVEAL YET (planned for a later segment — do not mention, even obliquely):\n${laterReveals
          .map((r) => `- ${r.text} (lands in segment ${r.segmentIndex + 1})`)
          .join("\n")}`
      : undefined,
    ownDigressions.length > 0
      ? `DIGRESSION FOR THIS SEGMENT:\n${ownDigressions.map((d) => `- ${d.beat} — then return with: ${d.returnHook}`).join("\n")}`
      : undefined,
    `THIS SEGMENT'S SPEC:\nTitle: ${segment.title}\nGoal: ${segment.goal}\nTension: ${segment.tension}\nTarget words: ${segment.targetWords}\nKey facts to speak:\n${segment.keyFacts
      .map((f) => `- ${f}`)
      .join("\n")}`,
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Review prompts (multi-angle, whole-draft)
// ---------------------------------------------------------------------------

const REVIEWER_ROLES = ["dramaturge", "conversation-coach", "fact-editor"] as const;
type ReviewerRole = (typeof REVIEWER_ROLES)[number];

const REVIEWER_INSTRUCTIONS: Record<ReviewerRole, (languageLabel: string) => string> = {
  dramaturge: () =>
    `You are the DRAMATURGE reviewing a finished two-host podcast draft for its story shape, not its prose. Check: is there a red thread running through the whole episode; does the hook land without spoiling anything; do the planned reveals arrive in the segment they were assigned to (not earlier, not late, not skipped); do the planned digressions actually return to the point; is the pacing varied across the whole episode, not just within one segment; does the ending earn its takeaways rather than announcing them out of nowhere.`,
  "conversation-coach": () =>
    `You are the CONVERSATION COACH reviewing a finished two-host podcast draft for how it sounds, not what it says. Check: does this sound like two people actually talking — real floor time for whoever is explaining, reactions with substance rather than a one-word acknowledgement, natural interruptions, no mechanical strict alternation, no "wie gesagt" / "as we said" filler; do the two hosts sound distinct from each other; do any moments of humour actually land and fit the moment. Also flag written-language constructs and AI-isms: essay sentences, hedges like "es ist erwähnenswert" or "worth stating plainly", tidy triads, over-explained emotion, a character explaining what they feel instead of just feeling it, filler, and repeated setups.`,
  "fact-editor": (languageLabel) =>
    `You are the FACT & SPEECH EDITOR reviewing a finished two-host podcast draft. Check: every fact, number, place, price or date is traceable to the SOURCE — flag anything invented or contradicted; nothing important from any segment's key_facts is missing from the draft; numbers, dates and units are spelled out as spoken ${languageLabel}, never digits or symbols; every sentence is speakable in one breath; ElevenLabs v3 audio tags are only from the allowed list (${V3_PODCAST_TAGS.join(" ")}) and only where they earn their place — flag over-use; no markdown, no emoji, nothing that isn't spoken text.`,
};

function reviewPrompt(params: { req: PodcastScriptRequest; outline: Outline; role: ReviewerRole; showBible: string }): string {
  const { req, outline, role, showBible } = params;
  const languageLabel = LANGUAGE_LABEL[req.language];
  return `You are a reviewer from a different model family than the writer; your notes are advisory. You never rewrite lines — you point, you do not draft. Prefer few, specific, high-value notes over many.

${REVIEWER_INSTRUCTIONS[role](languageLabel)}

You are reviewing one finished episode draft of "${outline.title}", written in ${languageLabel}. You get the SOURCE, the full outline (with its dramaturgy), and the full draft script rendered as one line per turn: "[seg i][turn j] Name: text" (both indices 0-based).

Give at most 12 notes. Every note must be specific and actionable — name the segment/turn it is about and say exactly what to change, not just what is wrong. If something is fine, do not write a note about it.${showBibleSection(showBible)}

Return STRICT JSON only, no markdown, no commentary:
{"notes":[{"segment":<0-based segment index>,"turn":<0-based turn index within that segment, or null for a segment-wide or episode-wide note>,"note":"<specific, actionable note>"}],"verdict":"<one line: is this draft ready to publish, and why>"}`;
}

function renderDraftForReview(segments: ScriptSegment[], hosts: [PodcastHost, PodcastHost]): string {
  const nameFor = (speaker: "A" | "B"): string => hosts.find((h) => h.id === speaker)?.name ?? speaker;
  return segments
    .flatMap((seg, i) => seg.turns.map((t, j) => `[seg ${i}][turn ${j}] ${nameFor(t.speaker)}: ${t.text}`))
    .join("\n");
}

function buildReviewUserContent(params: { req: PodcastScriptRequest; outline: Outline; segments: ScriptSegment[] }): string {
  const { req, outline, segments } = params;
  const dramaturgy = [
    outline.throughLine ? `Through-line: ${outline.throughLine}` : undefined,
    outline.hook ? `Hook: ${outline.hook}` : undefined,
    outline.reveals.length > 0
      ? `Planned reveals:\n${outline.reveals.map((r) => `- ${r.text} (segment ${r.segmentIndex + 1})`).join("\n")}`
      : undefined,
    outline.digressions.length > 0
      ? `Planned digressions:\n${outline.digressions.map((d) => `- ${d.beat} (segment ${d.segmentIndex + 1}) — returns with: ${d.returnHook}`).join("\n")}`
      : undefined,
  ].filter((p): p is string => Boolean(p)).join("\n");

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    `EPISODE OUTLINE:\nTitle: ${outline.title}\nMotif: ${outline.motif}\n${dramaturgy}\nSegments:\n${outline.segments
      .map((s, i) => `${i + 1}. ${s.title} — ${s.goal} (tension: ${s.tension})`)
      .join("\n")}`,
    `FULL DRAFT SCRIPT:\n${renderDraftForReview(segments, req.hosts)}`,
  ];
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Revision prompts (per segment, targeted)
// ---------------------------------------------------------------------------

function revisionPrompt(params: { req: PodcastScriptRequest; outline: Outline; segment: OutlineSegmentSpec; index: number; total: number; showBible: string }): string {
  const { req, outline, segment, index, total, showBible } = params;
  return `${baseSystemPrompt(req, showBible)}

You are REVISING ONE SEGMENT (${index + 1} of ${total}) of the episode "${outline.title}" — "${segment.title}" — based on editorial notes from a review pass. The segment's target is ${segment.targetWords} words; a revision never grows the segment, and if a note asks for a cut, the cut is the priority. You get the segment's CURRENT turns, the notes that apply to it, and a few turns from the neighbouring segments for the seams.
Apply every note that is valid. Where a note is wrong (it contradicts the source, or the segment's own goal/tension), use your judgement and keep what already works — you are not obligated to change something just because a note mentions it. Do not shorten the segment just to hit a word target; keep its texture.
Segment goal: ${segment.goal}
Central tension for this segment: ${segment.tension}
Key facts this segment MUST speak, verbatim where possible:
${segment.keyFacts.map((f) => `- ${f}`).join("\n")}

Return the FULL revised segment as STRICT JSON only, no markdown, no commentary:
{"turns":[{"speaker":"A"|"B","text":"<what this host says>"}]}`;
}

function buildRevisionUserContent(params: {
  req: PodcastScriptRequest;
  outline: Outline;
  segments: ScriptSegment[];
  index: number;
  notes: ReviewNote[];
}): string {
  const { req, outline, segments, index, notes } = params;
  const segment = outline.segments[index];
  if (!segment) throw new Error(`segment index ${index} out of range`);
  const current = segments[index];
  if (!current) throw new Error(`draft segment ${index} out of range`);
  const previousDraft = segments[index - 1];
  const nextDraft = segments[index + 1];

  const renderTurns = (turns: ScriptTurn[]): string =>
    turns.map((t, j) => `[turn ${j}] ${req.hosts.find((h) => h.id === t.speaker)?.name ?? t.speaker}: ${t.text}`).join("\n");

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    `CURRENT TURNS FOR THIS SEGMENT:\n${renderTurns(current.turns)}`,
    `EDITORIAL NOTES FOR THIS SEGMENT:\n${notes.map((n) => `- [${n.reviewer}] ${n.note}`).join("\n")}`,
    previousDraft ? `END OF PREVIOUS SEGMENT (for the seam — do not repeat it):\n${renderTurns(previousDraft.turns.slice(-3))}` : undefined,
    nextDraft ? `START OF NEXT SEGMENT (for the seam — hand off toward it):\n${renderTurns(nextDraft.turns.slice(0, 2))}` : undefined,
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n\n");
}

/** The notes a segment's revision call should see: its own notes, plus episode-wide notes (`segmentIndex: null`) — but ONLY if it has at least one note of its own, so an untouched segment is never rewritten just because of an episode-level remark. */
/** Every version so far overshot its length (22 min asked, 27–36 min delivered); the writer models pad. This is the tolerance before the governor cuts. */
const LENGTH_TOLERANCE = 0.2;

/**
 * Scale the outline's per-segment targets so they sum to the episode's
 * budget. The story pass is asked for that, but the model's arithmetic drifts
 * and the drift compounds through six segment writers. Exported for tests.
 */
export function normalizeOutlineTargets(outline: Outline, totalTargetWords: number): Outline {
  const sum = outline.segments.reduce((n, seg) => n + seg.targetWords, 0);
  if (sum <= 0) return outline;
  const factor = totalTargetWords / sum;
  return { ...outline, segments: outline.segments.map((seg) => ({ ...seg, targetWords: Math.max(80, Math.round(seg.targetWords * factor)) })) };
}

const segmentWords = (seg: ScriptSegment): number => seg.turns.reduce((n, t) => n + countWords(t.text), 0);

/**
 * Length governor: one editorial note per segment that runs more than
 * LENGTH_TOLERANCE over its target, phrased as a cut with what to keep.
 * Goes through the normal revision pass, so it costs nothing extra when the
 * segment is already being revised. Exported for tests.
 */
export function lengthNotes(segments: ScriptSegment[], outline: Outline): ReviewNote[] {
  const notes: ReviewNote[] = [];
  segments.forEach((seg, index) => {
    const target = outline.segments[index]?.targetWords;
    if (!target) return;
    const words = segmentWords(seg);
    if (words <= target * (1 + LENGTH_TOLERANCE)) return;
    notes.push({
      segmentIndex: index,
      turnIndex: null,
      reviewer: "length-governor",
      note: `This segment runs ${words} words against a target of ${target}. Cut it to about ${target} words: remove restatements, second examples and warm-up lines; keep every key fact, the strongest exchange and the bridge. Do not add anything.`,
    });
  });
  return notes;
}

function segmentNotesFor(notes: ReviewNote[], index: number): ReviewNote[] {
  const own = notes.filter((n) => n.segmentIndex === index);
  if (own.length === 0) return [];
  return [...own, ...notes.filter((n) => n.segmentIndex === null)];
}

// ---------------------------------------------------------------------------
// LLM call (mirrors replicate-tts.ts's runReplicatePrep)
// ---------------------------------------------------------------------------

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Parse an OpenAI-dialect chat completion returned as an SSE stream
 * (`stream: true`) into the concatenated assistant text plus the trailing
 * `usage` chunk (`stream_options.include_usage`). Tolerates a plain non-stream
 * JSON body too (a proxy that ignores `stream`), so callers never branch.
 * Exported for tests.
 */
export function parseChatCompletionStream(body: string): { content: string; usage?: OpenAiUsage; finishReason?: string } {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:") && !trimmed.startsWith(":")) {
    const json = JSON.parse(body) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: OpenAiUsage };
    return { content: json.choices?.[0]?.message?.content ?? "", usage: json.usage, finishReason: json.choices?.[0]?.finish_reason };
  }
  let content = "";
  let usage: OpenAiUsage | undefined;
  let finishReason: string | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      usage?: OpenAiUsage | null;
    };
    content += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  return { content, usage, finishReason };
}

async function callWriterLlm(params: {
  model: string;
  systemPrompt: string;
  userContent: string;
  maxCompletionTokens: number;
  stage: "outline" | "segment" | "review" | "revise" | "metadata";
  usageEndpoint: "podcast-outline" | "podcast-segment" | "podcast-review" | "podcast-metadata";
  /** `<role>@<model>` — set only for review calls, so the span carries who reviewed. */
  reviewer?: string;
}): Promise<string> {
  return withSpan(
    "audio.podcast.llm",
    {
      "llm.model": params.model,
      "audio.podcast.stage": params.stage,
      ...(params.reviewer && { "audio.podcast.reviewer": params.reviewer }),
    },
    async (span) => {
      const start = Date.now();
      const res = await rawFetch(iuUrl("/chat/completions"), {
        method: "POST",
        headers: iuHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: params.model,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: params.userContent },
          ],
          max_completion_tokens: params.maxCompletionTokens,
          // Streamed on purpose: a 20-minute episode's outline over a 20k-char
          // source runs several minutes on the writer model, longer than the IU
          // proxy's non-streaming request timeout (observed as an HTML "500 - The
          // request timed out"). Streaming keeps bytes flowing; the body is still
          // read to completion here and stitched back together.
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      const latencyMs = Date.now() - start;
      span.setAttributes({ "http.status_code": res.status });

      if (res.status < 200 || res.status >= 300) {
        const errorText = res.body.slice(0, 500);
        log.error("podcast script llm error", { endpoint: params.usageEndpoint, model: params.model, status: res.status, latencyMs, error: errorText });
        recordUsage({ endpoint: params.usageEndpoint, model: params.model, status: res.status, latencyMs, inputChars: params.userContent.length, errorText });
        throw new Error(`Podcast ${params.stage} generation failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
      }

      const { content, usage, finishReason } = parseChatCompletionStream(res.body);
      recordUsage({ endpoint: params.usageEndpoint, model: params.model, status: res.status, latencyMs, inputChars: params.userContent.length, usageJson: { ...usage, finish_reason: finishReason ?? null } });
      span.setAttributes({
        "llm.output_tokens": usage?.completion_tokens ?? undefined,
        // Only when the stream carried one — an empty string would read as a value on the dashboard.
        ...(finishReason && { "llm.finish_reason": finishReason }),
      });
      if (!content.trim()) {
        // Surface it on the span too: a retry keeps the job alive, but the
        // stage-health tile must see that this call produced nothing.
        span.setStatus("error", `empty content (finish_reason=${finishReason ?? "unknown"})`);
        log.warn("podcast writer returned no content", { stage: params.stage, finishReason, completionTokens: usage?.completion_tokens ?? null, latencyMs });
      }
      return content;
    },
    "client",
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Write a full two-host podcast script from source notes: one outline call
 * decides the episode's shape, then every segment is written in parallel
 * (bounded by `opts.concurrency`) against the shared outline for continuity.
 */
/**
 * Call the writer and parse its reply, retrying the WHOLE call once when the
 * JSON does not parse. The writer model is non-deterministic and occasionally
 * returns malformed JSON (observed 2026-09-02: an outline that ended mid-string
 * although the stream completed with a usage chunk); a second attempt is far
 * cheaper than failing a job that has not synthesized a second of audio yet.
 * On the final failure the full raw reply is logged so the shape of the
 * breakage is diagnosable from the logs alone.
 */
/**
 * Output budget for a writer call. claude-sonnet-5 on the IU endpoint thinks
 * before it answers on heavy prompts and that reasoning is invisible in the
 * stream but counted against `max_completion_tokens` (measured 2026-09-02: a
 * 5.8k-char revision cost 8.7k completion tokens; at 10.4k the reply came back
 * EMPTY with finish_reason=length). Budgets are therefore sized for reasoning
 * plus text, and a retry gets double.
 */
function writerBudget(visibleTokens: number, attempt: number): number {
  const reasoningHeadroom = 16000;
  return Math.min(64000, (visibleTokens + reasoningHeadroom) * attempt);
}

async function callAndParse<T>(stage: string, call: (attempt: number) => Promise<string>, parse: (raw: string) => T, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = await call(attempt);
    try {
      return parse(raw);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        log.warn("podcast writer reply did not parse, retrying", { stage, attempt, chars: raw.length, error: message });
        continue;
      }
      log.error("podcast writer reply did not parse", { stage, attempt, chars: raw.length, error: message, raw });
    }
  }
  throw lastError;
}

/**
 * Run every reviewer role (dramaturge, conversation coach, fact & speech
 * editor) on EVERY listed review model, all in parallel — one call per
 * role×model combo — and flatten their notes, each tagged with its
 * `reviewer` (`<role>@<model>`). Each reviewer's one-line verdict is logged
 * for visibility even though it isn't otherwise consumed.
 */
async function reviewEpisode(params: {
  req: PodcastScriptRequest;
  outline: Outline;
  segments: ScriptSegment[];
  reviewModels: string[];
  showBible: string;
  onProgress?: ScriptWriterOptions["onProgress"];
}): Promise<ReviewNote[]> {
  const { req, outline, segments, reviewModels, showBible, onProgress } = params;
  const combos = REVIEWER_ROLES.flatMap((role) => reviewModels.map((model) => ({ role, model })));
  let done = 0;
  const perCombo = await synthConcurrent(combos.length, combos, async ({ role, model }) => {
    const reviewer = `${role}@${model}`;
    let notes: ReviewNote[] = [];
    try {
      const result = await callAndParse(
        `review ${reviewer}`,
        (attempt) =>
          callWriterLlm({
            model,
            systemPrompt: reviewPrompt({ req, outline, role, showBible }),
            userContent: buildReviewUserContent({ req, outline, segments }),
            // Reviewers read source + outline + the whole draft and the writer
            // model reasons before it answers; at 6000 all three came back with
            // EMPTY content (2026-09-02) — the budget was spent on reasoning.
            maxCompletionTokens: writerBudget(4000, attempt),
            stage: "review",
            usageEndpoint: "podcast-review",
            reviewer,
          }),
        (raw) => parseReviewNotes(raw, reviewer),
      );
      notes = result.notes;
      log.info("podcast review verdict", { reviewer, verdict: result.verdict, notes: notes.length });
    } catch (err) {
      // A review is polish, not the episode: a reviewer that fails twice is
      // skipped and the draft stands, rather than failing a job whose script
      // and outline already exist.
      log.warn("podcast reviewer skipped", { reviewer, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    onProgress?.("review", done, combos.length);
    return notes;
  });
  return perCombo.flat();
}

/**
 * Rewrite every segment that received at least one targeted note (see
 * {@link segmentNotesFor}), in parallel, bounded by `concurrency`. A segment
 * with no notes keeps its original turns and makes no LLM call.
 */
async function reviseSegments(params: {
  req: PodcastScriptRequest;
  outline: Outline;
  segments: ScriptSegment[];
  notes: ReviewNote[];
  model: string;
  concurrency: number;
  showBible: string;
  onProgress?: ScriptWriterOptions["onProgress"];
}): Promise<ScriptSegment[]> {
  const { req, outline, segments, notes, model, concurrency, showBible, onProgress } = params;
  const total = segments.length;
  const toRevise = segments.map((_, index) => index).filter((index) => segmentNotesFor(notes, index).length > 0);
  onProgress?.("revise", 0, toRevise.length);
  if (toRevise.length === 0) return segments;

  const revisedByIndex = new Map<number, ScriptTurn[]>();
  let done = 0;
  await synthConcurrent(concurrency, toRevise, async (index) => {
    const segmentSpec = outline.segments[index];
    if (!segmentSpec) throw new Error(`outline segment ${index} out of range`);
    const segmentNotes = segmentNotesFor(notes, index);
    try {
      const turns = await callAndParse(
        `revise ${index + 1}`,
        (attempt) =>
          callWriterLlm({
            model,
            systemPrompt: revisionPrompt({ req, outline, segment: segmentSpec, index, total, showBible }),
            userContent: buildRevisionUserContent({ req, outline, segments, index, notes: segmentNotes }),
            maxCompletionTokens: writerBudget(segmentSpec.targetWords * 6, attempt),
            stage: "revise",
            usageEndpoint: "podcast-segment",
          }),
        (raw) => sanitizeTurns(parseSegmentTurns(raw)),
      );
      // An empty revision is a failed one — never replace a written segment with nothing.
      if (turns.length > 0) revisedByIndex.set(index, turns);
    } catch (err) {
      // The draft segment stands; a revision that fails twice is polish lost, not an episode lost.
      log.warn("podcast revision skipped, keeping draft segment", { index, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    onProgress?.("revise", done, toRevise.length);
  });

  return segments.map((seg, index) => {
    const turns = revisedByIndex.get(index);
    return turns ? { ...seg, turns } : seg;
  });
}

// ---------------------------------------------------------------------------
// Metadata pass (final title/description/cover prompt/genres/chapter titles)
// ---------------------------------------------------------------------------

/** A chapter title from the metadata pass, replacing the outline's working segment title. */
interface EpisodeChapter {
  segmentIndex: number;
  title: string;
}

interface EpisodeMetadata {
  title: string;
  description: string;
  coverPrompt: string;
  genres: string[];
  chapters: EpisodeChapter[];
}

function metadataPrompt(req: PodcastScriptRequest): string {
  const languageLabel = LANGUAGE_LABEL[req.language];
  return `You are the final METADATA EDITOR for "${req.series}", writing publish-ready metadata for one finished, locked two-host podcast episode. You get the finished script, the story outline's draft title/description/cover prompt, and the listener brief. Your job is to sharpen the drafts into what actually ships — reflecting what the FINISHED episode delivers, not what was planned — and to write one chapter title per segment for the episode's audio chapter markers.
- title: punchy, accurate to the finished episode, in ${languageLabel}.
- description: 2 to 4 sentences, show-notes style, in ${languageLabel}, written for someone deciding whether to press play.
- cover_prompt: a concrete, painterly, text-free square podcast-cover brief in English, for a German travel/knowledge show — the concrete subject and the mood.
- genres: 1 to 3 short English genre labels.
- chapters: exactly one entry per segment, in order, each a short chapter title (max 6 words) in ${languageLabel} that reflects what actually happens in that segment.
You never rewrite the script — you only produce metadata about it.

Return STRICT JSON only, no markdown, no commentary:
{"title":"<episode title>","description":"<2-4 sentence show-notes description in ${languageLabel}>","cover_prompt":"<English image brief>","genres":["..."],"chapters":[{"segment":<0-based segment index>,"title":"<chapter title, max 6 words>"}]}`;
}

function buildMetadataUserContent(params: { req: PodcastScriptRequest; outline: Outline; segments: ScriptSegment[] }): string {
  const { req, outline, segments } = params;
  const parts = [
    req.brief ? `BRIEF (who the listener is / what they want from this episode): ${req.brief}` : undefined,
    `OUTLINE DRAFTS (for reference only — the finished episode may have moved beyond these):\nTitle: ${outline.title}\nDescription: ${outline.description}\nCover prompt: ${outline.coverPrompt}`,
    `FINISHED SCRIPT (final, as spoken):\n${renderDraftForReview(segments, req.hosts)}`,
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n\n");
}

/**
 * Parse the metadata LLM's reply. Same fence/prose tolerance as
 * {@link parseOutline}; a chapter missing its title or segment index is
 * dropped, `segment` is clamped onto a real segment.
 */
export function parseEpisodeMetadata(raw: string, segmentCount: number): EpisodeMetadata {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    title?: unknown;
    description?: unknown;
    cover_prompt?: unknown;
    genres?: unknown;
    chapters?: unknown;
  };
  const chaptersRaw = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const chapters: EpisodeChapter[] = [];
  for (const item of chaptersRaw) {
    const obj = (item ?? {}) as Record<string, unknown>;
    const title = typeof obj["title"] === "string" ? obj["title"].trim() : "";
    if (!title || typeof obj["segment"] !== "number") continue;
    chapters.push({ segmentIndex: clampSegmentIndex(obj["segment"], segmentCount), title });
  }
  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() : "",
    description: typeof parsed.description === "string" ? parsed.description.trim() : "",
    coverPrompt: typeof parsed.cover_prompt === "string" ? parsed.cover_prompt.trim() : "",
    genres: Array.isArray(parsed.genres) ? parsed.genres.filter((g): g is string => typeof g === "string") : [],
    chapters,
  };
}

/**
 * Write the episode's final title/description/cover prompt/genres/chapter
 * titles from the LOCKED script. Metadata is polish, not the episode: on
 * failure (after the usual retry) the caller falls back to the outline's
 * drafts and logs a warning rather than failing the job.
 */
async function writeEpisodeMetadata(params: { req: PodcastScriptRequest; outline: Outline; segments: ScriptSegment[]; model: string }): Promise<EpisodeMetadata> {
  const { req, outline, segments, model } = params;
  return callAndParse(
    "metadata",
    (attempt) =>
      callWriterLlm({
        model,
        systemPrompt: metadataPrompt(req),
        userContent: buildMetadataUserContent({ req, outline, segments }),
        maxCompletionTokens: writerBudget(4000, attempt),
        stage: "metadata",
        usageEndpoint: "podcast-metadata",
      }),
    (raw) => parseEpisodeMetadata(raw, segments.length),
  );
}

export async function writePodcastScript(req: PodcastScriptRequest, opts: ScriptWriterOptions): Promise<PodcastScript> {
  const segmentCount = planSegmentCount(req.minutes);
  const targetWords = Math.round(req.minutes * WORDS_PER_MINUTE);
  const review = opts.review ?? true;
  const metadataEnabled = opts.metadata ?? true;
  const showBible = opts.showBiblePath ? await loadShowBible(opts.showBiblePath) : "";

  opts.onProgress?.("outline", 0, 1);
  const outline = await callAndParse(
    "outline",
    (attempt) =>
      callWriterLlm({
        model: opts.models.outline,
        systemPrompt: outlinePrompt(req, segmentCount, targetWords, showBible),
        userContent: buildOutlineUserContent(req),
        // The outline for a 20-minute episode over a 20k-char source is several
        // thousand tokens of verbatim key_facts, and the writer model's reasoning
        // counts against the same budget: 6000 was hit exactly (2026-09-02) and the
        // truncated JSON failed to parse. Sized for the worst case, not the average.
        maxCompletionTokens: writerBudget(8000, attempt),
        stage: "outline",
        usageEndpoint: "podcast-outline",
      }),
    (raw) => normalizeOutlineTargets(parseOutline(raw), targetWords),
  );
  opts.onProgress?.("outline", 1, 1);

  const total = outline.segments.length;
  let segmentsDone = 0;
  const segments = await synthConcurrent(opts.concurrency, outline.segments, async (segmentSpec, index) => {
    const turns = await callAndParse(
      `segment ${index + 1}`,
      (attempt) =>
        callWriterLlm({
          model: opts.models.write,
          systemPrompt: segmentPrompt({ req, outline, segment: segmentSpec, index, total, previous: outline.segments[index - 1], showBible }),
          userContent: buildSegmentUserContent({ req, outline, index }),
          // Generous headroom (not just words*4): claude-sonnet-5 was observed truncating a
          // segment reply mid-array under the tighter budget (words*4 + 1500), producing an
          // unterminated JSON array — extractJsonObject's naive "last }" then grabs an inner
          // object's closing brace and JSON.parse throws "Expected ']'" (smoke-tested 2026-09-01).
          maxCompletionTokens: writerBudget(segmentSpec.targetWords * 6, attempt),
          stage: "segment",
          usageEndpoint: "podcast-segment",
        }),
      (raw) => sanitizeTurns(parseSegmentTurns(raw)),
    );
    segmentsDone++;
    opts.onProgress?.("segment", segmentsDone, total);
    return { title: segmentSpec.title, turns } satisfies ScriptSegment;
  });

  let finalSegments = segments;
  const reviewNotes = review
    ? await reviewEpisode({ req, outline, segments, reviewModels: opts.models.review, showBible, onProgress: opts.onProgress })
    : [];
  const notes = [...reviewNotes, ...lengthNotes(segments, outline)];
  if (notes.length > 0) {
    finalSegments = await reviseSegments({ req, outline, segments, notes, model: opts.models.write, concurrency: opts.concurrency, showBible, onProgress: opts.onProgress });
  }
  // A revision that was asked to cut and still didn't: one more pass on those
  // segments only, with nothing but the cut on the table.
  const stillLong = lengthNotes(finalSegments, outline);
  if (stillLong.length > 0) {
    log.warn("podcast segments still over length after revision, tightening", { segments: stillLong.map((n) => n.segmentIndex) });
    finalSegments = await reviseSegments({ req, outline, segments: finalSegments, notes: stillLong, model: opts.models.write, concurrency: opts.concurrency, showBible, onProgress: opts.onProgress });
  }

  const wordCount = finalSegments.reduce((sum, seg) => sum + seg.turns.reduce((s, t) => s + countWords(t.text), 0), 0);

  let title = outline.title || req.title || req.series;
  let description = outline.description;
  let coverPrompt = outline.coverPrompt;
  let genres = outline.genres;
  let publishedSegments = finalSegments;

  if (metadataEnabled) {
    opts.onProgress?.("metadata", 0, 1);
    try {
      const metadata = await writeEpisodeMetadata({ req, outline, segments: finalSegments, model: opts.models.metadata });
      // Field by field: a structurally valid reply with a blank field must
      // not blank the episode — the outline's draft stands for that field.
      title = metadata.title || title;
      description = metadata.description || description;
      coverPrompt = metadata.coverPrompt || coverPrompt;
      genres = metadata.genres.length > 0 ? metadata.genres : genres;
      if (metadata.chapters.length > 0) {
        const chapterTitleByIndex = new Map(metadata.chapters.map((c) => [c.segmentIndex, c.title]));
        publishedSegments = finalSegments.map((seg, index) => {
          const chapterTitle = chapterTitleByIndex.get(index);
          return chapterTitle ? { ...seg, title: chapterTitle } : seg;
        });
      }
    } catch (err) {
      // Metadata is polish, not the episode: fall back to the outline's own
      // drafts (still shipped in `outline`) rather than failing the job.
      log.warn("podcast metadata pass failed, falling back to outline values", { error: err instanceof Error ? err.message : String(err) });
    }
    opts.onProgress?.("metadata", 1, 1);
  }

  return {
    title,
    description,
    coverPrompt,
    genres,
    language: req.language,
    segments: publishedSegments,
    wordCount,
  };
}
