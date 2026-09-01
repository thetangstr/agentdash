#!/bin/bash
# AgentDash — fresh Mac (mini) bootstrap.
#
# Gets a brand-new machine from nothing to "Claude Code has the AgentDash MCP
# server registered and ready", so the agent-guided install
# (agentdash_install_checklist -> launchd -> sign-up -> interview) can take
# over. This script covers ONLY the part that must exist before the MCP
# server can run at all: clone, install, build, register.
#
# Usage (one line, on the fresh machine):
#   curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap-fresh-mac.sh | bash
#
# Or from a local checkout: bash scripts/bootstrap-fresh-mac.sh
#
# Idempotent: safe to re-run; pulls instead of re-cloning, re-registers the
# MCP server, never overwrites an existing env file.
#
# Env overrides (mostly for testing):
#   AGENTDASH_DIR       target checkout dir     (default: ~/agentdash)
#   AGENTDASH_REPO_URL  repo to clone           (default: github.com/thetangstr/agentdash)
#   AGENTDASH_SKIP_MCP_ADD=1   skip the `claude mcp add` step

set -euo pipefail

AGENTDASH_DIR="${AGENTDASH_DIR:-${HOME}/agentdash}"
AGENTDASH_REPO_URL="${AGENTDASH_REPO_URL:-https://github.com/thetangstr/agentdash.git}"
CONFIG_DIR="${HOME}/.config/agentdash"
ENV_FILE="${CONFIG_DIR}/agentdash.env"
STDIO_JS="${AGENTDASH_DIR}/packages/mcp-server/dist/stdio.js"

info() { echo "[bootstrap] $*"; }
fail() { echo "[bootstrap] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------- prereqs --
info "1/6 checking prerequisites"

command -v git >/dev/null 2>&1 \
  || fail "git not found. Run: xcode-select --install   (then re-run this script)"

command -v node >/dev/null 2>&1 \
  || fail "Node.js not found. Install Node 20+: brew install node   (or https://nodejs.org)"

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "${NODE_MAJOR}" -ge 20 ] \
  || fail "Node.js ${NODE_MAJOR} is too old — AgentDash needs Node 20+. brew upgrade node"

if ! command -v pnpm >/dev/null 2>&1; then
  info "pnpm not found — activating via corepack"
  corepack enable >/dev/null 2>&1 || fail "corepack enable failed. Install pnpm manually: npm install -g pnpm"
  corepack prepare pnpm@9.15.4 --activate >/dev/null 2>&1 || fail "corepack could not activate pnpm 9"
fi
info "  node v$(node --version | tr -d v) / pnpm $(pnpm --version)"

HAVE_CLAUDE=1
if ! command -v claude >/dev/null 2>&1; then
  HAVE_CLAUDE=0
  info "  NOTE: Claude Code CLI not found — install with: npm install -g @anthropic-ai/claude-code"
fi

# ------------------------------------------------------------------ clone --
info "2/6 fetching AgentDash into ${AGENTDASH_DIR}"
if [ -d "${AGENTDASH_DIR}/.git" ]; then
  git -C "${AGENTDASH_DIR}" pull --ff-only
else
  git clone --depth 1 "${AGENTDASH_REPO_URL}" "${AGENTDASH_DIR}"
fi

# ---------------------------------------------------------------- install --
info "3/6 installing dependencies (this is the slow step — a few minutes)"
( cd "${AGENTDASH_DIR}" && pnpm install --frozen-lockfile )

# ------------------------------------------------------------------ build --
info "4/6 building the MCP server"
( cd "${AGENTDASH_DIR}" && pnpm --filter @agentdash/mcp-server build )
[ -f "${STDIO_JS}" ] || fail "build did not produce ${STDIO_JS}"

# -------------------------------------------------------------- env file --
info "5/6 priming ${ENV_FILE}"
mkdir -p "${CONFIG_DIR}"
if [ -f "${ENV_FILE}" ]; then
  info "  env file already exists — leaving it untouched"
else
  cat > "${ENV_FILE}" <<'ENVEOF'
# AgentDash server environment — read by the launchd service.
# Written by scripts/bootstrap-fresh-mac.sh; edit freely.

# Authenticated deployment with MCP-native founding signup: the first user is
# created in conversation via agentdash_sign_up. Signup locks itself forever
# once any user exists.
PAPERCLIP_DEPLOYMENT_MODE=authenticated
AGENTDASH_SELF_SERVE_BOOTSTRAP=true

# Model adapter. claude_api is the safe default: it returns stub replies when
# ANTHROPIC_API_KEY is unset (no crash-loop). The customer picks a real provider
# and adds the key during onboarding (agentdash_setup_adapter), which hot-applies
# the env and persists it here. Uncomment + set a key to skip that onboarding step.
AGENTDASH_DEFAULT_ADAPTER=claude_api
# ANTHROPIC_API_KEY=sk-ant-...

# Heartbeat scheduler OFF until the customer confirms their team during
# onboarding — prevents the server from spawning adapters before a model is
# configured. Set to "true" once the fleet should self-drive.
HEARTBEAT_SCHEDULER_ENABLED=false

# Billing is bypassed while STRIPE_SECRET_KEY is unset (dev/pilot default).
ENVEOF
  info "  wrote authenticated-mode defaults (deployment mode + self-serve bootstrap)"
fi

# ---------------------------------------------------------------- mcp add --
info "6/6 registering the MCP server with Claude Code"
if [ "${AGENTDASH_SKIP_MCP_ADD:-0}" = "1" ]; then
  info "  skipped (AGENTDASH_SKIP_MCP_ADD=1)"
elif [ "${HAVE_CLAUDE}" = "1" ]; then
  claude mcp remove --scope user agentdash >/dev/null 2>&1 || true
  claude mcp add --scope user agentdash \
    --env PAPERCLIP_API_URL=http://localhost:3100 \
    -- node "${STDIO_JS}"
  info "  registered as 'agentdash' (user scope, no API key — signup happens in conversation)"
else
  info "  Claude Code CLI missing — after installing it, run:"
  info "    claude mcp add --scope user agentdash --env PAPERCLIP_API_URL=http://localhost:3100 -- node ${STDIO_JS}"
fi

cat <<'DONE'

[bootstrap] Done. Next: start Claude Code anywhere and paste the kickoff
[bootstrap] prompt from doc/MCP-LAUNCH.md (also on https://www.agentdash.cloud/mcp).
[bootstrap] The agent takes it from here: agentdash_install_checklist walks it
[bootstrap] through the launchd service and first boot, then it signs you up
[bootstrap] with your email and runs the onboarding interview.
DONE
