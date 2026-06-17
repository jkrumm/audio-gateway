# audio-gateway

OpenAI-compatible audio service on `:7714` that fronts the IU unified audio endpoint and adds a
native **Gemini expressive TTS** pipeline.

- **STT** (`POST /v1/audio/transcriptions`) — downgrades `gpt-4o-transcribe` to `json` and
  synthesizes the rich envelope (`verbose_json`/`srt`/`vtt`) clients expect, with DE/EN language
  steering. Whisper-style models pass through untouched.
- **TTS** (`POST /v1/audio/speech`) — passthrough for OpenAI voices, plus a native Gemini 3.1 Flash
  expressive pipeline (prep-LLM chunking → per-chunk synth → ffmpeg MP3/Opus, default voice Charon)
  with an `X-Audio-Title` response header.

The single source of truth for audio across the stack. Deployed as a single Docker container on the
VPS at `audio-gateway.jkrumm.com`, reachable only over the tailnet; consumed by Argo over localhost
(same host) and by Hermes over the tailnet. Local development runs on the Mac via `bun run dev`
(`:7714`). There is no Mac LaunchAgent. Logs usage to a pluggable sink (SQLite today).

## Develop
```bash
bun install
bun run dev        # op run injects IU creds from .env.tpl
bun run typecheck
bun test
```

## Status
Built from `PRD.md`. See `docs/reference/audio-proxy-spec.md` for the full behavioral contract.
