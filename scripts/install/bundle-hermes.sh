#!/usr/bin/env bash
#
# Provision the managed Hermes harness for an AgentDash install (idempotent).
#
# AgentDash runs all agents on Hermes (MIT). This installs a PINNED Hermes into
# a managed venv so operators don't set it up by hand, and creates the base
# gateway-pointed template profile that per-agent profiles clone from
# (see services/hermes-profile.ts + scripts/hermes/provision-agent-profile.sh).
#
# Run once at install / upgrade:
#   AGENTDASH_GATEWAY_BASE_URL=... AGENTDASH_GATEWAY_API_KEY=... ./bundle-hermes.sh
#
# Env:
#   HERMES_VERSION                  pinned hermes-agent version (default 0.17.0)
#   AGENTDASH_HERMES_HOME           install root (default ~/.hermes-agentdash)
#   AGENTDASH_GATEWAY_BASE_URL/KEY  when set, the template profile is gateway-pointed
set -euo pipefail

HERMES_VERSION="${HERMES_VERSION:-0.17.0}"
HOME_DIR="${AGENTDASH_HERMES_HOME:-$HOME/.hermes-agentdash}"
VENV="$HOME_DIR/venv"
BIN_DIR="${AGENTDASH_BIN_DIR:-$HOME/.local/bin}"
TEMPLATE="${AGENTDASH_HERMES_PROFILE_TEMPLATE:-agentdash}"

log() { printf '[bundle-hermes] %s\n' "$*"; }

# 1) Python 3.11+ + a managed venv (prefer uv, fall back to python3 -m venv).
mkdir -p "$HOME_DIR" "$BIN_DIR"
if [ ! -x "$VENV/bin/hermes" ]; then
  if command -v uv >/dev/null 2>&1; then
    log "creating venv with uv"
    uv venv --python 3.11 "$VENV"
    log "installing hermes-agent==$HERMES_VERSION (pinned)"
    VIRTUAL_ENV="$VENV" uv pip install "hermes-agent==$HERMES_VERSION"
  else
    PY="$(command -v python3.11 || command -v python3)"
    [ -n "$PY" ] || { echo "ERROR: need python3.11 (or uv) to install Hermes" >&2; exit 1; }
    log "creating venv with $PY"
    "$PY" -m venv "$VENV"
    log "installing hermes-agent==$HERMES_VERSION (pinned)"
    "$VENV/bin/pip" install --quiet --upgrade pip
    "$VENV/bin/pip" install --quiet "hermes-agent==$HERMES_VERSION"
  fi
else
  log "hermes venv already present"
fi

# 2) Stable hermes entrypoint on PATH (this is what the adapter shells out to).
ln -sf "$VENV/bin/hermes" "$BIN_DIR/hermes"
HERMES="$BIN_DIR/hermes"
log "hermes: $("$HERMES" --version 2>&1 | head -1)"

# 3) Base template profile that per-agent profiles clone from.
if ! "$HERMES" profile list 2>/dev/null | awk '{print $1}' | grep -qx "$TEMPLATE"; then
  log "creating template profile '$TEMPLATE'"
  "$HERMES" profile create "$TEMPLATE" --description "AgentDash managed template" >/dev/null
fi
TEMPLATE_DIR="$("$HERMES" profile show "$TEMPLATE" 2>/dev/null | awk -F'Path:[[:space:]]*' '/Path:/{print $2; exit}')"
if [ -n "${AGENTDASH_GATEWAY_BASE_URL:-}" ] && [ -n "${AGENTDASH_GATEWAY_API_KEY:-}" ] && [ -n "$TEMPLATE_DIR" ]; then
  log "pointing template provider at the managed gateway"
  umask 077
  cat > "$TEMPLATE_DIR/.env" <<ENV
HERMES_GATEWAY_BASE_URL=${AGENTDASH_GATEWAY_BASE_URL}
HERMES_GATEWAY_API_KEY=${AGENTDASH_GATEWAY_API_KEY}
ENV
else
  log "gateway env not set — template keeps its own provider config (set keys to gateway-point)"
fi

log "done. Set AGENTDASH_HERMES_COMMAND=$HERMES and AGENTDASH_HERMES_MANAGED_PROFILES=true to enable managed per-agent profiles."
