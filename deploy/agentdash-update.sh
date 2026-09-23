#!/bin/zsh
# Scheduled over-the-air update for a source deployment.
#
# Runs the STANDALONE copy of the OTA apply tool under ~/.agentdash/bin, never
# the one in the checkout: an update that changes the updater must not be able
# to take the tool that repairs it away. The copy is refreshed from the
# checkout on every run — it is two files (ota-apply.mjs plus the
# ota-release-layout.mjs it imports), installed side by side so the relative
# import resolves.
#
# Default posture is CHECK ONLY. `--check` resolves the newest release tag on
# origin/main, measures the diff, and writes available-release.json into the
# deployments state dir — the file the board's read-only status endpoint reads
# to offer an update. Nothing is applied by this job. That default is
# deliberate: a bad commit reaching main can reach a customer's Mini within
# the hour, and on 2026-08-18 exactly that happened — a change that passed
# review broke the agent's heartbeat in production. Rollback exists and is
# tested, but "it repairs itself afterwards" is a weaker promise than "a
# person decided".
#
# Unattended apply is DISABLED. Setting AGENTDASH_UPDATE_APPLY=1 makes this job
# exit non-zero with a clear reason: applying an immutable release layout does
# nothing on a box that serves straight from its git checkout (which is how the
# live customer box runs), and a restart that cannot kickstart still receipts
# "applied" while the old code keeps running. Apply wiring gets its own issue
# once the releases/current bootstrap is decided.
set -eu

INSTANCE="${AGENTDASH_INSTANCE:-mkboard}"
ENV_FILE="${AGENTDASH_ENV_FILE:-$HOME/.config/agentdash/${INSTANCE}.env}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"
BIN_DIR="${AGENTDASH_BIN_DIR:-$HOME/.agentdash/bin}"
UPDATER="$BIN_DIR/ota-apply.mjs"
STATE_DIR="${AGENTDASH_OTA_STATE_DIR:-$HOME/.agentdash/deployments}"
RELEASES_ROOT="${AGENTDASH_RELEASES_ROOT:-$HOME/.agentdash/releases}"

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

mkdir -p "$BIN_DIR"
install -m 755 "$APP_DIR/scripts/deploy/ota-apply.mjs" "$UPDATER"
install -m 755 "$APP_DIR/scripts/deploy/ota-release-layout.mjs" "$BIN_DIR/ota-release-layout.mjs"

echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) instance=$INSTANCE apply=${AGENTDASH_UPDATE_APPLY:-0}"

if [ "${AGENTDASH_UPDATE_APPLY:-0}" = "1" ]; then
  # Apply is unsupported until the releases/current bootstrap is decided and
  # wired. Refuse loudly rather than fall back to check-only: a silent
  # fallback would leave an operator believing apply works.
  APP_REAL="$(cd "$APP_DIR" 2>/dev/null && pwd -P || echo "")"
  CURRENT_REAL="$(cd "$RELEASES_ROOT/current" 2>/dev/null && pwd -P || echo "")"
  if [ -z "$APP_REAL" ] || [ "$APP_REAL" != "$CURRENT_REAL" ]; then
    echo "[update] REFUSED: AGENTDASH_UPDATE_APPLY=1 but APP_DIR=$APP_DIR does not resolve to $RELEASES_ROOT/current — this box serves straight from a git checkout, where applying a release layout updates nothing the server runs." >&2
    exit 2
  fi
  echo "[update] REFUSED: AGENTDASH_UPDATE_APPLY=1 but unattended apply is unsupported until the releases/current bootstrap is done." >&2
  exit 2
fi

exec node "$UPDATER" \
  --repo-dir "$APP_DIR" \
  --releases-root "$RELEASES_ROOT" \
  --state-dir "$STATE_DIR" \
  --check
