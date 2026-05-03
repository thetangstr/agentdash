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
#
# Shell-hygiene: we deliberately do NOT use `set -u` (nounset). When a
# user's parent shell has weird state (rc file leaks, BASH_ENV pointing
# at sourced files, BASHOPTS exports), `${VAR:-default}` expansions on
# bash 3.2 can intermittently report "unbound variable" errors that
# don't match the script's literal text. We use explicit empty-string
# checks instead — same defensive behavior, no env-leak surprises.
set -eo pipefail

# Defaults: env var first (works through pipes), then positional arg
# (for users who downloaded and ran the script directly), then $HOME.
REPO_URL="${AGENTDASH_REPO_URL:-https://github.com/thetangstr/agentdash.git}"
TARGET_DIR="${AGENTDASH_TARGET_DIR:-${1:-$HOME/agentdash}}"

# Fail-fast guard: refuse to cd or clone into an empty path.
if [ -z "$TARGET_DIR" ]; then
  echo "agentdash bootstrap: TARGET_DIR resolved to empty — pass a path or set AGENTDASH_TARGET_DIR." >&2
  exit 1
fi

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

# ---------- chain into setup (interactive only) ----------
# Call the wrapper by absolute path so we don't depend on the symlink
# we just created being on PATH in this exact shell session. Skip
# automatically in non-TTY environments (CI, Docker without -it,
# `curl | bash` in scripts) so the bootstrap succeeds cleanly even
# when no human is at the terminal.

if [ -t 0 ] && [ -t 1 ]; then
  echo ""
  "$TARGET_DIR/bin/agentdash" setup
else
  echo ""
  echo "agentdash bootstrap: non-interactive shell detected — skipping the setup wizard."
  echo "agentdash bootstrap: run \`agentdash setup\` from a real terminal to finish."
fi

# ---------- start hint ----------

cat <<EOF

──────────────────────────────────────────────────
✓ AgentDash installed and configured at $TARGET_DIR

Start the server:
  cd $TARGET_DIR && pnpm dev

Then open http://localhost:3100/cos.

Docs: $REPO_URL
──────────────────────────────────────────────────
EOF
