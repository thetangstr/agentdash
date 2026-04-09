#!/bin/bash
# AgentDash one-command demo launcher
# Usage: bash scripts/demo.sh

set -euo pipefail

# ============================================
# Colors
# ============================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PID=""

# ============================================
# Cleanup on exit
# ============================================
cleanup() {
  echo ""
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${YELLOW}Stopping dev server (pid $SERVER_PID)...${RESET}"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo -e "${CYAN}Demo session ended.${RESET}"
}
trap cleanup EXIT INT TERM

# ============================================
# Helpers
# ============================================
step() { echo -e "\n${BOLD}${CYAN}==> $*${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
die()  { echo -e "\n${RED}ERROR: $*${RESET}" >&2; exit 1; }

# ============================================
# Banner
# ============================================
echo ""
echo -e "${BOLD}${CYAN}=============================================="
echo -e "  AgentDash — Demo Launcher"
echo -e "==============================================${RESET}"
echo ""

# ============================================
# 1. Check prerequisites
# ============================================
step "Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  die "node is not installed. Install Node.js 18+ from https://nodejs.org"
fi
NODE_VER=$(node --version)
ok "node $NODE_VER"

if ! command -v pnpm >/dev/null 2>&1; then
  die "pnpm is not installed. Install with: npm install -g pnpm"
fi
PNPM_VER=$(pnpm --version)
ok "pnpm $PNPM_VER"

if ! command -v python3 >/dev/null 2>&1; then
  die "python3 is not installed (required by seed script). Install Python 3 from https://python.org"
fi
ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"

if ! command -v curl >/dev/null 2>&1; then
  die "curl is not installed. Install curl via your package manager."
fi
ok "curl $(curl --version | head -1 | awk '{print $2}')"

# ============================================
# 2. Kill any existing process on port 3100
# ============================================
step "Clearing port 3100"

EXISTING_PID=$(lsof -ti tcp:3100 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  warn "Killing existing process on port 3100 (pid $EXISTING_PID)"
  kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
  ok "Port 3100 is now free"
else
  ok "Port 3100 is free"
fi

# ============================================
# 3. Reset embedded database
# ============================================
step "Resetting embedded database"

DB_PATH="$HOME/.paperclip/instances/default/db"
if [ -d "$DB_PATH" ]; then
  rm -rf "$DB_PATH"
  ok "Removed $DB_PATH"
else
  ok "No existing database found (clean start)"
fi

# ============================================
# 4. Install dependencies (only if missing)
# ============================================
step "Checking dependencies"

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  warn "node_modules not found — running pnpm install (this may take a minute)"
  cd "$REPO_ROOT"
  pnpm install
  ok "Dependencies installed"
else
  ok "node_modules present, skipping install"
fi

# ============================================
# 5. Start dev server in background
# ============================================
step "Starting dev server"

LOG_FILE="$REPO_ROOT/.demo-server.log"
cd "$REPO_ROOT"
pnpm dev >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
ok "Dev server started (pid $SERVER_PID, log: $LOG_FILE)"

# ============================================
# 6. Wait for server to be ready (2 min timeout)
# ============================================
step "Waiting for server to be ready"

TIMEOUT=120
ELAPSED=0
POLL_INTERVAL=3
URL="http://localhost:3100/api/companies"

echo -n "  Polling $URL "
while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo ""
    die "Dev server process exited unexpectedly. Check $LOG_FILE for details."
  fi

  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || true)
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    echo ""
    ok "Server is ready (HTTP $HTTP_CODE)"
    break
  fi

  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo ""
    die "Server did not start within ${TIMEOUT}s. Check $LOG_FILE for details."
  fi

  echo -n "."
  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# ============================================
# 7. Seed MKthink demo data
# ============================================
step "Seeding MKthink demo data"

bash "$REPO_ROOT/scripts/seed-mkthink-demo.sh"

# ============================================
# 8. Open browser
# ============================================
step "Opening browser"

if command -v open >/dev/null 2>&1; then
  open "http://localhost:3100"
  ok "Opened http://localhost:3100 in your default browser"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3100"
  ok "Opened http://localhost:3100 in your default browser"
else
  warn "Could not detect a browser opener. Navigate manually to http://localhost:3100"
fi

# ============================================
# 9. Summary
# ============================================
echo ""
echo -e "${BOLD}${GREEN}=============================================="
echo -e "  AgentDash Demo is Live!"
echo -e "==============================================${RESET}"
echo ""
echo -e "  ${BOLD}URL:${RESET}      http://localhost:3100"
echo -e "  ${BOLD}Company:${RESET}  MKthink (Architecture & Design)"
echo ""
echo -e "  ${BOLD}What's loaded:${RESET}"
echo -e "    - 5 agents: BD Lead, 2× Research Analyst, Proposal Writer, Coordinator"
echo -e "    - 2 goals, 1 project, 3 issues"
echo -e "    - 3 active pipelines:"
echo -e "        1. RFP Response Pipeline     (8 stages, 2 HITL gates, fan-out)"
echo -e "        2. Client Onboarding          (5 stages, 1 HITL gate, fan-out)"
echo -e "        3. Site Assessment Workflow   (6 stages, 1 HITL gate, parallel merge)"
echo ""
echo -e "  ${BOLD}Suggested flow:${RESET}"
echo -e "    Select MKthink → Pipelines → open RFP Response Pipeline → Run"
echo ""
echo -e "  ${CYAN}Press Ctrl+C to stop the server and exit.${RESET}"
echo ""

# ============================================
# 10. Keep server running in foreground
# ============================================
wait "$SERVER_PID"
