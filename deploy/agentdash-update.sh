#!/bin/zsh
# Scheduled over-the-air update for a source deployment.
#
# Runs the STANDALONE copy of the updater under ~/.agentdash/bin, never the one
# in the checkout: an update that changes the updater must not be able to take
# the tool that repairs it away. A successful update refreshes that copy from
# the commit it just deployed.
#
# Default posture is CHECK ONLY. It reports whether the box is behind GitHub and
# changes nothing. That default is deliberate: a bad commit reaching main can
# reach a customer's Mini within the hour, and on 2026-08-18 exactly that
# happened — a change that passed review broke the agent's heartbeat in
# production. Rollback exists and is tested, but "it repairs itself afterwards"
# is a weaker promise than "a person decided".
#
# To let it apply updates unattended, set AGENTDASH_UPDATE_APPLY=1 in the env
# file. It will then back up, deploy, prove health, and roll back to the exact
# previous commit if health does not come back.
set -eu

INSTANCE="${AGENTDASH_INSTANCE:-mkboard}"
ENV_FILE="${AGENTDASH_ENV_FILE:-$HOME/.config/agentdash/${INSTANCE}.env}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"
UPDATER="${AGENTDASH_UPDATER:-$HOME/.agentdash/bin/agentdash-source-update.mjs}"

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

if [ ! -f "$UPDATER" ]; then
  # First run on a machine that has never updated: install from the checkout.
  mkdir -p "$(dirname "$UPDATER")"
  install -m 755 "$APP_DIR/scripts/deploy/agentdash-source-update.mjs" "$UPDATER"
fi

PORT="${PORT:-3102}"
BACKUP_CMD="AGENTDASH_INSTANCE=$INSTANCE /bin/sh $APP_DIR/deploy/agentdash-backup.sh"

echo "[update] $(date -u +%Y-%m-%dT%H:%M:%SZ) instance=$INSTANCE apply=${AGENTDASH_UPDATE_APPLY:-0}"

if [ "${AGENTDASH_UPDATE_APPLY:-0}" = "1" ]; then
  exec node "$UPDATER" \
    --repo-dir "$APP_DIR" \
    --port "$PORT" \
    --base-url "http://127.0.0.1:$PORT" \
    --backup-command "$BACKUP_CMD"
fi

exec node "$UPDATER" --repo-dir "$APP_DIR" --port "$PORT" --check
