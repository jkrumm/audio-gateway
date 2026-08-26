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

### Telemetry

The SQLite/Argo usage rows above are the cost-accounting layer; ClickStack traces + logs are the
observability layer beside them, not a replacement. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable a
hand-rolled OTLP/HTTP JSON exporter (no SDK) that emits one trace per request (root span
`audio.speech`/`audio.transcription`, child spans per pipeline stage) plus every `log.*` call as an
OTLP log record. The join key is `request_id` = trace id (dashes stripped from the UUID), so a
trace and its usage rows correlate with no extra column. Unset (default), the exporter is a
complete no-op. Request/response texts on spans are gated by `USAGE_KEEP_TEXT` exactly like the
usage sink.

## Develop
```bash
bun install
bun run dev        # secrets-run injects IU creds from .env.tpl (drop-in op shim)
bun run typecheck
bun test
```

## Status
Built from `PRD.md`. See `docs/reference/audio-proxy-spec.md` for the full behavioral contract.
