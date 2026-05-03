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

# Defaults are env-var driven so `curl | bash` works without depending on
# positional args (which don't pass through a pipe anyway). Users can still
# override the target dir via env: `AGENTDASH_TARGET_DIR=/foo curl ... | bash`.
# We also accept a single positional arg ($1) for back-compat with users who
# downloaded the script and ran it directly: `bash bootstrap.sh /foo`.
REPO_URL="${AGENTDASH_REPO_URL:-https://github.com/thetangstr/agentdash.git}"
TARGET_DIR_DEFAULT="$HOME/agentdash"

# Resolve the target dir without ever touching $1 directly under `set -u`.
# When this script is curl-piped into bash, $# is 0 and accessing $1 has
# triggered "unbound variable" errors on certain bash builds even with the
# `:-` operator. Branch on $# explicitly to sidestep that whole class.
TARGET_DIR="${AGENTDASH_TARGET_DIR:-}"
if [ -z "$TARGET_DIR" ]; then
  if [ "$#" -gt 0 ]; then
    TARGET_DIR="$1"
  else
    TARGET_DIR="$TARGET_DIR_DEFAULT"
  fi
fi

# Fail-fast guard. If a pathological shell or transport ever drops the
# expansion above and leaves TARGET_DIR empty, we'd later try `cd ""` or
# `git clone "$URL" ""` which produces confusing errors. Catch it here.
if [ -z "${TARGET_DIR:-}" ]; then
  echo "agentdash bootstrap: internal error — TARGET_DIR resolved to empty." >&2
  echo "agentdash bootstrap: report this at https://github.com/thetangstr/agentdash/issues" >&2
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
