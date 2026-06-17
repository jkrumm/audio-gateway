# audio-gateway — Project Guide

OpenAI-compatible audio service (STT + expressive Gemini TTS) fronting the IU unified audio
endpoint. The **single source of truth** for audio in the personal stack — deployed as a single
Docker container on the VPS (consumed by Argo in-cluster on the shared `proxy` network, Hermes
over the tailnet). Local development runs on the Mac via `bun run dev` (`:7714`). Replaced the
original `audio-proxy` and Argo's previously-duplicated native pipeline (both retired 2026-06-17).

## Stack
- Bun + TypeScript (strict). **No runtime npm dependencies** — Bun built-ins only
  (`Bun.serve`, `bun:sqlite`, `Bun.spawn`) plus the system `ffmpeg`/`ffprobe` binaries.
- Port **7714**. OpenAI-compatible `/v1/audio/*` surface (suffix-routed, so `/audio/...` works too).

## Layout
- `src/index.ts` — `Bun.serve` entry: routing, auth gate, `/health`, `/models`, top-level error wrap.
- `src/config.ts` — the ONLY place env is read; exports a frozen `config`. Required vars fail fast at boot.
- `src/iu.ts` — upstream URL builders + bearer-header helper.
- `src/usage.ts` — usage sink. SQLite adapter (default); HTTP adapter is the Phase-3 seam.
- `src/transcriptions.ts` — STT handler + verbose_json/srt/vtt envelope synthesis.
- `src/speech.ts` — TTS dispatcher (Gemini-expressive vs passthrough).
- `src/gemini-tts.ts` — Gemini pipeline (config/fetch/ffmpeg deps).
- `src/gemini-tts-core.ts` — pure, config-free transforms (unit-tested).

## Conventions
- Deep modules, **ports & adapters** (the usage sink is the canonical example), early returns, no `any`.
- All env parsing stays in `config.ts`.
- Follow the global rules in `~/.claude/rules` (code-style, typescript, security, dependency-hygiene).

## Run
- Dev: `bun run dev` (op run injects secrets from `.env.tpl`; listens on `:7714`).
- VPS prod: Docker (see `Dockerfile`); secrets injected as env at runtime.

## Reference
`docs/reference/audio-proxy-spec.md` is the behavioral contract, extracted from the original
`audio-proxy` service. That service is RETIRED (2026-06-17): its macOS LaunchAgent was removed and
its GitHub repo archived; the local checkout at `../audio-proxy` is kept read-only for reference.
`PRD.md` is the build spec and records the decisions that diverge from a straight port.

## Git
Direct-to-master (SourceRoot default; not on the PR-required list).
