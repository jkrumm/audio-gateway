# Mini overlay — the podcast instance only (:7719). Layered on top of .env.tpl:
#   secrets-run run --env-file=.env.tpl --env-file=.env.mini.tpl -- bun src/index.ts
# Last file wins per key, so anything here overrides .env.tpl's dev defaults.
# See docs/podcast-editorial-room.md §10 and scripts/launch.sh.

PORT=7719
NODE_ENV=production
MACHINE=mini

# The brain vault is a filesystem checkout only here — this is the whole reason
# the podcast pipeline moved to the mini (Decision 2). Relative to this repo
# (the LaunchAgent's WorkingDirectory, see launchd/com.jkrumm.audio-gateway.plist.template)
# so no tracked file carries the real home path; config.ts resolves it to an
# absolute path at boot.
BRAIN_DIR=../brain

# research-gateway is tailnet-only; the mini is on the tailnet. Same ref
# hermes-agent's .env.tpl uses for its own `research-gateway` skill.
RESEARCH_API_KEY=op://vps/research-gateway/API_SECRET
RESEARCH_GATEWAY_URL=https://research.jkrumm.com

# Usage/cost rows keep the mini instance distinguishable from the VPS one in
# Argo's usage table.
USAGE_SOURCE_LABEL=audio-gateway-mini

# Finished/failed podcast jobs are announced in this Slack channel via Argo
# (channel NAME, resolved through Argo's channel list with ARGO_API_SECRET,
# already set in .env.tpl).
PODCAST_NOTIFY_CHANNEL=media

# Audiobookshelf publish target lives in .env.mini.publish.tpl — a separate
# overlay because secrets-run fails CLOSED on any unseeded ref, and those two
# refs are seeded independently of everything else (headless.refs has them;
# `make secrets-seed` on the MacBook loads them). scripts/launch.sh adds that
# overlay only when it resolves, so an unseeded cache still yields a running
# instance that merely skips publishing.

# image-gen gateway (episode cover art) — same item as the VPS instance.
IMAGE_GEN_URL=https://image-gateway.jkrumm.com
IMAGE_GEN_API_KEY=op://vps/image-gen-gateway/API_SECRET

# Job ledger + episode artifacts live under the repo on this machine, not a
# Docker volume (see scripts/seed-ledger.ts for copying the VPS's history over).
PODCAST_DB=./data/podcasts.db
PODCAST_DATA_DIR=./data/podcasts

# OpenTelemetry export lives in .env.mini.otel.tpl — the same optional-overlay
# trick as publishing: the VPS's public OTLP ingest needs the HyperDX ingestion
# key (OTEL_EXPORTER_OTLP_AUTHORIZATION), seeded on its own, and scripts/launch.sh
# layers the overlay only when it resolves. Either overlay missing shows up on
# GET /health as `degraded: [...]`.
