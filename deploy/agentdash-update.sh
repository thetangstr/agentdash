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
# To let it apply updates unattended, set AGENTDASH_UPDATE_APPLY=1 in the env
# file. It will then apply ONLY a release a human has already approved through
# the board (pending-approval.json with status "approved") — the approval gate
# is the product's consent model, and this job does not bypass it. With no
# approval on record it falls back to check-only.
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

PORT="${PORT:-3102}"
BACKUP_CMD="AGENTDASH_INSTANCE=$INSTANCE /bin/sh $APP_DIR/deploy/agentdash-backup.sh"
RESTART_CMD="${AGENTDASH_RESTART_COMMAND:-launchctl kickstart -k system/com.agentdash.${INSTANCE}.server}"

echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) instance=$INSTANCE apply=${AGENTDASH_UPDATE_APPLY:-0}"

if [ "${AGENTDASH_UPDATE_APPLY:-0}" = "1" ]; then
  # Apply only what a human approved on the board. The approval file is read,
  # not trusted: ota-apply re-verifies that it authorizes this exact tag and
  # commit before touching anything.
  APPROVED_TAG="$(node -e 'const fs=require("fs");try{const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(a&&a.status==="approved"&&typeof a.tag==="string")process.stdout.write(a.tag)}catch{}' "$STATE_DIR/pending-approval.json")"
  if [ -n "$APPROVED_TAG" ]; then
    exec node "$UPDATER" \
      --repo-dir "$APP_DIR" \
      --releases-root "$RELEASES_ROOT" \
      --state-dir "$STATE_DIR" \
      --tag "$APPROVED_TAG" \
      --base-url "http://127.0.0.1:$PORT" \
      --restart-command "$RESTART_CMD" \
      --backup-command "$BACKUP_CMD" \
      ${AGENTDASH_OTA_ALLOW_MIGRATIONS:+--allow-migrations}
  fi
  echo "[update] apply requested but no approved release is on record; running check only"
fi

exec node "$UPDATER" \
  --repo-dir "$APP_DIR" \
  --releases-root "$RELEASES_ROOT" \
  --state-dir "$STATE_DIR" \
  --check
