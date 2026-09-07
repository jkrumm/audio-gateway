# Podcast v2 — the editorial room

Design + build spec for the second generation of the podcast pipeline. Supersedes the
fixed dramaturgy described in `docs/podcast.md` ("Writers' room") and the "Aufbau, der sich
bewährt hat" section of the show bible. Status: **building** (2026-09-06).

## TLDR

Five produced episodes are the same episode. Not because the models are dumb, but because
`show-bible.md` and the outline prompt in `podcast-script.ts` *prescribe* one show: Jonas
explains (64–75 % of the words), Lena asks (15–36 question turns against 2–6), a number →
"Warte —" → explanation → "Willkommen bei Brain Sonderausgabe" cold open five times out of
five, a running joke, 2–4 digressions, three takeaways in Lena's words. v2 removes the
formula from the spec and puts an **editorial decision** in front of the writers' room:
a model reads the material, the listener brief and the profiles of the last episodes, and
decides format, roles, tone, humor, length and rhythm for *this* episode. Two more things
the pipeline lacked: **eyes** (the brain, past episodes, the research gateway, through
tool calls) and **memory** (an episode profile persisted per job and written back into the
brain as a transcript note).

The pipeline stays in this repo and stays dependency-free. It moves to the **Mac mini**,
because the brain is a filesystem there and nowhere else.

## Decisions

| # | Decision | Why |
|-|-|-|
| 1 | **No Mastra, no framework.** A ~150-line OpenAI-dialect tool loop over `fetch` (`src/llm-tools.ts`). | Mastra 1.x buys durable suspend/resume, human-in-the-loop and a provider router; we need none of those, already have retries (`rawFetch`), a job ledger, and hand-rolled OTel. It would also end the no-runtime-deps rule for a workflow the code already expresses as TypeScript. Research 2026-09-06: mastra.ai docs, `@mastra/core` 1.61. |
| 2 | **The mini runs podcasts, the VPS keeps STT/TTS.** Same image and code, a second instance on the mini (`:7719`, LaunchAgent, `secrets-run`). | The brain has no API — it is a git checkout on the mini (`dotfiles/docs/brain-access.md`); `research.jkrumm.com` is tailnet-only and the mini is on it; Hermes lives on the mini. Argo's audio stays in-cluster on the VPS untouched. A brain clone on the VPS would extend the vault's exposure to a third machine for no gain. |
| 3 | **Editorial brief is free-form, bounded only by hard limits.** Format, roles, humor, opening and rhythm are the model's call; code enforces tag vocabulary, turn ceilings, minute bounds and segment bounds. | The owner's ask: "die Modelle sind intelligent, die können intelligent entscheiden". A menu of formats would be the old formula with more entries. |
| 4 | **Tool calling on the OpenAI dialect, research model = `gpt-5.6-luna`**, editorial + outline = `claude-opus-5`, voice owner = `claude-opus-4-6`, reviewers `gemini-3.8-flash,gpt-5.6-luna`, metadata `gpt-5.6-luna`. All env-overridable. | modelpick `benchmark-tool-calling.ts` (2026-09-04): Luna 100 % tool success, cheapest capable ($0.20/$1.20 per M), 2–4× faster than Gemini 3.8 in multi-round loops. Claude ids were never benchmarked for tools. Gemini on the compat route needs its `thought_signature` echoed back verbatim — the loop does that generically by echoing the assistant message untouched. |
| 5 | **Memory lives in the job ledger; the brain gets a copy.** `episodeProfile` in `state_json`; transcript + profile frontmatter as a note under `Areas/Podcasts/`, committed and pushed best-effort. | The ledger is the only store both the editorial step and the `past_episodes` tool can read synchronously. The brain note is for the human and for future research-agent runs (it searches the brain). The mini may commit (`brain-sync` pushes anything ahead of upstream; the 03:30 sweep catches the rest). |
| 6 | **Numbers and names are a writer rule plus a synth rule.** Prompt: one figure per sentence, rounded unless precision is the point, anchored with a comparison, clusters walked through with pauses. Synth: turns above a number-word density threshold are synthesized ~6 % slower. | ElevenLabs v3 has no SSML `<break>`; `[pause]`/`[short pause]`, "…" and "—" are the documented pacing tools, `speed` 0.7–1.2 is per request and the Replicate route exposes it (already plumbed per turn). |
| 7 | **Every new stage is best-effort except the writers' room.** Research fails → write from the source alone. Editorial fails → a neutral default brief. Brain note fails → log. | An episode with no research beats no episode; the owner already treats cover/publish this way. |

