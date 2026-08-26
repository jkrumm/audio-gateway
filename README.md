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

The single source of truth for audio across the stack. Deployed as a single Docker container on the
VPS at `audio-gateway.jkrumm.com`, reachable only over the tailnet; consumed by Argo over localhost
(same host) and by Hermes over the tailnet. Local development runs on the Mac via `bun run dev`
(`:7714`). There is no Mac LaunchAgent. Logs usage to a pluggable sink (SQLite today).

## Develop
```bash
bun install
bun run dev        # secrets-run injects IU creds from .env.tpl (drop-in op shim)
bun run typecheck
bun test
```

## Status
Built from `PRD.md`. See `docs/reference/audio-proxy-spec.md` for the full behavioral contract.
