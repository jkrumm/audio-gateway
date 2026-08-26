# audio-gateway — Project Guide

OpenAI-compatible audio service (STT + expressive Gemini TTS + Replicate/ElevenLabs TTS) fronting
the IU unified audio endpoint. The **single source of truth** for audio in the personal stack —
deployed as a single Docker container on the VPS (consumed by Argo in-cluster on the shared
`proxy` network, Hermes over the tailnet). Local development runs on the Mac via `bun run dev`
(`:7714`). Replaced the original `audio-proxy` and Argo's previously-duplicated native pipeline
(both retired 2026-06-17).

## Stack
- Bun + TypeScript (strict). **No runtime npm dependencies** — Bun built-ins only
  (`Bun.serve`, `bun:sqlite`, `Bun.spawn`) plus the system `ffmpeg`/`ffprobe` binaries.
- Port **7714**. OpenAI-compatible `/v1/audio/*` surface (suffix-routed, so `/audio/...` works too).

## Layout
- `src/index.ts` — `Bun.serve` entry: routing, auth gate, `/health`, `/models`, top-level error wrap.
- `src/config.ts` — the ONLY place env is read; exports a frozen `config`. Required vars fail fast at boot.
- `src/iu.ts` — upstream URL builders + bearer-header helper (OpenAI, Gemini, Replicate bases).
- `src/usage.ts` — usage sink. SQLite adapter (default); HTTP adapter is the Phase-3 seam. Also
  owns request correlation (`runWithRequestContext`/`setRequestMeta`, AsyncLocalStorage): every
  `recordUsage` call made while handling one HTTP request is stamped with the same
  `request_id`/`caller`, and the dispatcher records one `speech-request`/`transcription-request`
  summary row per request (mode/lane/chunks/text) once it resolves — see `src/usage-report.ts`.
- `src/usage-report.ts` — pure parsing/rollup for `usage:tail`: joins a `*-request` row with its
  chunk/prep/stt siblings by `request_id` into one reviewable `RequestLine`, plus a per-lane/mode
  rollup. No SQLite, no network — hermetically tested.
- `src/transcriptions.ts` — STT handler + verbose_json/srt/vtt envelope synthesis.
- `src/speech.ts` — TTS dispatcher: `resolveTtsRoute` (model-resolution.ts) picks the lane —
  gemini / replicate / passthrough — then rejects an unrecognized `response_format` (mp3/opus/
  wav/pcm) before handing off.
- `src/gemini-tts.ts` — Gemini expressive pipeline (config/fetch/ffmpeg deps). Also exports
  `rawFetch` (503/429-retrying fetch), shared by the Replicate lane.
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

## Conventions
- Deep modules, **ports & adapters** (the usage sink is the canonical example), early returns, no `any`.
- All env parsing stays in `config.ts`.
- Follow the global rules in `~/.claude/rules` (code-style, typescript, security, dependency-hygiene).

## Run
- Dev: `bun run dev` (`secrets-run` injects secrets from `.env.tpl` — drop-in op shim: live `op` on the MacBook, encrypted cache on the mini; listens on `:7714`).
- VPS prod: Docker (see `Dockerfile`); secrets injected as env at runtime.
- `bun run usage:tail [--db <path>] [--prod] [--since 30m|2h|1d|<ISO>] [--limit N] [--json]` — a
  readable per-request usage timeline (mode, stage timings, text snippets) for reviewing TTS/STT
  quality; `--prod` scp's the VPS SQLite file (+ WAL/SHM) to a temp dir first.

## Reference
`docs/reference/audio-proxy-spec.md` is the behavioral contract, extracted from the original
`audio-proxy` service. That service is RETIRED (2026-06-17): its macOS LaunchAgent was removed and
its GitHub repo archived; the local checkout at `../audio-proxy` is kept read-only for reference.
`PRD.md` is the build spec and records the decisions that diverge from a straight port.

## Git
Direct-to-master (SourceRoot default; not on the PR-required list).