## Pipeline

```
request ─▶ research ─▶ editorial ─▶ outline ─▶ segments ─▶ review ─▶ revise ─▶ metadata ─▶ synth ─▶ mux ─▶ cover ─▶ publish ─▶ brain note
             (tools)     (brief)                (voice owner)  (roster)   (voice owner)
```

Stages in bold are new; the rest exists and changes only where the brief now feeds it.

### 1. Research (`src/podcast-research.ts`, new)

A tool-calling loop (`runToolLoop`) on `config.podcastResearchModel`. System prompt: you are
the researcher of a two-host podcast; the SOURCE is the listener's own material; your job is
to make the writers' room *understand* it — not to rewrite it. Tools:

| Tool | Args | Returns | Backing |
|-|-|-|-|
| `brain_search` | `{ query: string, limit?: number }` | `[{ path, title, description, snippet, score }]` | Case-insensitive term scoring over `*.md` under `BRAIN_DIR` (walk, skip dotdirs); no obsidian-cli, no Obsidian.app dependency |
| `brain_read` | `{ path: string }` | `{ path, frontmatter, body }` (body capped at 60k chars) | Path must resolve inside `BRAIN_DIR` (reject `..` and symlink escapes) |
| `past_episodes` | `{ limit?: number }` | `[{ id, date, title, description, profile }]` for `done` jobs of the same series | `PodcastStore.recentEpisodes` |
| `past_transcript` | `{ id: string }` | markdown transcript (capped at 40k chars) | `renderTranscriptMarkdown` over the persisted script |
| `research` | `{ query: string, depth?: "quick" \| "standard" }` | `{ report, citations, sources }` | research-gateway REST: `POST {RESEARCH_GATEWAY_URL}/research/` → `{jobId}`, poll `GET /research/{jobId}` every 10 s until `done`/`failed`/`error`, 8-minute cap. Budget `config.podcastResearchMaxCalls` (default 2); the tool returns an error string once exhausted |

The loop ends when the model returns a final JSON object (no tool call). Round cap
`config.podcastToolMaxRounds` (default 12). Output:

```ts
interface Dossier {
  /** Consolidated summary of what the source is about, 3–8 sentences, for the editor. */
  summary: string;
  /** Material the writers may use IN ADDITION to the source; each item names where it came from. */
  additions: Array<{ source: string; text: string }>;   // "brain: Areas/Travel/…", "research: <query>", "episode: <id>"
  /** Names, places, terms the listener may not know — with the plain-words handle the hosts should use. */
  glossary: Array<{ term: string; plain: string }>;
  /** What earlier episodes already covered on this topic, so the writers don't repeat it. */
  priorCoverage: Array<{ episodeId: string; title: string; covered: string }>;
  openQuestions: string[];
  /** Which tools ran, for the job record and the OTel span. */
  toolCalls: Array<{ tool: string; args: unknown; ok: boolean; ms: number }>;
}
```

Skipped entirely (dossier = empty) when the request says `research: false`, or when neither
`BRAIN_DIR` nor `RESEARCH_API_KEY` is configured. `sourcePaths` (brain-relative) in the
request are read up front and appended to the source before the loop, so a caller can
say "make an episode from these three notes" without pasting them.

### 2. Editorial (`src/podcast-editorial.ts`, new)

One call on `config.podcastEditorialModel`, no tools. Input: dossier summary + glossary +
prior coverage, the listener `brief`, the requested `minutes` (hint, or pinned), the language,
the two hosts' *personalities* from the show bible, and the profiles of the last
`config.podcastHistoryDepth` (default 8) episodes. Output:

