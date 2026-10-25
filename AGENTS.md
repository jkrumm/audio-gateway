# audio-gateway — Project Guide

OpenAI-compatible audio service (STT + expressive Gemini TTS + Replicate/ElevenLabs TTS) fronting
the IU unified audio endpoint. The **single source of truth** for audio in the personal stack.
Same image and code run on **two instances**: the VPS (Docker container, consumed by Argo in-cluster
on the shared `proxy` network, Hermes over the tailnet) serves STT/TTS; the **Mac mini** runs a
LaunchAgent instance (`:7719`) dedicated to the long-form **podcast** pipeline, because the second
brain and the research gateway are only reachable from there. Local development runs on the Mac via
`bun run dev` (`:7714`). Replaced the original `audio-proxy` and Argo's previously-duplicated native
pipeline (both retired 2026-06-17).

## Stack
- Bun + TypeScript (strict). **No runtime npm dependencies** — Bun built-ins only
  (`Bun.serve`, `bun:sqlite`, `Bun.spawn`) plus the system `ffmpeg`/`ffprobe` binaries.
- Port **7714**. OpenAI-compatible `/v1/audio/*` surface (suffix-routed, so `/audio/...` works too).

## Layout
- `src/index.ts` — `Bun.serve` entry: routing, auth gate, `/health` (with `degraded: [...]` — the
  launcher overlays that did not resolve), `/models`, top-level error wrap.
- `src/config.ts` — the ONLY place env is read; exports a frozen `config`. Required vars fail fast at boot.
- `src/iu.ts` — upstream URL builders + bearer-header helper (OpenAI, Gemini, Replicate, Anthropic bases).
- `src/usage.ts` — usage sink. SQLite adapter (default); HTTP adapter is the Phase-3 seam. Also
  owns request correlation (`runWithRequestContext`/`setRequestMeta`, AsyncLocalStorage): every
  `recordUsage` call made while handling one HTTP request is stamped with the same
  `request_id`/`caller`, and the dispatcher records one `speech-request`/`transcription-request`
  summary row per request (mode/lane/chunks/text) once it resolves — see `src/usage-report.ts`.
- `src/usage-report.ts` — pure parsing/rollup for `usage:tail`: joins a `*-request` row with its
  chunk/prep/stt siblings by `request_id` into one reviewable `RequestLine`, plus a per-lane/mode
  rollup. No SQLite, no network — hermetically tested.
- `src/transcriptions.ts` — STT handler + verbose_json/srt/vtt envelope synthesis. Oversize/overlong
  uploads are routed through `stt-input.ts` before the first upstream attempt; a multi-part
  (compressed and chunked) upload is transcribed up to `config.sttChunkConcurrency` parts at once
  (via `gemini-tts-core.ts`'s `synthConcurrent`) and joined into one response, forcing envelope
  synthesis for verbose_json/srt/vtt regardless of model. An empty-bodied upstream 5xx (the IU
  25 MiB-oversize 500) gets a real JSON error message instead of an opaque empty proxy response.
- `src/stt-input.ts` — makes an uploaded STT file fit the IU upstream's four measured limits (25 MiB
  body, 1400s duration on `gpt-4o-transcribe`, whisper's ~230s processing timeout, and silent
  truncation on `gpt-4o-transcribe` past ~20 min): a file under both the byte and
  `config.sttMaxChunkSeconds` duration limit passes through untouched after one ffprobe call; an
  oversize/overlong one is compressed to 16 kHz mono mp3 (lossless for STT) and, if still too big or
  too long, time-sliced into `config.sttMaxSttChunks`-bounded chunks whose cut points are snapped to
  nearby silence (`detectSilence`/`snapBoundaries`) so boundaries fall between words.
  `config.sttMaxChunkSeconds` (240s) is set by measured MODEL OUTPUT QUALITY collapse on real audio
  (past 240s, `gpt-4o-transcribe` degrades into repeated-sentence loops), not by any of the four
  upstream limits above — those are independent and still enforced regardless of this setting.
  `gpt-transcribe` (default since 2026-10-15) showed no collapse up to 1500 s; the 240s ceiling is
  kept for concurrency within the socket budget and the `whisper` fallback's ~230s timeout.
- `src/speech.ts` — TTS dispatcher: `resolveTtsRoute` (model-resolution.ts) picks the lane —
  gemini / replicate / passthrough — then rejects an unrecognized `response_format` (mp3/opus/
  wav/pcm) before handing off.
