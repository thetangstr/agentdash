#!/usr/bin/env bash
# AgentDash one-line bootstrap (`curl | bash`).
#
# Clones the repo to a target dir, installs deps, links the CLI to your
# PATH, and chains into `agentdash setup`. Works on any Mac or Linux box
# with node ≥ 20, pnpm, git.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap.sh | bash -s -- /custom/path
set -euo pipefail

REPO_URL="${AGENTDASH_REPO_URL:-https://github.com/thetangstr/agentdash.git}"
TARGET_DIR="${1:-$HOME/agentdash}"

# ---------- prereq checks ----------

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "agentdash bootstrap: \`$cmd\` is required but not found." >&2
    echo "agentdash bootstrap: $hint" >&2
    exit 1
  fi
}

require_cmd git "Install with your OS package manager (e.g. \`brew install git\`, \`apt install git\`)."
require_cmd node "Install Node.js 20+ from https://nodejs.org or via nvm/fnm/asdf."
require_cmd pnpm "Install with \`npm install -g pnpm\` or \`corepack enable && corepack prepare pnpm@latest --activate\`."

# Node ≥ 20 — `node --version` outputs "v20.x.x" or similar.
NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+)\..*/\1/')"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "agentdash bootstrap: Node 20+ required (you have $(node --version))." >&2
  exit 1
fi

# ---------- clone ----------

if [ -e "$TARGET_DIR" ]; then
  if [ ! -d "$TARGET_DIR/.git" ]; then
    echo "agentdash bootstrap: $TARGET_DIR exists but isn't a git repo. Pick a different path or remove it." >&2
    exit 1
  fi
  echo "agentdash bootstrap: $TARGET_DIR already cloned — pulling latest…"
  git -C "$TARGET_DIR" pull --ff-only
else
  echo "agentdash bootstrap: cloning into $TARGET_DIR…"
  git clone "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"

# ---------- install ----------

echo "agentdash bootstrap: installing workspace dependencies (pnpm install)…"
pnpm install --silent

echo "agentdash bootstrap: linking the CLI onto your PATH…"
pnpm install-cli

# ---------- next steps ----------

cat <<EOF

──────────────────────────────────────────────────
✓ AgentDash installed at $TARGET_DIR

Next:
  agentdash setup       # 2 prompts: pick adapter + your email

Then:
  cd $TARGET_DIR && pnpm dev
  open http://localhost:3100/cos

If \`agentdash\` isn't found, the install-cli step above already printed
the \`export PATH=…\` line you need to add to your shell rc.

Docs: $REPO_URL
──────────────────────────────────────────────────
EOF
