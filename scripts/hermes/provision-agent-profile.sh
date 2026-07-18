#!/usr/bin/env bash
#
# Provision / deprovision a distinct Hermes profile per AgentDash agent.
#
# Each AgentDash agent maps to one Hermes profile (~/.hermes/profiles/<id>/):
# its own model/provider, MCP servers, skills, identity, sessions, and state.
# The managed provider credentials are copied from a TEMPLATE profile so the
# key lives in the profile's managed config (gateway-pointed), NOT per agent —
# i.e. token-independent by construction.
#
# Per-run invocation is concurrency-safe via the `-p <profile>` flag (verified
# on the mini 2026-06-24): the agent adapter invokes `hermes -p <id> chat ...`.
#
# Usage:
#   provision-agent-profile.sh create <agentId> [template-profile]
#   provision-agent-profile.sh delete <agentId>
#   provision-agent-profile.sh run    <agentId> -- <hermes chat args...>
#
# Env:
#   HERMES_BIN              path to hermes (default: hermes on PATH)
#   AGENTDASH_GATEWAY_BASE_URL / AGENTDASH_GATEWAY_API_KEY
#                           when set, the profile's provider is pointed at the
#                           managed inference gateway instead of copying a template.
set -euo pipefail

HERMES="${HERMES_BIN:-hermes}"
PROFILES_DIR="${HERMES_PROFILES_DIR:-$HOME/.hermes/profiles}"

cmd="${1:-}"; agent="${2:-}"
[ -n "$cmd" ] && [ -n "$agent" ] || { echo "usage: $0 {create|delete|run} <agentId> [...]" >&2; exit 2; }

profile="agentdash-${agent}"   # namespaced so we never collide with operator profiles

case "$cmd" in
  create)
    template="${3:-agentdash}"
    # Clone via Hermes' native --clone-from so the working provider auth carries
    # over. Copying .env/config.yaml/auth.json instead yields `HTTP 401: invalid
    # api key` (verified on the mini 2026-06-25); only --clone-from clones a
    # working provider.
    "$HERMES" profile create "$profile" --clone-from "$template" --no-alias \
      --description "AgentDash agent ${agent}" >/dev/null
    dst="$PROFILES_DIR/$profile"
    if [ -n "${AGENTDASH_GATEWAY_BASE_URL:-}" ] && [ -n "${AGENTDASH_GATEWAY_API_KEY:-}" ]; then
      # Overlay the managed gateway provider on the cloned base (token-independent).
      cat > "$dst/.env" <<ENV
HERMES_GATEWAY_BASE_URL=${AGENTDASH_GATEWAY_BASE_URL}
HERMES_GATEWAY_API_KEY=${AGENTDASH_GATEWAY_API_KEY}
ENV
      echo "provisioned $profile (clone of '$template') -> managed gateway provider"
    else
      echo "provisioned $profile <- clone of template '$template'"
    fi
    ;;
  delete)
    "$HERMES" profile alias "$profile" --remove 2>/dev/null || true
    "$HERMES" profile delete "$profile" -y >/dev/null 2>&1 || true
    echo "deleted $profile"
    ;;
  run)
    shift 2
    [ "${1:-}" = "--" ] && shift
    exec "$HERMES" -p "$profile" "$@"
    ;;
  *)
    echo "unknown command: $cmd" >&2; exit 2 ;;
esac
