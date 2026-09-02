# Dev secrets template — resolved at runtime by:
#   op run --account tkrumm --env-file=.env.tpl -- bun src/index.ts
# Contains ONLY 1Password references, never real secrets.

IU_API_KEY=op://common/anthropic/API_KEY
IU_OPENAI_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_GEMINI_BASE_URL=op://common/anthropic/GEMINI_BASE_URL

# Optional override — only needed if the IU Replicate route doesn't live at
# <IU_OPENAI_BASE_URL with /openai/v1 swapped for /replicate/v1> (the default
# derivation config.ts falls back to when this is unset).
# IU_REPLICATE_BASE_URL=op://common/anthropic/REPLICATE_BASE_URL

# Optional per-caller bearer tokens (name=token,name=token), accepted exactly
# like PROXY_API_KEY, for clients that cannot set x-audio-source (Hermes' stock
# OpenAI client, MacWhisper) — see README.md → Auth. Real tokens belong in
# 1Password, injected the same way PROXY_API_KEY would be.
# AUDIO_CALLER_TOKENS=hermes=<token>,macwhisper=<token>

# Optional ElevenLabs (Replicate lane) delivery overrides — defaults live in
# config.ts (voice Mark, stability 0.5, style 0, similarity 0.75).
# TTS_SUMMARY_MODEL=gemini-3.5-flash-lite   # spoken-summary rewrite; TTS_PREP_MODEL keeps the full briefing prep
# TTS_DEFAULT_LANGUAGE=de   # applied when neither the request nor the text decides DE/EN
# TTS_ELEVENLABS_VOICE=Mark
# TTS_ELEVENLABS_STABILITY=0.5
# TTS_ELEVENLABS_STYLE=0
# TTS_ELEVENLABS_SIMILARITY=0.75
# TTS_REPLICATE_PREP_MODELS=elevenlabs/v3
# TTS_REPLICATE_CHUNK_TARGET_WORDS=60
# TTS_REPLICATE_CHUNK_MAX_WORDS=80

# Optional STT language steering (client-supplied values always win)
STT_PROMPT=Die Aufnahme ist auf Deutsch oder Englisch.

# Usage sink — 'sqlite' (default), 'http', or 'both' (enables the Argo push, requires ARGO_API_SECRET).
USAGE_SINK=both
USAGE_HTTP_URL=https://argo.jkrumm.com/api/usage/records
USAGE_SOURCE_LABEL=audio-gateway
ARGO_API_SECRET=op://common/api/SECRET

# Keep request/response text (truncated 600 chars) on usage rows for the
# usage:tail CLI. Personal data — persisted to the VPS SQLite file and pushed
# to Argo's raw column. Set to 'false' to disable.
# USAGE_KEEP_TEXT=true

# OpenTelemetry traces + logs (OTLP/HTTP JSON, e.g. a ClickStack/HyperDX
# collector). Unset (default) disables the exporter entirely — see otel.ts.
# OTEL_EXPORTER_OTLP_ENDPOINT=http://clickstack:4319
# OTEL_SERVICE_NAME=audio-gateway

# Long-form podcast pipeline — defaults live in config.ts. Only needed to
# override the script/TTS models, voices, host names, timing, or storage paths.
# PODCAST_SCRIPT_MODEL=claude-opus-4-6   # or claude-opus-4-6-eu
# PODCAST_REVIEW_MODEL=claude-opus-4-6
# PODCAST_TTS_MODEL=elevenlabs/v3
# PODCAST_VOICES=Mark,Sarah
# PODCAST_HOST_NAMES=Jonas,Lena
# PODCAST_DEFAULT_MINUTES=20
# PODCAST_STABILITY=0.45
# PODCAST_MP3_BITRATE=64
# PODCAST_GAP_MS=380
# PODCAST_SHORT_GAP_MS=160
# PODCAST_DATA_DIR=./data/podcasts
# PODCAST_DB=./data/podcasts.db
# PODCAST_SERIES=Hermes Briefings
# PODCAST_AUTHOR=Hermes

# Audiobookshelf publish target. Unset ABS_URL disables publishing entirely.
# ABS_URL=https://<your-audiobookshelf-host>
# ABS_API_KEY=op://<vault>/audiobookshelf/API_KEY
# ABS_LIBRARY=Podcasts

# image-gen gateway (episode cover art). Unset IMAGE_GEN_URL disables covers entirely.
# IMAGE_GEN_URL=https://<image-gen-gateway>
# IMAGE_GEN_API_KEY=op://vps/image-gen-gateway/API_SECRET
