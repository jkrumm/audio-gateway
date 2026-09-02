# Podcast pipeline — design

Turns a pile of research notes into a two-host, long-form podcast episode: outline → per-segment
dialogue → per-turn ElevenLabs synthesis → gapped concat → loudness-normalised, chaptered MP3 →
optional cover art → optional Audiobookshelf publish. One HTTP `POST /v1/podcasts` kicks off a job
that runs in the background; `GET /v1/podcasts/:id` polls it. See `src/podcasts.ts` for the
orchestrator and `README.md` for the API/CLI surface.

## Two-pass writer (`src/podcast-script.ts`)

A single outline call decides the episode's shape — title, description, cover prompt, genres, a
running `motif`, and `planSegmentCount(minutes)` segments (~4 minutes each, clamped to 3–9), each
with a goal, verbatim `key_facts` pulled from the source, a target word count, and the central
tension it turns on. Every segment is then written by its OWN LLM call, in parallel
(`synthConcurrent`, concurrency 3) — each call gets the full outline for continuity, the previous
segment's goal for the bridge, and the shared `motif` (segments can't co-write a running joke since
they're generated concurrently, so the outline hands each one the same thread to lightly return to).
The first segment opens cold + intros the show; the last wraps with three takeaways and a sign-off;
every other segment ends on a hand-off, never a conclusion.

The system prompt is one shared contract (`baseSystemPrompt`): every fact must come from the source,
numbers and abbreviations are spelled out for the ear, and ElevenLabs v3 audio tags are used sparingly
from a fixed allow-list (`V3_PODCAST_TAGS`) — at most one every six turns, only inside turns of twelve
words or more. Turn length and rhythm are NOT quota-driven — see "Writers' room" below for why.
`sanitizeTurns` strips any tag outside the allow-list, strips markdown/emoji, splits any turn over
~1400 chars OR ~180 words at sentence boundaries (same speaker), and folds a short leading fragment
("Echt?") into its same-speaker predecessor.

## Writers' room: dramaturgy, review and revision (`src/podcast-script.ts`)

