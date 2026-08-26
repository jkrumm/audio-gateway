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

# Optional ElevenLabs (Replicate lane) delivery overrides — defaults live in
# config.ts (voice Mark, stability 0.5, style 0, similarity 0.75).
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