```ts
interface EpisodeBrief {
  /** Free-text format name in the episode language, e.g. "Erklärstück", "Streitgespräch", "Kurzbriefing", "Interview". */
  format: string;
  /** Why this format for this material, and what it deliberately does differently from the recent episodes. 2–5 sentences. */
  rationale: string;
  /** Target minutes. May deviate from the request when not pinned; clamped to [MIN_MINUTES, MAX_MINUTES]. */
  minutes: number;
  /** 1–9; clamped in code. */
  segments: number;
  /** What each host is in THIS episode. Either may lead; one may barely speak. */
  roles: { A: string; B: string };
  tone: string;
  humor: "none" | "sparse" | "natural";
  /** How the episode starts — free. "Kein Cold Open, direkt rein" is a valid answer. */
  opening: string;
  closing: string;
  /** Monologue share, pace, where the long explanations go, where quick exchanges belong. */
  rhythm: string;
  /** Dramaturgy devices worth using here — motif, reveals, digressions, a live disagreement. May be empty. */
  devices: string[];
  /** Patterns from recent episodes NOT to repeat. */
  avoid: string[];
  /** How to introduce unfamiliar names/terms in this episode (uses the glossary). */
  glossaryPolicy: string;
}
```

Prompt stance: *you are the editor, not the writer. The material decides the show. Vary
against the history on purpose — a technical topic gets a straight, dense walkthrough with
long turns and no jokes; a decision gets a debate; a five-minute topic gets five minutes.
Don't invent drama, don't invent a cold open, don't force a joke.* The history is presented
as a table (date, title, format, lead, humor, opening style, minutes). Parse failure or an
LLM error → `defaultEpisodeBrief(req)`: a neutral conversation, requested minutes, no forced
devices — never the old formula.

### 3. Writers' room changes (`src/podcast-script.ts`)

- `PodcastScriptRequest` gains `dossier: Dossier` and `episodeBrief: EpisodeBrief`.
  `planSegmentCount(minutes)` becomes the fallback only; `episodeBrief.segments` and
  `episodeBrief.minutes` drive the outline.
