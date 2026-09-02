import { synthConcurrent } from "./gemini-tts-core";
import { rawFetch } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { withSpan } from "./otel";
import { recordUsage } from "./usage";

// Podcast script writer: turns a person's research notes into a two-host
// podcast episode. Two-pass generation — one outline call decides the shape
// of the episode, then a parallel call per segment writes the actual dialog.
// Pure, config-free otherwise: every knob (model, concurrency, language,
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
  /** OpenAI-dialect chat model id on the IU endpoint. */
  model: string;
  /** Parallel segment writes. */
  concurrency: number;
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

export interface Outline {
  title: string;
  description: string;
  coverPrompt: string;
  genres: string[];
  /** The running joke or motif the outline wants the hosts to return to across the episode. */
  motif: string;
  segments: OutlineSegmentSpec[];
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

const WORDS_PER_MINUTE = 150;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 9;
const MINUTES_PER_SEGMENT = 4;
const DEFAULT_SPLIT_MAX_CHARS = 1400;
/** A turn shorter than this is a fragment ("Echt?", "Mhm.") worth folding into its neighbour. */
const MERGE_SHORT_TURN_CHARS = 40;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** ~4 minutes per segment, clamped to a sane 3..9 range regardless of episode length. */
export function planSegmentCount(minutes: number): number {
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(minutes / MINUTES_PER_SEGMENT)));
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

/**
 * Parse the outline LLM's reply into an {@link Outline}. Tolerant of markdown
 * fences and leading prose (see `extractJsonObject`); missing/malformed
 * per-segment fields fall back to safe defaults rather than throwing, since a
 * partially-broken outline is still usable — only a wholly missing
 * `segments` array is fatal.
 */
export function parseOutline(raw: string): Outline {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    title?: unknown;
    description?: unknown;
    cover_prompt?: unknown;
    genres?: unknown;
    motif?: unknown;
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
    segments,
  };
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

