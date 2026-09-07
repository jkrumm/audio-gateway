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
# start without it rather than not at all. Every overlay that fails to resolve
# is named in AUDIO_GATEWAY_DEGRADED, which the process logs at error level and
# exposes on GET /health as `degraded: [...]` — "started without publishing" is
# a monitor-visible state, not a stderr line nobody reads.
DEGRADED=()

# $1 = overlay name, $2 = template path, $3 = the op:// refs it needs. Sets
# REPLY to the overlay's --env-file argument on success (no command
# substitution — a subshell could not append to DEGRADED); records the name
# otherwise.
overlay_args() {
  local name="$1" tpl="$2" refs="$3"
  if [[ -f "$tpl" ]] && timeout 20 "$SECRETS_RUN" export --env-file="$tpl" >/dev/null 2>&1; then
    REPLY="--env-file=$tpl"
    return 0
  fi
  local unresolved
  unresolved=$(/usr/bin/grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=op://[^[:space:]]+' "$tpl" 2>/dev/null | /usr/bin/sed 's/^[^=]*=//' | /usr/bin/tr '\n' ' ')
  print -u2 "audio-gateway: ERROR overlay '$name' ($tpl) does not resolve — refs: ${unresolved:-$refs}. Starting DEGRADED without it (seed the ref(s) via \`make secrets-seed\` on the MacBook, then \`make launchd-restart\`)."
  DEGRADED+=("$name")
  return 1
}

PUBLISH_ARGS=()
if overlay_args publish "$DIR/.env.mini.publish.tpl" "op://vps/audiobookshelf/*"; then PUBLISH_ARGS=("$REPLY"); fi

# Same story for OpenTelemetry: the HyperDX ingestion key is its own seed.
OTEL_ARGS=()
if overlay_args otel "$DIR/.env.mini.otel.tpl" "op://vps/argo/HYPERDX_API_KEY_PROD"; then OTEL_ARGS=("$REPLY"); fi

export AUDIO_GATEWAY_DEGRADED="${(j:,:)DEGRADED}"

exec "$SECRETS_RUN" run --env-file="$TPL_BASE" --env-file="$TPL_MINI" "${PUBLISH_ARGS[@]}" "${OTEL_ARGS[@]}" -- bun src/index.ts
