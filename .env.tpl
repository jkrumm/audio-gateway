# Dev secrets template — resolved at runtime by:
#   op run --account tkrumm --env-file=.env.tpl -- bun src/index.ts
# Contains ONLY 1Password references, never real secrets.

IU_API_KEY=op://common/anthropic/API_KEY
IU_OPENAI_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_GEMINI_BASE_URL=op://common/anthropic/GEMINI_BASE_URL

# Optional STT language steering (client-supplied values always win)
STT_PROMPT=Die Aufnahme ist auf Deutsch oder Englisch.
