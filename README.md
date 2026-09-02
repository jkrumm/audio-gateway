# audio-gateway

OpenAI-compatible audio service on `:7714` that fronts the IU unified audio endpoint and adds two
native TTS pipelines: **Gemini expressive TTS** and **Replicate/ElevenLabs TTS**.

- **STT** (`POST /v1/audio/transcriptions`) — downgrades `gpt-4o-transcribe` to `json` and
  synthesizes the rich envelope (`verbose_json`/`srt`/`vtt`) clients expect, with DE/EN language
  steering. Whisper-style models pass through untouched.
- **TTS** (`POST /v1/audio/speech`) — model-routed to one of three lanes:
  - a Gemini TTS model (`gemini*tts*`) → the native `generateContent` pipeline (prep-LLM chunking
    → per-chunk synth → ffmpeg transcode, default voice Charon);
  - an `owner/name` Replicate id (e.g. `elevenlabs/flash-v2.5`, `elevenlabs/v3`) → the IU
    gateway's Replicate route (create prediction → poll → fetch delivery MP3). Prep-LLM chunking
    only runs for models listed in `TTS_REPLICATE_PREP_MODELS` (default `elevenlabs/v3`) — other
    models (flash/turbo) skip it entirely for a single fast call, matching Hermes' chat-reply path;
  - anything else → a straight passthrough of IU's own `/audio/speech`.

  All three honour `response_format` (`mp3`/`opus`/`wav`/`pcm` — `pcm`/`wav` are raw/wrapped s16le
  mono 24 kHz, the shape Hermes' `OpenAIStreamer` expects). `speed` is forwarded on the Replicate
  (clamped to 0.7–1.2) and passthrough lanes; Gemini has no speed parameter and ignores it. The
  Gemini and Replicate lanes both return an `X-Audio-Title` header when their prep LLM ran.
  Language per request: `language`/`lang_code` if sent, else detected from the text (umlauts,
  DE/EN function words), else `TTS_DEFAULT_LANGUAGE` (`de`) — never English by accident, because
  ElevenLabs' `language_code` steers pronunciation and Hermes streams one hint-less sentence per
  request. Each Replicate usage row records the `language_code` actually sent.

The single source of truth for audio across the stack. Deployed as a single Docker container on the
VPS at `audio-gateway.jkrumm.com`, reachable only over the tailnet; consumed by Argo over localhost
(same host) and by Hermes over the tailnet. Local development runs on the Mac via `bun run dev`
(`:7714`). There is no Mac LaunchAgent. Logs usage to a pluggable sink (SQLite today).

Every TTS/STT request is correlated end to end: all rows written while handling one HTTP request
(prep, per-chunk synth, the final response) share a `request_id`, plus one `speech-request`/
`transcription-request` summary row per request carrying the mode/lane, stage timings, and —
unless `USAGE_KEEP_TEXT=false` — the input/output text (truncated to 600 chars; this is personal
data, persisted to the VPS SQLite file and pushed to Argo's `raw` column). Review it with
`bun run usage:tail [--prod] [--since 2h] [--limit 30]`, which prints one line per request plus a
per-lane/mode rollup.

### Auth

Optional bearer-token gate: when `PROXY_API_KEY` is set, callers must send
`Authorization: Bearer <PROXY_API_KEY>`; unset (the tailnet-only prod posture) accepts any request.
`AUDIO_CALLER_TOKENS` (`name=token,name=token`, e.g. `hermes=...,macwhisper=...`) adds per-caller
tokens on top, accepted exactly like `PROXY_API_KEY`, for clients that cannot set the
`x-audio-source` header used to attribute usage rows/spans (Hermes' stock OpenAI client has no
header knob; MacWhisper only takes a base URL + key). When a request authenticates with a mapped
token and sends no `x-audio-source`, `audio.caller` becomes that name — an explicit header still
wins. Optional; empty/unset disables it entirely.

### Telemetry

The SQLite/Argo usage rows above are the cost-accounting layer; ClickStack traces + logs are the
observability layer beside them, not a replacement. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable a
hand-rolled OTLP/HTTP JSON exporter (no SDK) that emits one trace per request (root span
`audio.speech`/`audio.transcription`, child spans per pipeline stage) plus every `log.*` call as an
OTLP log record. The join key is `request_id` = trace id (dashes stripped from the UUID), so a
trace and its usage rows correlate with no extra column. Unset (default), the exporter is a
complete no-op. Request/response texts on spans are gated by `USAGE_KEEP_TEXT` exactly like the
usage sink.

## Podcasts

Long-form pipeline: notes in, a two-host episode out. `POST /v1/podcasts` kicks off a background job
— story pass (`PODCAST_OUTLINE_MODEL`) → per-segment dialogue by the voice owner (`PODCAST_WRITE_MODEL`) → reviews (`PODCAST_REVIEW_MODELS`) → revisions → metadata (`PODCAST_METADATA_MODEL`) → per-turn ElevenLabs synthesis
(`PODCAST_TTS_MODEL`, one voice per host) → gapped concat → loudness-normalised, chaptered MP3 →
optional cover art (image-gen gateway) → optional Audiobookshelf publish. Only one job's pipeline
runs at a time (bounds Replicate fan-out/memory); design + cost expectations + every knob are in
`docs/podcast.md`.

```
POST   /v1/podcasts                  {source, brief?, title?, language?, minutes?, series?, publish?, cover?} → 202 {id, status}
GET    /v1/podcasts                  → {jobs: [...]}  (latest 50)
GET    /v1/podcasts/:id              → the job's public JSON (status, live progress, title, chapters, cost_usd, abs, links, ...)
GET    /v1/podcasts/:id/audio        → the mp3 (attachment)
GET    /v1/podcasts/:id/cover        → the cover PNG
GET    /v1/podcasts/:id/script       → script.json, or a Markdown transcript with ?format=md
POST   /v1/podcasts/:id/publish      → re-run just the Audiobookshelf publish stage (mp3 stays on disk on failure)
DELETE /v1/podcasts/:id              → remove the job + its artifacts (409 while running)
```

CLI (`bun run podcast`):
```bash
bun run podcast -- --source notes.md --minutes 15 --series "Spain Trip" --publish
bun run podcast -- status <id>
bun run podcast -- list
bun run podcast -- publish <id>
```
Base URL: `--base-url` → `$PODCAST_BASE_URL` → `http://localhost:7714`. Auth:
`Authorization: Bearer $AUDIO_TOKEN` (defaults to `claude-code`) — same optional `PROXY_API_KEY`
gate as everything else.

Audiobookshelf model: one SHOW = one library item (folder), one EPISODE = one uploaded audio file
inside it — chapters and cover art are embedded directly in the MP3 (ABS reads them from the file,
not from its own metadata), so a single upload + scan carries everything. `ABS_URL`/`ABS_API_KEY`
unset disables publishing entirely (the job still completes, just without an `abs` link);
`IMAGE_GEN_URL`/`IMAGE_GEN_API_KEY` unset disables cover art the same way.

## Develop
```bash
bun install
bun run dev        # secrets-run injects IU creds from .env.tpl (drop-in op shim)
bun run typecheck
bun test
```

## Status
Built from `PRD.md`. See `docs/reference/audio-proxy-spec.md` for the full behavioral contract.
