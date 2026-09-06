#!/bin/zsh
# audio-gateway launcher — the ProgramArguments of com.jkrumm.audio-gateway
# (podcast-pipeline instance, :7719). Pattern copied from hermes-agent's
# scripts/hermes-serve-launch.sh: never point launchd at a Homebrew binary
# directly (macOS BTM silently disallows it) — this wrapper is the required
# indirection, and it fails closed if any referenced secret can't resolve.

set -u

DIR="${0:A:h:h}"  # scripts/launch.sh -> repo root
cd "$DIR" || { print -u2 "audio-gateway: cannot cd to $DIR"; exit 78; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SECRETS_RUN="$HOME/.local/bin/secrets-run"
TPL_BASE="$DIR/.env.tpl"
TPL_MINI="$DIR/.env.mini.tpl"

[[ -x "$SECRETS_RUN" ]] || { print -u2 "audio-gateway: $SECRETS_RUN missing"; exit 78; }
[[ -f "$TPL_BASE" ]]   || { print -u2 "audio-gateway: $TPL_BASE missing"; exit 78; }
[[ -f "$TPL_MINI" ]]   || { print -u2 "audio-gateway: $TPL_MINI missing"; exit 78; }

# Assert every ref resolves BEFORE handing off — an unresolved ${VAR} would
# otherwise reach the process as a literal string, not fail loudly.
RENDERED=$(timeout 20 "$SECRETS_RUN" export --env-file="$TPL_BASE" --env-file="$TPL_MINI" 2>/dev/null | /usr/bin/grep -c '^export ')
# Unique keys across both files — the overlay overrides some base keys (last wins).
WANT=$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' "$TPL_BASE" "$TPL_MINI" | /usr/bin/sort -u | /usr/bin/wc -l | /usr/bin/tr -d ' ')
if [[ -z "$RENDERED" || "$RENDERED" -lt "$WANT" ]]; then
  print -u2 "audio-gateway: only ${RENDERED:-0}/$WANT refs resolved — refusing to start."
  print -u2 "  Seed the missing refs (add to dotfiles-private/headless.refs, then"
  print -u2 "  \`make secrets-seed\` on the MacBook) and retry."
  exit 78
fi

# Publishing is an optional third layer: its two refs are seeded separately, and
# secrets-run fails closed on ANY unresolved ref — so probe it on its own and
# start without it rather than not at all.
TPL_PUBLISH="$DIR/.env.mini.publish.tpl"
PUBLISH_ARGS=()
if [[ -f "$TPL_PUBLISH" ]] && timeout 20 "$SECRETS_RUN" export --env-file="$TPL_PUBLISH" >/dev/null 2>&1; then
  PUBLISH_ARGS=(--env-file="$TPL_PUBLISH")
else
  print -u2 "audio-gateway: $TPL_PUBLISH does not resolve — starting WITHOUT Audiobookshelf publishing (seed op://vps/audiobookshelf/* and restart)."
fi

exec "$SECRETS_RUN" run --env-file="$TPL_BASE" --env-file="$TPL_MINI" "${PUBLISH_ARGS[@]}" -- bun src/index.ts