/** Break one over-long turn into consecutive turns by the SAME speaker, at sentence boundaries. */
function splitLongTurn(turn: ScriptTurn, maxChars: number): ScriptTurn[] {
  if (turn.text.length <= maxChars) return [turn];
  const sentences = splitSentences(turn.text);
  const out: ScriptTurn[] = [];
  let buf = "";
  for (const sentence of sentences) {
    const merged = buf ? `${buf} ${sentence}` : sentence;
    if (buf && merged.length > maxChars) {
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
export function sanitizeTurns(turns: ScriptTurn[], maxChars = DEFAULT_SPLIT_MAX_CHARS): ScriptTurn[] {
  const cleaned = turns
    .map((t) => ({ speaker: t.speaker, text: collapseWhitespace(stripMarkdown(stripDisallowedTags(t.text))) }))
    .map((t) => ({ speaker: t.speaker, text: stripTagsOnShortTurn(t.text) }))
    .filter((t) => t.text.length > 0);
  const split = cleaned.flatMap((t) => splitLongTurn(t, maxChars));
  return mergeShortAdjacent(split, maxChars);
}

const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const LANGUAGE_LABEL: Record<"de" | "en", string> = { de: "German", en: "English" };

/** The shared, non-negotiable rules — identical for the outline and every segment call. */
function baseSystemPrompt(req: PodcastScriptRequest): string {
  const [hostA, hostB] = req.hosts;
  const languageLabel = LANGUAGE_LABEL[req.language];
  return `You are the head writer of "${req.series}", a two-host podcast that turns one person's research notes into an episode that sounds like a real, well-produced show — not a read-aloud summary.

Hosts: A = ${hostA.name} — has studied the SOURCE inside out (the notes belong to the listener or a third party, never to the host; never claim to have written or researched them); knows the plan, the numbers, the trade-offs; warm, precise, occasionally dry. B = ${hostB.name} — the curious co-host; asks what the listener would ask, pushes back, plays devil's advocate, summarizes in plain words, brings the human angle ("wie fühlt sich das an, wenn…"). Both are the listener's friends, on a first-name basis, addressing the listener as "du" (German) / "you". Neither is an assistant; nobody says "als KI".

Non-negotiables:
1. Every fact, number, place name, price, date and rule comes from the SOURCE. Never invent. If the source flags something as open/unverified, the hosts say so ("das ist noch offen"). You may add widely-known general context only when it helps understanding and is clearly framed as general ("grundsätzlich…").
2. Real-podcast texture: cold open with a concrete hook (a striking number or a scene), a short natural intro, signposting between topics, callbacks to earlier points, at least one genuine disagreement or "wait, really?" moment per segment, one running joke or motif across the episode, and a wrap-up with three concrete takeaways plus the open questions. Banter is fine but never filler — every exchange moves a fact or a decision forward.
3. It is a CONVERSATION with real weight, not ping-pong. Give the explaining host room: about half of all turns are 40-120 words (a complete thought, two to five sentences), and every segment contains at least two longer passages of 100-160 words where one host walks something through end to end while the other only reacts afterwards. Short interjections ("Echt?", "Moment.", "Mhm.") are the exception — at most one turn in five, never two in a row. Never alternate one sentence each; that rhythm sounds synthetic. Host A carries roughly 60% of the words. Hard max 180 words per turn. No lists read aloud — turn any list into back-and-forth or a walked-through explanation.
4. Written for the EAR in ${languageLabel}: numbers, prices, times, units, dates and abbreviations fully spelled out as spoken (German: "dreihundertdreißig Euro", "hundertfünf Stundenkilometer", "elfter September", "zwei Meter fünfzig"); no digits, no symbols, no URLs, no markdown, no emoji, no parentheses. Place names in their local form. Expand every acronym once.
5. Expressiveness comes from punctuation first — ellipses, dashes, short sentences, a question left hanging. ElevenLabs v3 audio tags ONLY from this list: ${V3_PODCAST_TAGS.join(" ")}. Very sparse: at most one tag every six turns, only inside turns of twelve words or more, placed at the start of a sentence in the middle of the turn — never as the first word of a short line, never translated, never invented. Most turns carry NO tag.
6. The episode is for the listener described in the brief; when the notes are the listener's own plan, the hosts talk about it as THEIR listener's plan ("du fährst…", "dein Van…") and give advice, not a travelogue.
7. Output STRICT JSON only, no commentary, no code fences.`;
}

function outlinePrompt(req: PodcastScriptRequest, segmentCount: number, targetWords: number): string {
  const languageLabel = LANGUAGE_LABEL[req.language];
  return `${baseSystemPrompt(req)}

You are writing the OUTLINE for this episode.
- Produce exactly ${segmentCount} segments. The first segment is the cold open plus a short intro to the show and its hosts; the last segment is the wrap-up (three concrete takeaways, the open questions, and a sign-off).
- The segments' target_words must sum to about ${targetWords} words in total (roughly ${Math.round(targetWords / segmentCount)} per segment) — the whole episode is meant to run about ${req.minutes} minutes at roughly ${WORDS_PER_MINUTE} spoken words per minute.
- cover_prompt: a concrete, painterly, text-free square podcast-cover brief in English, mentioning the subject and mood.
- genres: 1 to 3 short English genre labels (e.g. "Travel", "Planning").
- motif: one running joke or motif the hosts can return to, lightly, across the episode — since segments are written independently, this is the only thread tying them together.
- Every key_facts entry must be a fact, number or rule taken verbatim (or near-verbatim) from the source — these are the load-bearing details each segment MUST speak aloud.

Return STRICT JSON only, no markdown, no commentary:
{"title":"<episode title>","description":"<2-4 sentence show-notes description in ${languageLabel}>","cover_prompt":"<English image brief>","genres":["..."],"motif":"<the running joke or motif the hosts return to across the episode>","segments":[{"title":"<segment title>","goal":"<what this segment accomplishes>","key_facts":["<verbatim fact from the source>"],"target_words":<number>,"tension":"<the question or disagreement this segment turns on>"}]}`;
}

function segmentPrompt(params: {
  req: PodcastScriptRequest;
  outline: Outline;
  segment: OutlineSegmentSpec;
  index: number;
  total: number;
  previous?: OutlineSegmentSpec;
}): string {
  const { req, outline, segment, index, total, previous } = params;
  const bridgeInstruction = index === 0
    ? "This is the FIRST segment — open with the cold open hook, then a short natural intro to the show and its two hosts."
    : `The previous segment ended aiming at: "${previous?.goal ?? ""}". Open with a natural bridge from that into this segment — never re-introduce the show.`;
  const wrapInstruction = index === total - 1
    ? "This is the LAST segment — end with three concrete takeaways, the open questions, and a warm sign-off."
    : "End this segment with a hand-off / teaser into the next topic — never a final sign-off.";

  return `${baseSystemPrompt(req)}

You are writing ONE SEGMENT (${index + 1} of ${total}) of the episode "${outline.title}".
Write ONLY this segment: "${segment.title}". Target about ${segment.targetWords} words.
Segment goal: ${segment.goal}
Central tension for this segment: ${segment.tension}
Key facts this segment MUST speak, verbatim where possible:
${segment.keyFacts.map((f) => `- ${f}`).join("\n")}
${outline.motif ? `\nRunning motif of the episode (return to it once, lightly, if it fits): ${outline.motif}\n` : ""}
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

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    req.brief ? `BRIEF: ${req.brief}` : undefined,
    `FULL EPISODE OUTLINE (for continuity — you are writing only segment ${index + 1} of ${outline.segments.length}):\n${outline.segments
      .map((s, i) => `${i + 1}. ${s.title} — ${s.goal}`)
      .join("\n")}`,
    previous ? `PREVIOUS SEGMENT (for the bridge — do not repeat it): "${previous.title}" — ended aiming at: ${previous.goal}` : undefined,
    `THIS SEGMENT'S SPEC:\nTitle: ${segment.title}\nGoal: ${segment.goal}\nTension: ${segment.tension}\nTarget words: ${segment.targetWords}\nKey facts to speak:\n${segment.keyFacts
      .map((f) => `- ${f}`)
      .join("\n")}`,
  ].filter((p): p is string => Boolean(p));
  return parts.join("\n\n");
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
export function parseChatCompletionStream(body: string): { content: string; usage?: OpenAiUsage } {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("data:") && !trimmed.startsWith("event:") && !trimmed.startsWith(":")) {
    const json = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }>; usage?: OpenAiUsage };
    return { content: json.choices?.[0]?.message?.content ?? "", usage: json.usage };
  }
  let content = "";
  let usage: OpenAiUsage | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: OpenAiUsage | null;
    };
    content += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) usage = chunk.usage;
  }
  return { content, usage };
}

async function callWriterLlm(params: {
  model: string;
  systemPrompt: string;
  userContent: string;
  maxCompletionTokens: number;
  stage: "outline" | "segment";
  usageEndpoint: "podcast-outline" | "podcast-segment";
}): Promise<string> {
  return withSpan(
    "audio.podcast.llm",
    { "llm.model": params.model, "audio.podcast.stage": params.stage },
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

      const { content, usage } = parseChatCompletionStream(res.body);
      recordUsage({ endpoint: params.usageEndpoint, model: params.model, status: res.status, latencyMs, inputChars: params.userContent.length, usageJson: usage });
      span.setAttributes({ "llm.output_tokens": usage?.completion_tokens ?? undefined });
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
async function callAndParse<T>(stage: string, call: () => Promise<string>, parse: (raw: string) => T, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = await call();
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

export async function writePodcastScript(req: PodcastScriptRequest, opts: ScriptWriterOptions): Promise<PodcastScript> {
  const segmentCount = planSegmentCount(req.minutes);
  const targetWords = Math.round(req.minutes * WORDS_PER_MINUTE);

  opts.onProgress?.("outline", 0, 1);
  const outline = await callAndParse(
    "outline",
    () =>
      callWriterLlm({
        model: opts.model,
        systemPrompt: outlinePrompt(req, segmentCount, targetWords),
        userContent: buildOutlineUserContent(req),
        // The outline for a 20-minute episode over a 20k-char source is several
        // thousand tokens of verbatim key_facts, and the writer model's reasoning
        // counts against the same budget: 6000 was hit exactly (2026-09-02) and the
        // truncated JSON failed to parse. Sized for the worst case, not the average.
        maxCompletionTokens: 20000,
        stage: "outline",
        usageEndpoint: "podcast-outline",
      }),
    parseOutline,
  );
  opts.onProgress?.("outline", 1, 1);

  const total = outline.segments.length;
  let segmentsDone = 0;
  const segments = await synthConcurrent(opts.concurrency, outline.segments, async (segmentSpec, index) => {
    const turns = await callAndParse(
      `segment ${index + 1}`,
      () =>
        callWriterLlm({
          model: opts.model,
          systemPrompt: segmentPrompt({ req, outline, segment: segmentSpec, index, total, previous: outline.segments[index - 1] }),
          userContent: buildSegmentUserContent({ req, outline, index }),
          // Generous headroom (not just words*4): claude-sonnet-5 was observed truncating a
          // segment reply mid-array under the tighter budget (words*4 + 1500), producing an
          // unterminated JSON array — extractJsonObject's naive "last }" then grabs an inner
          // object's closing brace and JSON.parse throws "Expected ']'" (smoke-tested 2026-09-01).
          maxCompletionTokens: Math.round(segmentSpec.targetWords * 8 + 3000),
          stage: "segment",
          usageEndpoint: "podcast-segment",
        }),
      (raw) => sanitizeTurns(parseSegmentTurns(raw)),
    );
    segmentsDone++;
    opts.onProgress?.("segment", segmentsDone, total);
    return { title: segmentSpec.title, turns } satisfies ScriptSegment;
  });

  const wordCount = segments.reduce((sum, seg) => sum + seg.turns.reduce((s, t) => s + countWords(t.text), 0), 0);

  return {
    title: outline.title || req.title || req.series,
    description: outline.description,
    coverPrompt: outline.coverPrompt,
    genres: outline.genres,
    language: req.language,
    segments,
    wordCount,
  };
}