- `src/gemini-tts.ts` — Gemini 3.8 expressive pipeline (config/fetch/ffmpeg deps); request shapes,
  tag vocabulary and traps follow modelpick `docs/gemini-tts.md` (IU-proven; do not re-probe).
  Style rides in `parts[].speechMetadata.style` (a `"Style: text"` prefix is read aloud;
  `systemInstruction`/`speechConfig.speechMetadata` 400). Prep runs only for models in
  `TTS_GEMINI_PREP_MODELS` (briefing `gemini-3.8-flash-tts`); the chat default
  `gemini-3.8-flash-lite-tts` is one raw call. `response_format: pcm` streams via
  `streamGenerateContent?alt=sse` (sample-aligned passthrough, 400 ms zero join between chunks,
  billed from duration × 25 tokens/s because streamed `usageMetadata` is wrong; the
  `speech-request` row is recorded when the body ends — see `streamSettled`). mp3/opus/wav stay
  whole-file (Slack needs a complete body + `X-Audio-Title`). pcm contract: a failure before the
  first audio byte is a normal HTTP error; one after it ABORTS the chunked body (clients see a
  transfer error, never a clean EOF) and the usage row carries the real status. Also exports `rawFetch`
  (503/429-retrying fetch), shared by the Replicate lane.
- `src/replicate-tts.ts` — ElevenLabs models (flash-v2.5, turbo-v2.5, v3) via the IU gateway's
  Replicate route: create prediction → poll if not immediately `succeeded` → fetch the delivery
  MP3. Prep-LLM gating is per-model (`config.ttsReplicatePrepModels`, default `elevenlabs/v3`) —
  models not listed skip prep entirely (single call, no title) for the Hermes chat fast path.
- `src/gemini-tts-core.ts` — pure, config-free transforms shared by both TTS lanes: prep-response
  parsing, chunk-size enforcement, `looksGerman`, and the bounded-concurrency `synthConcurrent`
  runner (order-preserving, fail-fast — Decision 1).
- `src/audio.ts` — the ffmpeg/ffprobe process boundary: PCM/WAV framing, chunk concatenation,
  `transcode` (between raw PCM / auto-detected containers and mp3/opus/wav/pcm output), and
  `audioDuration`. Shared by both TTS lanes and STT duration probing.
- `src/podcast-types.ts` — pure shared shapes of the v2 podcast pipeline (`Dossier`, `EpisodeBrief`,
  `EpisodeProfile`, `EpisodeSummary`, `EpisodeHistory`) — no imports, so research/editorial/script/
  ledger modules depend on this file, not on each other.
