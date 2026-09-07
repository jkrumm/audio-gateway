# Decisions

The build-time decisions of the original 2026-06 port, moved here from the retired `PRD.md`
(deleted 2026-09-07 together with `docs/reference/audio-proxy-spec.md`, the behavioral contract of
the retired `audio-proxy` service — both were era documents for a port that is long finished; the
`audio-proxy` GitHub repo is archived). Code comments still cite these by number ("Decision 5").

The v2 podcast pipeline's decisions (no framework, the two-instance split, the free-form editorial
brief, model choices, memory, pacing, best-effort stages) live in
`docs/podcast-editorial-room.md` § Decisions and are not repeated here.

## Port decisions (2026-06, diverging from a straight `audio-proxy` port)

Numbering is the original's — 7 was appended after 5 and sits before 6 in the source.

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

7. **`summarize` — ported from Argo (deliberate divergence).** A `summarize: true` field on `/audio/speech` requests condenses the input into ONE short spoken confirmation (~30 words) via a dedicated `SUMMARY_SYSTEM_PROMPT`, bypassing the `config.ttsPrep` gating (always calls the LLM). Designed for hands-free voice-mode replies where only the gist should be spoken aloud. Usage recorded under `"speech-summary"` to keep it separable from normal `"speech-prep"` rows. This is an intentional divergence from the straight `audio-proxy` port — added here because the gateway is now the single source of truth for audio.

6. **Port — `7714` (changed from `7716`).** The old Mac audio-proxy keeps `:7716` and keeps serving
   Hermes untouched during the bake. The gateway uses `7714` everywhere (config default, dev kill-port,
   `audio-gateway.test` Caddy entry, Dockerfile `EXPOSE`, compose Traefik `server.port`, healthcheck).
   The gateway stays on `7714` permanently — `7716` is freed when the old proxy retires (Phase 2), not
   reclaimed.
