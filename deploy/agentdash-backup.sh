#!/bin/zsh
# Nightly database backup. Thin wrapper: loads the instance env, then hands off
# to agentdash-backup.mjs, which uses the repository's own backup library.
set -eu

INSTANCE="${AGENTDASH_INSTANCE:-mkboard}"
ENV_FILE="${AGENTDASH_ENV_FILE:-$HOME/.config/agentdash/${INSTANCE}.env}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"

# launchd starts with a minimal PATH; Homebrew's node is not on it.
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

[ -f "$ENV_FILE" ] || { echo "backup: no env file at $ENV_FILE" >&2; exit 78; }
set -a; . "$ENV_FILE"; set +a
export AGENTDASH_INSTANCE

cd "$APP_DIR/server"
exec pnpm exec tsx "$APP_DIR/server/scripts/nightly-backup.mjs"
