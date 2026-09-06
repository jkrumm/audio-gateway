# Optional overlay: Audiobookshelf publish target for the mini podcast instance.
# Layered by scripts/launch.sh ONLY when both refs resolve from the mini's
# secrets cache — otherwise the instance starts without publishing (jobs still
# complete; `bun run podcast publish <id>` works once seeded + restarted).
ABS_URL=op://vps/audiobookshelf/URL
ABS_API_KEY=op://vps/audiobookshelf/API_KEY