- `baseSystemPrompt`: non-negotiable 2 (the formula) is replaced by "The EPISODE BRIEF
  decides shape, roles, tone, humor and rhythm. Follow it exactly; it was written for this
  material." Non-negotiable 3 (weight, not ping-pong) stays. A new non-negotiable covers
  numbers and names (Decision 6), written for the ear:
  - one figure per sentence; round unless the precision *is* the point ("null Komma eins
    sieben" only when the digit matters); anchor every important figure with something the
    listener knows; a cluster of figures becomes a walked-through comparison with pauses
    ("…"), never a read-out;
  - an unfamiliar proper name is introduced as *what it is* before *what it's called*,
    slowly, and gets a handle the hosts reuse (the glossary supplies both);
  - open questions stay open and are said to be open.
- Outline prompt: segment count and minutes from the brief; `hook`, `motif`, `reveals`,
  `digressions` are **optional** and only filled when `episodeBrief.devices` asks for them
  (empty arrays / empty strings are valid); first- and last-segment behaviour comes from
  `episodeBrief.opening`/`closing`, not from a hardcoded cold open and three takeaways.
- Segment prompt: injects `roles`, `tone`, `humor`, `rhythm`, `glossaryPolicy`; the
  bridge/wrap instructions are derived from the brief.
- User content for outline/segments: `SOURCE` (verbatim, unchanged) + `ADDITIONS` (each
  with its provenance line) + `GLOSSARY` + `PRIOR COVERAGE (do not repeat)`.
- Reviewers: the dramaturge judges against *the brief*, not a fixed curve; the fact &
  speech editor additionally flags figure clusters and unintroduced names. Roles and roster
  unchanged otherwise.
- Metadata pass additionally returns `topics: string[]` (3–6 short labels) for the profile.
- Show bible (`docs/show-bible.md`): keep hosts' personalities, spoken-German rules, the
  forbidden list; drop "Aufbau, der sich bewährt hat"; add the number/name rules; state
  explicitly that roles, opening, length and humor are decided per episode by the brief.

### 4. Pacing (`src/podcast-synth.ts`)

`numberDensity(text)` counts German/English number words and digit tokens per word. A turn
above `config.podcastDenseTurnThreshold` (default 0.12) is synthesized at
`host.speed - config.podcastDenseTurnSlowdown` (default 0.06, clamped to 0.7). Applied in
`turnsForSynthesis`, pure, tested.

### 5. Memory (`src/podcasts.ts`)

`PodcastJobState` gains `episodeProfile` (persisted once the script locks) and the files
`brief.json` and `dossier.json` next to `script.json`:

```ts
interface EpisodeProfile {
  format: string;
  /** Computed from word share, not asked: "A" | "B" | "balanced" (within 10 points). */
  lead: "A" | "B" | "balanced";
  humor: EpisodeBrief["humor"];
  opening: string;          // the brief's opening, one line
  minutes: number;          // planned
  durationSeconds: number | null;  // measured, filled after mastering
  topics: string[];
  segmentCount: number;
  toolCalls: number;
  researchCalls: number;
}
```

`PodcastStore.recentEpisodes(series, limit)` returns `done` jobs newest-first with
`{ id, createdAt, title, description, profile }`. Public job JSON exposes `profile` and
`brief`.

### 6. Brain note (`src/brain-note.ts`, new)

After `done` (publish or not), when `BRAIN_DIR` is set and the request's `brainNote !== false`:
write `Areas/Podcasts/<yyyy-mm-dd> <title>.md` — light-layer frontmatter (`title`, `date`,
`tags: [podcast, <series-slug>]`, `format`, `lead`, `humor`, `minutes`, `topics`, `job`,
`abs` item id when published) followed by the description and the transcript
(`renderTranscriptMarkdown`). Regenerate the folder note `Areas/Podcasts/Podcasts.md` (a
dated list, newest first). Then `git add` the two files, `git commit -m "podcast: <title>"`,
`git push` — every step best-effort with a warning log; never touches other files, never
pulls, never resolves conflicts (that is `brain-sync`'s contract). Follow
`~/SourceRoot/brain/AGENTS.md` for the frontmatter and the MOC shape.

### 7. Request surface

`POST /v1/podcasts` gains:

| Field | Type | Default | Meaning |
|-|-|-|-|
| `sourcePaths` | `string[]` | `[]` | brain-relative note paths, read and appended to `source` (which becomes optional when paths are given) |
| `research` | `boolean` | `true` | run the research stage |
| `pinMinutes` | `boolean` | `false` | the editor may not deviate from `minutes` |
| `brainNote` | `boolean` | `true` | write the transcript note back into the brain |

`GET /v1/podcasts/:id` adds `profile`, `brief`, and links `dossier`/`brief`. Progress stages
inside `scripting`: `research → editorial → outline → segment → review → revise → metadata`.
The CLI (`scripts/podcast.ts`) gets `--path <brain path>` (repeatable), `--no-research`,
`--pin-minutes`, `--no-brain-note`; its default base URL becomes `http://localhost:7719`.

### 8. Config (`src/config.ts`)

| Var | Default | |
|-|-|-|
| `BRAIN_DIR` | `""` | vault checkout; empty disables brain tools and the note |
| `RESEARCH_GATEWAY_URL` | `https://research.jkrumm.com` | |
| `RESEARCH_API_KEY` | `""` | `op://vps/research-gateway/API_SECRET`; empty disables the `research` tool |
| `PODCAST_RESEARCH_MODEL` | `gpt-5.6-luna` | tool-calling researcher |
| `PODCAST_EDITORIAL_MODEL` | `claude-opus-5` | the editor |
| `PODCAST_RESEARCH_MAX_CALLS` | `2` | research-gateway calls per job |
| `PODCAST_TOOL_MAX_ROUNDS` | `12` | tool-loop rounds per job |
| `PODCAST_HISTORY_DEPTH` | `8` | episodes shown to the editor |
| `PODCAST_DENSE_TURN_THRESHOLD` | `0.12` | number-word density that triggers the slowdown |
| `PODCAST_DENSE_TURN_SLOWDOWN` | `0.06` | speed delta for dense turns |

`usage.ts` RATES must price every model above (Luna and Opus 5 already are).

### 9. Observability

`audio.podcast` root span gains children `audio.podcast.research` (with one
`audio.podcast.tool` child per tool call: `tool.name`, `tool.ok`, `tool.ms`) and
`audio.podcast.editorial`; the existing `audio.podcast.llm` covers every chat call including
the tool loop's rounds. Root span attributes add `podcast.format`, `podcast.lead`,
`podcast.humor`, `podcast.tool_calls`, `podcast.research_calls`.

### 10. Deployment on the mini

- `launchd/com.jkrumm.audio-gateway.plist.template` + `scripts/launch.sh` (wrapper, pattern
  from `hermes-serve-launch.sh`: PATH, `secrets-run` preflight, `exec secrets-run run
  --env-file=.env.tpl --env-file=.env.mini.tpl -- bun src/index.ts`). `KeepAlive`,
  `RunAtLoad`, logs in `~/Library/Logs/audio-gateway.{log,err}`.
- `.env.mini.tpl`: `PORT=7719`, `BRAIN_DIR=/Users/jkrumm/SourceRoot/brain`,
  `RESEARCH_API_KEY=op://vps/research-gateway/API_SECRET`, `PODCAST_DB`/`PODCAST_DATA_DIR`
  under `./data`, image-gen + Argo refs as on the VPS, `PODCAST_NOTIFY_CHANNEL=media`,
  `USAGE_SOURCE_LABEL=audio-gateway-mini`. The two Audiobookshelf refs sit in their own
  overlay `.env.mini.publish.tpl`, which the launcher adds only when it resolves — `secrets-run`
  fails closed on any unseeded ref, and those two are seeded separately (`make secrets-seed`
  on the MacBook), so an unseeded cache yields a running instance that skips publishing
  instead of no instance. OpenTelemetry uses the same trick: `.env.mini.otel.tpl` points the exporter at
  the VPS's public ingest (`otel.<domain>`, bearertokenauth via `OTEL_EXPORTER_OTLP_HEADERS`)
  and is layered only when the ingestion key resolves. A push to master does NOT redeploy the
  mini — `make deploy` pulls and restarts, and refuses while a job runs.
- `make launchd-install | launchd-status | launchd-logs | seed-ledger` (the last one scp's
  the VPS ledger and episode dirs so the mini starts with the five existing episodes as
  memory).
- `dotfiles/docs/architecture.md` gets the LaunchAgent row (`make architecture-check`
  fails otherwise). `dotfiles/config/Caddyfile` gets `podcasts.test → :7719` so the tailnet
  door `podcasts.mini.jkrumm.com` exists for the MacBook.
- Hermes `skills/podcast` and Claude Code `skills/podcast` point at the mini instance; the
  VPS keeps serving `/v1/podcasts` until the mini has produced one clean episode, then
  `PODCAST_ENABLED=false` in the vps compose turns it off there (a 410 with a hint).

## Acceptance

1. `bun test` green; new hermetic tests for: tool-loop message shaping (assistant message
   echoed verbatim, tool results attached by `tool_call_id`, round cap), `brain_search`
   scoring and path containment, dossier/brief/profile parsing incl. malformed input,
   `numberDensity` + speed application, `recentEpisodes`, brain-note rendering.
2. A technical episode about this redesign (source: this document + the analysis), produced
   on the mini instance with research + editorial on, published to Audiobookshelf. The brief
   must *not* produce the old shape: no number-then-"Warte" cold open unless the editor argues
   for it, roles set per the material, humor `none`/`sparse` for a technical topic.
3. The job JSON shows `profile`, the brain holds the note, HyperDX shows the new spans.
4. `bun run usage:tail` prices the research and editorial calls.

## Out of scope

Native ElevenLabs key features (Text-to-Dialogue, pronunciation dictionaries), resumable
jobs, a brain write API, moving STT/TTS off the VPS.
