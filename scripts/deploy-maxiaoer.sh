#!/usr/bin/env bash
# deploy-maxiaoer.sh — Push current branch to maxiaoer dev server
# Usage: bash scripts/deploy-maxiaoer.sh [--restart]
#   --restart  Also (re)start the dev server via nohup
set -euo pipefail

HOST="maxiaoer@192.168.86.45"
REMOTE_DIR="~/conductor/workspaces/townhall/san-francisco-v1"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REMOTE_PATH="/opt/homebrew/bin"

info() { echo "▸ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

# Ensure we can reach the host
ssh -o ConnectTimeout=5 "$HOST" true 2>/dev/null || fail "Cannot SSH to $HOST"

# Push current branch to origin first so maxiaoer can pull it
info "Pushing $BRANCH to origin..."
git push origin "$BRANCH" 2>&1 | tail -3

# Pull, install, build on remote
info "Deploying to $HOST..."
ssh "$HOST" bash -s -- "$REMOTE_DIR" "$BRANCH" "$REMOTE_PATH" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_DIR="$1"
BRANCH="$2"
export PATH="$3:$PATH"

cd "$REMOTE_DIR"

echo "▸ Fetching and checking out $BRANCH..."
git fetch origin "$BRANCH" --quiet
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

echo "▸ Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -3

echo "▸ Building..."
pnpm build 2>&1 | tail -5

echo "▸ Deploy complete. Commit: $(git log -1 --oneline)"
REMOTE_SCRIPT

# Optionally restart the dev server
if [[ "${1:-}" == "--restart" ]]; then
  info "Restarting dev server on $HOST..."
  ssh "$HOST" bash -s -- "$REMOTE_DIR" "$REMOTE_PATH" <<'RESTART_SCRIPT'
set -euo pipefail
REMOTE_DIR="$1"
export PATH="$2:$PATH"

cd "$REMOTE_DIR"

# Kill existing dev server if running
pkill -f "tsx" 2>/dev/null || true
pkill -f "node.*server" 2>/dev/null || true
sleep 1

# Load auth secret (create if missing)
if [ ! -f .env.local ]; then
  SECRET=$(openssl rand -hex 32)
  echo "BETTER_AUTH_SECRET=$SECRET" > .env.local
  echo "PAPERCLIP_ALLOWED_HOSTNAMES=192.168.86.45,localhost,maxiaoer.local" >> .env.local
fi
set -a; source .env.local; set +a

# Start dev server with network access (authenticated mode, bind 0.0.0.0)
nohup pnpm dev --authenticated-private > /tmp/agentdash-dev.log 2>&1 &
echo "▸ Dev server started (pid $!). Log: /tmp/agentdash-dev.log"
echo "▸ Access at http://192.168.86.45:3100"
RESTART_SCRIPT
fi

info "Done! Access at http://192.168.86.45:3100"
