# PRD — audio-gateway

## Purpose

A standalone, OpenAI-compatible audio service (STT + expressive Gemini TTS) that fronts the IU unified
audio endpoint, owns the native Gemini expressive-TTS pipeline, and logs usage. It is the **single
source of truth** for audio in the personal stack.

**Topology decision (changed from the original two-instance plan):** ONE deployment — a Docker
container on the **VPS**, exposed as the Tailscale-only domain `audio-gateway.jkrumm.com`. Every
consumer calls that one instance: Argo over localhost (same host), Hermes over the tailnet. There is
**no Mac LaunchAgent** and no Mac prod instance. Local development runs on the Mac via `bun run dev`
(`:7714`, `audio-gateway.test`).

## Background

`audio-proxy` (Mac, `:7716`) and Argo's `apps/api/src/lib/tts/audio.ts` are two copies of the same
audio pipeline (Argo's was ported from audio-proxy, commit `71557bd`). They have already drifted —
different concurrency behavior, a Gemini error-path usage-logging bug in audio-proxy, two `pricing.ts`
files kept in sync by hand. This service consolidates the pipeline into ONE codebase and ONE running
instance.

## Target architecture

- **Service:** Bun + TypeScript, no runtime npm deps (Bun built-ins + system `ffmpeg`/`ffprobe`).
- **Prod:** Docker container on the VPS, RollHook-deployed, fronted by Traefik, reachable only over the
  tailnet at `audio-gateway.jkrumm.com` (Cloudflare DNS-only A record → the VPS tailnet IP).
- **Consumers:** Argo (VPS) → `localhost`; Hermes (Mac) → `https://audio-gateway.jkrumm.com` over the
  tailnet. Repointing those consumers is **out of scope** for this effort (see Phase 2).
- **Auth:** `PROXY_API_KEY` stays empty/optional. Access is gated entirely at the tailnet layer
  (DNS-only A record to a CGNAT address is unreachable off-tailnet). No app-level bearer key.
- **Accepted tradeoff:** Hermes audio now traverses the tailnet to the VPS and back, and the VPS is a
  single point of failure for Hermes audio. Acceptable for personal use on a fast tailnet.

## Scope — this effort

Build the service greenfield by porting the proven logic from `../audio-proxy` (the reference
implementation) plus the Decisions below, **and** wire it for VPS deployment, then bake it on the
tailnet domain in parallel with the untouched old Mac proxy. Spans three repos:

**`audio-gateway` (this repo)**
- `src/` — full service: faithful port + the 3 bug fixes + Decisions 1–5.
- `Dockerfile` — Bun + ffmpeg (must provide `ffmpeg` AND `ffprobe`), `EXPOSE 7714`, `HEALTHCHECK /health`.
- `.github/workflows/` — build image → push to `rollhook.jkrumm.com/audio-gateway` → trigger RollHook
  webhook (via `rollhook-action`), on push to `master`.
- Tests — pure-transform unit tests + mocked-route tests + an opt-in live-IU e2e smoke.
- README (already scaffolded; keep current).
- **No `launchd/`** — the Mac LaunchAgent is not built (single-VPS topology).

**`vps` repo**
- `apps/audio-gateway/compose.yml` + `apps/audio-gateway/.env.tpl` — RollHook-managed service entry.
- `Makefile` targets `audio-gateway-{up,down,env,bootstrap-image}` (model after `apps/modelpick`); add
  `audio-gateway-up` to the `up:` prod sequence.

**`dotfiles` repo**
- `config/Caddyfile` — `audio-gateway.test { reverse_proxy localhost:7714 }` for local dev HTTPS, then
  `caddy-reload`.

**Ops (guided, human-in-the-loop — not autonomous):**
- Cloudflare **DNS-only (grey-cloud) A record** `audio-gateway.jkrumm.com → ${VPS_TAILSCALE_IP}` (use
  the `/cloudflare` skill). Do NOT add it to the cloudflared tunnel ingress.
- On the VPS: `make audio-gateway-env` (op inject), `make audio-gateway-bootstrap-image`, first deploy.
- Bake: verify `/health`, an STT round-trip, and a Gemini TTS round-trip over the domain.

## Out of scope — Phase 2 (follow-on, after bake)

Do NOT touch these here. Done deliberately once the VPS instance is verified and trusted:
- Repoint **Hermes** at `audio-gateway.jkrumm.com`.
- Gut **Argo**'s native audio pipeline; rewrite `/ai/v1/audio/*` as a thin proxy to the localhost
  audio-gateway; remove ffmpeg from Argo's Dockerfile; swap `AUDIO_*` env for one `AUDIO_GATEWAY_URL`.
- Retire the old Mac **audio-proxy**: unload its LaunchAgent, archive `../audio-proxy`, free `:7716`.

## Out of scope — Phase 3 (follow-on, optional)

- Usage unification: activate the HTTP-push sink (POST to Argo `/usage/records`); retire
  usage-tracker's audio-proxy SQLite collector. The sink seam is built in Phase 1 so this is a config
  flip (see Decision 3).

## Stack & conventions

- Bun + TypeScript, strict. **No runtime npm dependencies** — Bun built-ins (`Bun.serve`, `bun:sqlite`,
  `Bun.spawn`) + system `ffmpeg`/`ffprobe` only.
- Follow this repo's `CLAUDE.md` and the global rules (`~/.claude/rules`): deep modules, ports & adapters,
  early returns, no `any`, no committed secrets, Makefile-driven docker.
- The behavioral contract is `docs/reference/audio-proxy-spec.md`. Read it AND the actual source under
  `../audio-proxy/src/`. Port faithfully; diverge only where Decisions say so.

## Functional contract

Port exactly as documented in `docs/reference/audio-proxy-spec.md` §5–§7:

- `GET /health` (before auth) → `200` `{ ok: true, service: "audio-gateway" }`. During graceful
  shutdown → `503` (Decision 5).
- Bearer auth gate when `PROXY_API_KEY` is set (else accept any — the prod posture, since the tailnet
  gates access).
- `POST …/audio/transcriptions` — STT with verbose_json/srt/vtt envelope synthesis,
  `timestamp_granularities[]` stripping, DE/EN language steering (client values win), suffix routing.
- `POST …/audio/speech` — TTS dispatcher: Gemini-expressive pipeline when model matches `/gemini.*tts/i`,
  else passthrough; `X-Audio-Title` (URL-encoded) on the Gemini path.
- `GET …/models` — passthrough, not logged.
- Suffix routing so both `/v1/...` and `/...` resolve; `idleTimeout: 255`; JSON error envelopes;
  top-level thrown error → `500`.

## Decisions (these diverge from a straight port)

1. **Concurrency — INCLUDE.** audio-proxy synthesizes Gemini chunks sequentially; Argo's port ran them
   concurrently (default 4). Adopt **concurrent, order-preserving chunk synth** behind `TTS_CONCURRENCY`
   (default `4`, bounded 1–8; `1` = sequential). Reassemble by chunk index. Keep the per-chunk 503/429
   retry (`rawFetch`, 3 attempts). **Failure semantics:** when a chunk fails after its retries are
   exhausted, throw → `500` (preserve "no silent partial output"); record best-effort error usage rows
   for already-settled chunks; do NOT abort in-flight chunks (simplest correct behavior — the retry
   absorbs the transient case). Rationale: clear latency win, already proven in Argo.

2. **Fix the 3 known bugs** (spec §10) — do NOT port them as-is:
   - Gemini synth/prep failure must **record a usage row** (error status/latency) before throwing —
     mirror the STT error path so failures are visible in telemetry. (Best-effort; see Decision 3.)
   - Drop the dead `endpoint:"models"` enum value.
   - Non-JSON `/audio/speech` body → respond `400` JSON; do not write a blank-model usage row.

3. **Usage via a pluggable, fail-safe sink (ports & adapters).** Define a `UsageSink` interface
   (`record(row)`). Ship the **SQLite adapter** as default. **Clean break — no continuity guarantee:**
   the new instance writes a fresh DB; usage-tracker's existing audio-proxy collector is NOT kept
   working (the old proxy keeps its own DB until retired). Usage is **non-essential**: a sink write that
   fails MUST be swallowed and MUST NEVER break or delay an audio response. Define but **DEFER** the
   **HTTP adapter** (POST to Argo `/usage/records`) as the Phase-3 seam — write the interface + a clear
   `// TODO(phase-3)` stub, do not implement the HTTP call yet. Sink chosen by
   `USAGE_SINK=sqlite|http|both` (default `sqlite`); `USAGE_SOURCE_LABEL` default `audio-gateway`. On the
   VPS the SQLite DB lives on a host volume (`/var/lib/audio-gateway/`) and is currently unconsumed —
   harmless, and the door stays open for Phase 3.

4. **Rename** audio-proxy → audio-gateway: package name, `/health` service string, startup log line, the
   ffprobe temp-file prefix (`audio-gateway-<uuid>`), `.env.tpl` header. The LaunchAgent/Keychain rename
   items are **dropped** (no Mac prod instance, no `launchd/`). KEEP the shared `op://common/anthropic/*`
   references.

5. **Graceful shutdown — NEW (required by RollHook zero-downtime deploy).** On `SIGTERM`: flip `/health`
   to `503`, stop accepting new requests, drain in-flight requests up to a bounded timeout, then exit
   cleanly. The original LaunchAgent service never needed this; the container does.

6. **Port — `7714` (changed from `7716`).** The old Mac audio-proxy keeps `:7716` and keeps serving
   Hermes untouched during the bake. The gateway uses `7714` everywhere (config default, dev kill-port,
   `audio-gateway.test` Caddy entry, Dockerfile `EXPOSE`, compose Traefik `server.port`, healthcheck).
   The gateway stays on `7714` permanently — `7716` is freed when the old proxy retires (Phase 2), not
   reclaimed.

## Dockerfile (for the VPS)

- Base on an official Bun image with ffmpeg present (`oven/bun:1` Debian-slim + `apt-get install -y
  ffmpeg`, or `oven/bun:1-alpine` + `apk add --no-cache ffmpeg` — pick one, justify in a one-line
  comment; verify the chosen base ships `libmp3lame` + `libopus`). Must provide both `ffmpeg` AND
  `ffprobe`.
- Copy source; `bun install --frozen-lockfile` (commit `bun.lock`); `EXPOSE 7714`;
  `CMD ["bun","src/index.ts"]`; `HEALTHCHECK` hitting `/health`.
- **No baked secrets** — reads `IU_*` + other env at runtime; compose injects them.

## VPS wiring (vps repo — grounded in current conventions)

RollHook-managed app at `apps/audio-gateway/compose.yml` (NOT inside the networking/infra/monitoring
stacks). Hard constraints and conventions confirmed against `apps/modelpick` / `apps/argo`:

- **NO `ports:`, NO `container_name:`** (RollHook scales with `--scale`).
- `image: ${IMAGE_TAG:-rollhook.jkrumm.com/audio-gateway:latest}` (private Zot registry; RollHook passes
  `IMAGE_TAG` inline).
- `restart: unless-stopped`, `security_opt: [no-new-privileges:true]`, `mem_limit`, `logging: json-file`
  (`max-size: 10m`, `max-file: 3`).
- `healthcheck:` `curl -fsS http://localhost:7714/health`.
- `networks: [proxy]` (external).
- **Traefik labels** (identical to a public service — Tailscale-only is NOT a label difference):
  `traefik.enable=true`, `routers...rule=Host(\`audio-gateway.${DOMAIN}\`)`, `entrypoints=websecure`,
  `tls.certresolver=letsencrypt`, `services...loadbalancer.server.port=7714`,
  `loadbalancer.healthcheck.path=/health` + `.interval=10s`, `middlewares=rate-limit@file,security-headers@file`.
- **RollHook labels:** `com.centurylinklabs.watchtower.enable=false`,
  `rollhook.allowed_repos=jkrumm/audio-gateway`.
- **Volume** for the usage DB: host path `/var/lib/audio-gateway/` → container `USAGE_DB` (survives
  redeploys).
- `apps/audio-gateway/.env.tpl`: `IU_API_KEY=op://common/anthropic/API_KEY`,
  `IU_OPENAI_BASE_URL=op://common/anthropic/OPENAI_BASE_URL`,
  `IU_GEMINI_BASE_URL=op://common/anthropic/GEMINI_BASE_URL`, `DOMAIN=op://vps/config/DOMAIN`,
  `USAGE_DB=/data/usage.db`, plus the shipped `STT_PROMPT`. Materialized to `.env` on the VPS via
  `make audio-gateway-env` (op inject; `chmod 644`; gitignored; RollHook reads it).
- **Tailscale-only exposure:** a Cloudflare **DNS-only (grey) A record** `audio-gateway.jkrumm.com →
  ${VPS_TAILSCALE_IP}`. Traefik's `:443` is already bound to the tailnet interface. Do NOT add to the
  cloudflared tunnel ingress. (`argo.jkrumm.com` is the precedent.)
- **OTel deferred** — joining `monitoring-net` + OTLP export would need a dependency or hand-rolled OTLP,
  which conflicts with the no-runtime-deps rule. Rely on container logs (Dozzle/HyperDX ingest) for now.

## Config / env

All env read **only** in `config.ts`; required vars fail fast at boot. From spec §4 (`PORT`, `IU_API_KEY`,
`IU_OPENAI_BASE_URL`, `IU_GEMINI_BASE_URL`, `USAGE_DB`, `PROXY_API_KEY`, `STT_LANGUAGE`, `STT_PROMPT`,
`TTS_PREP_MODEL`, `TTS_MP3_BITRATE`, `TTS_CHUNK_THRESHOLD`, `TTS_CHUNK_TARGET_WORDS`, `TTS_CHUNK_MAX_WORDS`,
`TTS_CHUNK_MAX_BYTES`, `TTS_PREP`), with `PORT` default now **`7714`**, PLUS:

- `TTS_CONCURRENCY` — default `4`, range 1–8.
- `USAGE_SINK` — `sqlite|http|both`, default `sqlite`.
- `USAGE_HTTP_URL` — Phase-3 only; unused while sink is `sqlite`.
- `USAGE_SOURCE_LABEL` — default `audio-gateway`.
- `SHUTDOWN_DRAIN_MS` — graceful-shutdown drain budget (Decision 5); pick a sane default (e.g. `10000`).

## Tests

Layered; `bun test` stays hermetic and credential-free, live e2e is opt-in:

- **Pure-transform unit tests** (`bun test`) — port + extend the `gemini-tts-core` tests: prep-response
  parsing, chunk-limit enforcement, PCM→WAV, srt/vtt formatting.
- **Mocked-route tests** (`bun test`) — stub the upstream `fetch`; cover the route-level deltas the
  pure-transform tests can't: the 3 bug fixes (usage-row-on-error, 400-on-bad-JSON, dropped enum), suffix
  routing, the auth gate, and graceful-shutdown `/health` → 503. These error paths cannot be triggered
  deterministically against the live endpoint, so they MUST be covered here.
- **Live-IU e2e smoke** (`bun run test:e2e`, opt-in, needs `op run`) — happy-path STT + Gemini TTS
  round-trips against the real IU endpoint. NOT part of `bun test`.

## Acceptance criteria

- `bun run typecheck` clean; `bun test` green (pure-transform + mocked-route, no creds/network).
- `bun run test:e2e` green against live IU (STT + Gemini TTS round-trips).
- Every route behaves per spec §5; suffix routing works for `/v1/...` and `/...`.
- Gemini TTS end to end: prep → chunk-limit enforcement → **concurrent, order-preserving** synth → concat
  (400 ms silence) → ffmpeg (MP3 default, Opus on `response_format=opus`), with `X-Audio-Title` set and
  503/429 retries.
- Every failure path records a best-effort usage row with the error status; a sink failure never breaks
  the audio response.
- `SIGTERM` triggers graceful drain: `/health` → 503, in-flight requests complete (within
  `SHUTDOWN_DRAIN_MS`), clean exit.
- `docker build` succeeds; `docker run` serves `/health`; `ffmpeg` + `ffprobe` present in the image.
- VPS: `make audio-gateway-up` brings it up; Traefik routes `audio-gateway.jkrumm.com`; the domain
  resolves and responds **only** over the tailnet; RollHook deploy-on-push works.
- No `any` without a justifying comment; no real secrets committed; `bun.lock` committed.

## Implementer instructions

1. Read `docs/reference/audio-proxy-spec.md` (the contract) AND the source under `../audio-proxy/src/`:
   `index.ts`, `config.ts`, `iu.ts`, `usage.ts`, `transcriptions.ts`, `speech.ts`, `gemini-tts.ts`,
   `gemini-tts-core.ts`, `gemini-tts.test.ts`.
2. Recreate the module structure (keep `gemini-tts-core.ts` pure/testable). Apply Decisions 1–6 and the
   3 bug fixes. Do NOT create `launchd/`.
3. Write the `Dockerfile`, the `.github/workflows` deploy (rollhook-action), and the layered tests.
4. VPS repo: add `apps/audio-gateway/{compose.yml,.env.tpl}` + Makefile targets (model after
   `apps/modelpick`). dotfiles: add the Caddyfile dev entry + `caddy-reload`.
5. Run `bun run typecheck` and `bun test`; fix until green. Return a concise per-file change summary.
6. Ops (guided, after the code lands): Cloudflare DNS record, `make audio-gateway-env`,
   `make audio-gateway-bootstrap-image`, first deploy, bake.