A two-pass writer (outline → parallel segments) reliably produces on-topic dialogue, but it reads like
a report given quotas, not a conversation with a shape — the rhythm rules used to be numeric ("half of
all turns 40–120 words", "Host A carries 60%"), which produces mechanically-varied but still
structureless text. The writer is now a small "writers' room": the outline plans the story, not just
the facts; segments are written with qualitative rather than numeric direction; and two further passes
critique and repair the whole draft before it goes to synthesis. All of this is optional
(`ScriptWriterOptions.review`, default `true`) — set it to `false` to fall back to the original
outline-then-segments behavior (used by the test suite for cheap runs).

**1. Story pass (outline).** Beyond title/description/genres/motif, the outline now plans dramaturgy:
a `through_line` (the one question the episode is really answering, revealed progressively — the
hosts circle it, they never state it up front), a `hook` (the concrete cold-open beat — a scene, a
number, a live disagreement — that must NOT summarize the episode or preview the takeaways),
`reveals` (2–4 facts/decisions/twists deliberately withheld, each pinned to the segment index where
it lands), and `digressions` (2–4 planned side-trips — a joke, an anecdote, an example, a "what if" —
each pinned to a segment index plus a one-line `return_hook` back to the thread). All four fields
default to blank/empty when a reply omits them, so older fixtures and outlines still parse.

**2. Segment pass.** The rhythm rule in `baseSystemPrompt` is qualitative, not numeric: whoever is
explaining gets the floor for as long as the thought needs, the other host reacts with weight rather
than a one-liner, and the rhythm is varied on purpose — a long stretch, a quick exchange, a pause, a
digression that returns. The only hard limit left (~180 words / ~1400 chars per turn) is enforced in
code by `sanitizeTurns`, not preached in the prompt — the model decides pacing, the code only stops
pathological output. Each segment call is fed just its own assigned reveals/digressions plus the
through-line, and an explicit list of reveals assigned to a LATER segment ("do not mention X yet — it
lands in segment N") so segments don't spoil each other despite being written in parallel.

**3. Review pass (multi-angle, parallel).** Three reviewer calls run over the whole draft at once, each
a distinct angle: the **dramaturge** (red thread, hook without spoilers, reveals landing on schedule,
digressions that return, pacing across the whole episode, an ending that earns its takeaways), the
**conversation coach** (does it sound like two people talking — real floor time, substantive reactions,
no mechanical alternation, distinct voices, humor that lands), and the **fact & speech editor** (every
fact traceable to the source, nothing from `key_facts` missing, numbers spelled out as spoken, one
breath per sentence, audio tags only from the allow-list and not overused). Each reviewer returns at
most ~12 specific, actionable notes plus a one-line verdict; a note targets a segment/turn index or the
whole episode (`segment: null`).

**4. Revision pass.** Only segments that received at least one note of their own are rewritten — an
episode-wide note alone does not trigger a rewrite, but once a segment IS being revised it also sees
every episode-wide note as extra context. Each revision call gets the segment's current turns, its
notes, and a few turns from each neighboring segment for the seams, and returns the segment's full
turns again (not a diff). Segments with no notes are left untouched and cost no extra call.
`sanitizeTurns` runs a second time after revision.

**Cost/time trade.** The review + revision passes roughly double the writer-model token spend (three
whole-draft reviewer calls plus one revision call per segment that needed one) — still small in
absolute terms since the writer model is cheap and TTS synthesis dominates cost — and add roughly
1–2 minutes of wall-clock time to a job, mostly the three parallel reviewer calls plus whichever
revisions run (also parallel, bounded by the writer's `concurrency`).

## Per-turn synthesis (`src/podcast-synth.ts`)

`turnsForSynthesis` flattens a script's segments into turn order and maps each speaker to a fixed
per-host ElevenLabs voice (`PODCAST_VOICES`). Unlike the short-form TTS lane's prep-time chunking,
here EVERY turn is its own Replicate prediction — `previousText`/`nextText` are filled from the SAME
speaker's neighbouring turn (not the other host's line in between), capped at 600 chars, which is
what ElevenLabs uses for per-voice prosody continuity across a turn boundary. `synthesizeTurns` runs
them bounded by `TTS_CONCURRENCY`, reusing `synthReplicateChunk` (the same per-chunk synth+decode+
usage-recording code path as the short-form Replicate TTS lane) — order-preserving, fail-fast.

## Mux + master (`src/podcast-mux.ts`)

`concatWithGaps` stitches the turns' raw PCM together with digital silence between them —
`PODCAST_GAP_MS` normally, `PODCAST_SHORT_GAP_MS` when the turn is followed by a short interjection
(≤ 6 words), zero after the last turn — and returns each turn's start offset for chapter math.
`masterPodcastMp3` then runs one ffmpeg pass: `loudnorm=I=-16:TP=-1.5:LRA=11` (podcast-standard
loudness), downmix/resample to 44.1 kHz mono, encode to MP3 at `PODCAST_MP3_BITRATE`, and write
ID3v2.3 tags plus CHAP/CTOC chapters from an `;FFMETADATA1` document built by `buildFfmetadata`
(one `[CHAPTER]` per segment, from `chaptersFromSegments`). A cover, when present, is muxed in as an
attached picture in the SAME ffmpeg invocation — the ID3 header precedes the audio stream, so it
can't be patched in afterwards without a full remux, which is why cover generation runs BEFORE
mastering, not after.

## Cover (`src/cover.ts`) and publish (`src/audiobookshelf.ts`)

Cover art is a single call to the image-gen gateway's `/generate` endpoint using the outline's
`coverPrompt`. It is entirely best-effort: any failure (unconfigured, non-2xx, malformed response)
is logged and the episode masters without a cover — a missing picture must never fail a job.

Publishing uploads the finished MP3 into an Audiobookshelf podcast library: `POST /api/upload` into
the library's configured folder, `POST /api/libraries/:id/scan` to make ABS ingest it, then poll
`GET /api/libraries/:id/items` (by show title) until the uploaded filename shows up as an episode —
ABS has no synchronous "here's your item id" response to an upload, so this is unavoidable (poll
interval 2 s, 90 s deadline). Show-level metadata (title/author/description/genres/language) and the
cover are only written on first creation or when still empty, so a hand-edited show description is
never clobbered by a later episode's publish. A failure here (including the poll timing out) fails
the JOB, but never the MP3 — it's already on disk, so `POST /v1/podcasts/:id/publish` retries just
this stage.

## The one-job queue

`src/podcasts.ts` runs strictly one job's full pipeline at a time (an in-process FIFO) — this bounds
Replicate fan-out and memory on a 512 MB container; a single job can already run `TTS_CONCURRENCY`
synth calls plus ffmpeg concurrently. A `POST /v1/podcasts/:id/publish` retry runs OUTSIDE that
queue (it's a network upload, not CPU/memory heavy) but is still guarded against re-entering the
SAME job while its own pipeline (or a prior publish attempt) is still running — a second
request for that job gets `409`.

## Restart semantics

The job ledger is a `bun:sqlite` table (`podcast_job`), so job records survive a process restart, but
in-memory pipeline state does not — there is no resume. `recoverPodcastJobs()` runs once at boot
(`index.ts`'s `import.meta.main` block, before the server starts listening) and marks every job still
in a non-terminal status (`queued`/`scripting`/`synthesizing`/`mastering`/`cover`/`publishing`) as
`failed` with `error: "interrupted by restart"`. Its partial artifacts (if any made it to disk) are
left in place but orphaned; re-submit the source to generate a fresh episode. Graceful shutdown
(`SHUTDOWN_DRAIN_MS`) waits for a running job exactly like an in-flight HTTP request before exiting.

## Cost expectations

A ~20-minute episode is roughly: one outline call + 5–9 segment calls on `PODCAST_SCRIPT_MODEL`
(cheap — a few cents), ~60–120 ElevenLabs v3 turn syntheses (the dominant cost — v3 has no published
per-character rate, so this reports `cost_source: none` in the usage row even though it's the real
spend), and one optional image-gen cover call. Expect low-single-digit USD per episode depending on
length and host chattiness; review actual spend per job via the `cost_usd` field on
`GET /v1/podcasts/:id` (accumulated across every billed call made during that job's request context —
see `usage.ts`'s `accumulateRequestCost`) or `bun run usage:tail` for the `podcast-request` summary
row.

## Knobs (`config.ts`)

| Env var | Default | Effect |
|-|-|-|
| `PODCAST_SCRIPT_MODEL` | `claude-sonnet-5` | Outline + segment writer model (IU chat endpoint). |
| `PODCAST_TTS_MODEL` | `elevenlabs/v3` | Replicate model for per-turn synthesis. |
| `PODCAST_VOICES` | `Mark,Sarah` | The two hosts' ElevenLabs voices, in host order. |
| `PODCAST_HOST_NAMES` | `Jonas,Lena` | The two hosts' display names, same order. |
| `PODCAST_DEFAULT_MINUTES` | `20` | Episode length when a request omits `minutes` (clamped 3–60). |
| `PODCAST_STABILITY` | `0.45` | ElevenLabs v3 stability — lower is more tag-responsive. |
| `PODCAST_MP3_BITRATE` | `64` | Output MP3 bitrate (kbps) — mono speech, no music headroom needed. |
| `PODCAST_GAP_MS` / `PODCAST_SHORT_GAP_MS` | `380` / `160` | Silence between turns; short before an interjection. |
| `PODCAST_DATA_DIR` | `./data/podcasts` | Where per-job artifacts (`script.json`, `episode.mp3`, `cover.png`) are staged. |
| `PODCAST_DB` | `./data/podcasts.db` | Job ledger SQLite file. |
| `PODCAST_SERIES` | `Hermes Briefings` | Default show name when a request omits `series`. |
| `PODCAST_AUTHOR` | `Hermes` | Author/artist tag on published episodes. |
| `ABS_URL` / `ABS_API_KEY` / `ABS_LIBRARY` | unset / unset / `Podcasts` | Audiobookshelf base URL, API key, and target podcast library — unset disables publishing entirely. |
| `IMAGE_GEN_URL` / `IMAGE_GEN_API_KEY` | unset / unset | image-gen gateway for cover art — unset disables covers entirely. |

## Tuning after the first episode (2026-09-02)

Findings from the 22-minute Spain episode, checked against the ElevenLabs v3
docs and a research pass on production practice:

- **Tags read aloud.** v3 only reliably interprets the cues its docs list;
  `[thoughtful]`, `[emphasized]`, `[hesitates]` were spoken as words. The
  allowed set is now the official examples only, tags are dropped from turns
  under twelve words, and the writer is told "one tag every six turns, most
  turns none".
- **Ping-pong.** Median turn was 13 words, max 40 — mechanical alternation.
  The writer now targets half of all turns at 40–120 words plus two 100–160
  word passages per segment, interjections at most one in five.
- **Loudness.** Sarah's voice measured −17.6 LUFS against Mark's −24.8 on the
  same line. `matchHostLoudness` now levels each host to −20 LUFS (one gain per
  host over all their turns) before concatenation; the global loudnorm then
  lifts the programme to −16.
- **Stability.** v3 has three presets (0 Creative, 0.5 Natural, 1 Robust);
  `PODCAST_STABILITY` defaults to 0.5. `similarity_boost`/`style` have no
  documented effect on v3 and are passed through only because the Replicate
  schema accepts them.
- **Pace.** `PODCAST_SPEEDS` (default `0.94,1`) slows host A a notch; v3's
  documented range is 0.7–1.2.
- **Cost.** ElevenLabs lists v3 at $0.10 per 1k characters; a 22-minute
  episode is ~20k characters (~$2) plus roughly $0.50 of writer-model tokens
  and $0.05 for the cover.

## Writer budgets and reasoning (2026-09-02)

claude-sonnet-5 on the IU endpoint reasons before answering on heavy prompts,
and that reasoning is invisible in the stream but counted against
`max_completion_tokens` (a 5.8k-char revision: 8.7k completion tokens; at a
10.4k cap the reply came back empty with `finish_reason=length`). Budgets are
therefore `writerBudget(visible, attempt)` = (visible text + 16k headroom) ×
attempt, capped at 64k, so a parse-failure retry automatically doubles.
Writing stages (`segment`, `revise`) send `reasoning_effort: low` (same text,
~45 % fewer output tokens, faster); planning and reviewing keep the default.
`llm.finish_reason` is recorded on every writer span and usage row.
Review and revision are polish: a reviewer that fails twice is skipped, a
revision that fails keeps the draft segment. A running episode survives a
deploy: the VPS compose gives the old container a long `stop_grace_period`
and `SHUTDOWN_DRAIN_MS` covers a full job, so RollHook's replacement container
takes new traffic while the old one finishes.