- `src/llm-tools.ts` — a generic OpenAI-dialect tool-calling loop (`runToolLoop`) over `fetch`,
  shared by every stage that needs the model to call tools (currently the researcher). Echoes the
  assistant message back into `messages` UNCHANGED (not rebuilt from parsed fields) so a provider
  that smuggles state through opaque extra fields (e.g. Gemini's `thought_signature`) round-trips.
- `src/podcast-research.ts` — the research stage: a tool-calling loop (`runPodcastResearch`) giving
  the writers' room eyes on the listener's second brain (`brain_search`/`brain_read`, path-contained
  under `BRAIN_DIR`), past episodes (`past_episodes`/`past_transcript`, backed by an `EpisodeHistory`
  the caller injects), and a budgeted research-gateway tool. Also exports `readBrainNotes` (reads
  `sourcePaths` up front). Produces a `Dossier`; best-effort — the caller decides what to do on throw.
- `src/podcast-editorial.ts` — the editorial room: one call (`decideEpisodeBrief`, no tools) that
  reads the dossier, the listener brief and the recent episode profiles, and decides THIS episode's
  format, roles, tone, humor, opening/closing, rhythm and length as a free-form `EpisodeBrief`,
  bounded only by hard limits (segments 1–9, minutes clamped to the request bounds). A parse/LLM
  failure falls back to `defaultEpisodeBrief` — a neutral conversation, never the old fixed formula.
- `src/podcasts.ts` — long-form podcast orchestrator: job ledger (`bun:sqlite`, incl.
  `PodcastStore.recentEpisodes`), the one-job-at-a-time queue, the `runPodcastJob` pipeline
  (research → editorial → script → synth → mux/master → cover → publish → brain note), and the
  `/v1/podcasts*` HTTP handlers (`handlePodcasts`/`isPodcastPath`, mounted from `index.ts`; 410s
  every route when `config.podcastEnabled` is off). A failed Audiobookshelf upload never fails the
  job: it finishes `done` with `publish: { ok: false, error }` and `abs: null`, the brain note is
  still written, and `POST /:id/publish` repeats only the upload (then files the note with the
  link); `/retry` is for generation failures only.
- `src/anthropic-messages.ts` — the native Anthropic Messages wire on the IU Anthropic route
  (`iuAnthropicUrl`: `IU_ANTHROPIC_BASE_URL`, else `IU_OPENAI_BASE_URL` with `/openai/v1`
  swapped for `/anthropic`; derived lazily, so a base that cannot be derived fails only the first `claude-*` call, not boot) for a `claude-*` podcast model: streamed, adaptive thinking +
  `output_config: {effort: "high"}` (claude-opus-5-5 rejects `thinking.type.enabled` with a 400),
  `max_tokens` floor 32000, `text` blocks only, 500/502/504 + retryable stream errors + empty/unparseable
  2xx bodies (incl. an SSE body with no valid event) + a 15-min per-attempt timeout retried (429/503 by `rawFetch`). `callPodcastLlm` dispatches on the `claude-` prefix; every other model
  stays on chat/completions.
- `src/podcast-script.ts` — the writers' room: a role split with one voice owner. There is no fixed
  dramaturgy left in these prompts — the `EpisodeBrief` (from `podcast-editorial.ts`) decides shape,
  roles, tone, humor, opening, closing and rhythm; devices (hook/motif/reveals/digressions) are
  filled only when the brief's `devices` list asks for one. The outline model plans the story inside
  what the brief already decided; the write model owns every segment AND every revision; every
  reviewer role (dramaturge, conversation coach, fact & speech editor) runs on every listed review
  model in parallel (advisory only, judged against the brief, not a fixed curve); a final metadata
  model writes the locked script's title/description/cover prompt/genres/chapter titles/topics; a
  show bible is injected verbatim into the writer/reviewer prompts, and the owner's general voice
  guide (`brain/voice.md`, `PODCAST_VOICE_PATH`, optional) precedes it in the outline/segment/revision
  prompts only — the show bible overrides it for spoken audio. The write model defaults to
  `claude-opus-5-5` (`PODCAST_WRITE_MODEL`; `claude-opus-4-6` is the one-line rollback). Only tag vocabulary, turn
  ceilings and segment bounds are enforced in code (`sanitizeTurns`).
- `src/podcast-synth.ts` — flattens a script into per-host-voiced turns and synthesizes them. Default
  lane (`PODCAST_TTS_MODEL=gemini-3.8-flash-tts`, voices Charon + Erinome): `unitsForMultiSpeaker` packs
  consecutive turns (≤ `PODCAST_MULTISPEAKER_MAX_CHARS`, never across a segment) into runs, each one
  two-speaker request (`gemini-tts.ts` `synthMultiSpeaker`, per-part `speechMetadata.speaker`/`style`,
  `AUDIO_L16`); audio comes back per run, so chapters key on runs and host loudness levels per run.
  Pacing = constant per-host style (`PODCAST_HOST_STYLE_A/B`), number-dense turns get `DENSE_TURN_STYLE`.
  Fallback lane: an `owner/name` model id runs ElevenLabs per turn via `replicate-tts.ts` (set
  `PODCAST_VOICES`, `speed` is the only pace lever). Reference: modelpick `docs/gemini-tts.md`.
  `stripWavHeader` parses RIFF chunks — 3.8 WAVs carry a trailing C2PA chunk that is noise if kept.
- `src/podcast-mux.ts` — the podcast ffmpeg boundary: gapped PCM concat + chapter offsets
  (`concatWithGaps`) and loudness-normalised, chaptered, cover-embedding MP3 mastering (`masterPodcastMp3`).
- `src/cover.ts` — episode cover art via the image-gateway; best-effort, never fails a job.
- `src/audiobookshelf.ts` — Audiobookshelf publish client: upload → scan → poll → patch metadata/cover/episode.
- `src/brain-note.ts` — writes a finished episode's transcript back into the second brain
  (`Areas/Podcasts/<date> <title>.md`, plus a regenerated `Areas/Podcasts/Podcasts.md` folder note),
  then best-effort `git add`/`commit`/`push` in the vault checkout. Every step logs and stops the
  chain on failure rather than throwing — a filed note is polish, not the episode.
- `src/otel.ts` — hand-rolled OpenTelemetry exporter (no SDK, `fetch` only) to an OTLP/HTTP JSON
  collector. One root span per request (`audio.speech`/`audio.transcription`, kind SERVER) with
  child spans per pipeline stage (`audio.prep`, `audio.synth.chunk`, `audio.decode`,
  `audio.transcode`, `audio.stt.upstream`, …); the trace id is DERIVED from the request id
  (`usage.ts`'s `requestId`, dashes stripped), so a trace and its `usage_record`/Argo rows join on
  the same value with no extra correlation column. `src/log.ts` mirrors every `log.*` call into an
  OTLP log record via `emitLog`, stamped with the active span's ids. Disabled (a true no-op on the
  network path) unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; `OTEL_EXPORTER_OTLP_HEADERS`
  (`key=value,…`) rides on every POST; `OTEL_EXPORTER_OTLP_AUTHORIZATION` (+ optional
  `_AUTH_SCHEME`) sets the `authorization` header from a whole-value secret ref — the mini
  instance uses it for the public ingest's ingestion key. Resource attributes: `deployment.environment`
  follows `NODE_ENV` (`production` → `production`, else `development`) to match every other VPS
  service — the machine (`MACHINE`/hostname) is its own `host.name` attribute instead. The standard
  `OTEL_RESOURCE_ATTRIBUTES` env var (`key=value,key=value`) merges on top of both.
  Root spans are self-sufficient for dashboards without joining the usage sink: `audio.cost_usd`/
  `audio.cost_source` (summed across every billed `recordUsage` call in the request, via `usage.ts`'s
  `computeCost`), `audio.chars_billed` (ElevenLabs lane only), `audio.requested_model`/`audio.fallback`,
  `audio.retries` (rawFetch 503/429 backoff attempts), and `audio.inflight` (concurrent-request gauge,
  also on the `tts.done`/`stt.done` logs). The podcast pipeline gets its own root span
  (`audio.podcast`, kind SERVER, trace id derived from the job id) wrapping the whole
  `runPodcastJob` run, with child spans `audio.podcast.llm` (outline/segment writer calls),
  `audio.cover` (cover generation), and `audio.publish.abs` (Audiobookshelf upload/scan/poll) —
  same join-on-id story as a regular request.

## Validate
- `make check` — `bun run typecheck` + `bun test`; non-zero on failure, no side effects.
- The hermetic route/unit tests are what `bun test` runs. The **live** checks are excluded
  from `check` on purpose because they need IU credentials and network: `bun run test:e2e`
  (`RUN_E2E=1`, hits the real upstream) and `bun run test:roundtrip:prod`
  (`RT_BASE_URL=https://audio-gateway.jkrumm.com`).
- `make verify` (below) is the production probe, not part of `check`.

## Deploy
Two instances, two channels — the **VPS container** (production STT/TTS) and the **Mac mini
LaunchAgent** (podcast pipeline, `:7719`).
- **VPS.** Push to `master` → GitHub Actions (`.github/workflows/deploy.yml`) → RollHook
  builds the image and does a zero-downtime rolling replace (the 60 s `SHUTDOWN_DRAIN_MS`
  finishes in-flight requests; `stop_grace_period` is 90 s). There is no `make deploy` for the
  VPS: it is a `deployed by CI on push` repo. **Rollback:** RollHook keeps the previous
  image; re-run the workflow against the prior commit (nothing here rolls back automatically).
- **Mac mini.** `make deploy` pulls `master` (`--ff-only`), runs
  `bun install --frozen-lockfile`, then restarts the LaunchAgent (`launchd-restart`). It
  **refuses while a podcast job is running** (a restart kills it, and a killed job does not
  resume) and on a dirty working tree (the LaunchAgent runs *this* checkout). A push to
  `master` does **not** redeploy the mini — `make deploy` is manual.

## Verify & Monitor
- `make verify` — `curl -fsS https://audio-gateway.jkrumm.com/health` (VPS production),
  non-zero unless the body carries `"ok":true`. Exit 0 = live and healthy.
- Health URL: `https://audio-gateway.jkrumm.com/health` (VPS, tailnet-only via Traefik;
  grey-cloud DNS → the VPS). The mini answers `http://localhost:7719/health` (tailnet door
  `podcasts.mini.jkrumm.com` for the MacBook); its `degraded: [...]` names any launcher overlay
  that did not resolve (`publish`, `otel`).
- Kuma monitor: `Audio Gateway - HTTP` (keyword `"ok":true`, every 150 s). The mini has no
  Kuma HTTP monitor — Kuma cannot reach the tailnet mini; the `MacMini Dev Host - Push`
  heartbeat covers the host.
- OTel `service.name`: `audio-gateway` (the default; `OTEL_SERVICE_NAME` is unset). Both
  instances share it and are told apart by the `host.name` attribute (`MACHINE=vps`/`mini`).
- `make logs` — bounded tail (last 100 lines) of the local podcast-instance logs
  (`~/Library/Logs/audio-gateway.{log,err}`), then exits; unlike `make launchd-logs` it does
  not follow. VPS logs are the container's (`docker logs audio-gateway` on the VPS).

## Gotchas
- **`make deploy` refuses while a job runs and on a dirty tree** — a restart kills the
  running podcast (no resume), and the LaunchAgent runs this checkout, so a pull would ship
  uncommitted edits.
- **Never point the LaunchAgent at a Homebrew `bun` binary** — macOS BTM silently refuses it;
  the `scripts/launch.sh` wrapper is required (it also resolves the env overlays).
- **An unresolved launcher overlay is a degraded instance, not a boot failure** —
  `GET /health` returns `degraded: ["publish"|"otel"]`; seed the missing refs, then
  `make launchd-restart`.
- **`make launchd-logs` follows (`-f`); `make logs` is the bounded one** — use `make logs` in
  scripts.
- **`make verify` probes the VPS, not the local mini** — the mini is tailnet-only, so a green
  `make verify` does not prove the podcast instance is up (use `make launchd-status`).
- **The VPS answers `/v1/podcasts*` with a 410** (`PODCAST_ENABLED=false`); podcasts only run
  on the mini.

## Conventions
- Deep modules, **ports & adapters** (the usage sink is the canonical example), early returns, no `any`.
- All env parsing stays in `config.ts`.
- Follow the global rules in `~/.claude/rules` (code-style, typescript, security, dependency-hygiene).

## Run
- Dev: `bun run dev` (`secrets-run` injects secrets from `.env.tpl` — drop-in op shim: live `op` on the MacBook, encrypted cache on the mini; listens on `:7714`).
- VPS prod: Docker (see `Dockerfile`); secrets injected as env at runtime. Serves STT/TTS;
  `PODCAST_ENABLED=false` (podcasts are the mini's job). Ships via CI — see `## Deploy`.
- Mac mini prod: a LaunchAgent instance dedicated to podcasts (`launchd/`, `.env.mini.tpl`, port
  `7719`), shipped by `make deploy` (see `## Deploy`); `make launchd-install | launchd-status |
  launchd-restart | launchd-logs | launchd-uninstall` manage it, and `make seed-ledger` copies
  the VPS podcast job ledger + episode artifacts onto the mini so it starts with existing
  episodes as editorial memory.
- `bun run podcast -- --source <file.md|-> [--path <brain path>]... [--minutes N] [--publish]
  [--no-research] [--pin-minutes] [--no-brain-note] [...]` — CLI for the long-form podcast pipeline
  (submit, poll progress, download the finished episode), talks to the mini instance by default; see
  `docs/podcast.md`.
- `bun run usage:tail [--db <path>] [--prod] [--since 30m|2h|1d|<ISO>] [--limit N] [--json]` — a
  readable per-request usage timeline (mode, stage timings, text snippets) for reviewing TTS/STT
  quality; `--prod` scp's the VPS SQLite file (+ WAL/SHM) to a temp dir first.

## Reference
`docs/podcast-editorial-room.md` — the v2 podcast pipeline design (research, editorial brief, memory,
the two-instance split); `docs/podcast.md` is the fuller design doc + knobs, marking the pre-v2
fixed-dramaturgy sections as history.

`docs/hyperdx-dashboard.md` — the ClickStack span model and the tile definitions (search + SQL) for the
HyperDX "Audio" dashboard; `bun run usage:tail --prod` is the terminal view of the same requests.

`docs/decisions.md` — the numbered port-era decisions code comments cite ("Decision 5"); the
`PRD.md` and `audio-proxy` spec they came from are deleted (the original `audio-proxy` service is
retired since 2026-06-17, its repo archived).

## Git
Direct-to-master (SourceRoot default; not on the PR-required list).
