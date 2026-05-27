#!/bin/bash
# AgentDash LaunchD Installation Script
# Installs AgentDash as a macOS launchd service (per-user).
#
# Usage: ./install.sh [--with-postgres]
#
# Options:
#   --with-postgres    Also start a local PostgreSQL 17 container via Docker
#   --uninstall        Remove the launchd service and stop AgentDash
#
# Requirements:
#   - Node.js 20+ installed
#   - PostgreSQL running (use --with-postgres or ensure external Postgres is available)
#   - Docker (optional, for --with-postgres flag)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENTDASH_HOME="${HOME}/.agentdash"
CONFIG_DIR="${HOME}/.config/agentdash"
DATA_DIR="${AGENTDASH_HOME}/data"
LOG_DIR="${AGENTDASH_HOME}/logs"
PLIST_SRC="${SCRIPT_DIR}/ai.agentdash.agent.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/ai.agentdash.agent.plist"
ENV_FILE="${CONFIG_DIR}/agentdash.env"
LABEL="ai.agentdash.agent"

# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

need() {
    if ! command -v "$1" &>/dev/null; then
        error "Required: $1 (not found in PATH)"
    fi
}

generate_secret() {
    if command -v openssl &>/dev/null; then
        openssl rand -base64 32
        return
    fi
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'
}

detect_tailnet_host() {
    if command -v tailscale &>/dev/null; then
        tailscale ip -4 2>/dev/null | awk 'NF { print $1; exit }'
    fi
}

sed_escape() {
    printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

service_loaded() {
    launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label { found = 1 } END { exit found ? 0 : 1 }'
}

# -------------------------------------------------------------------
# Parse args
# -------------------------------------------------------------------

UNINSTALL=false
WITH_POSTGRES=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --uninstall)   UNINSTALL=true ;;
        --with-postgres) WITH_POSTGRES=true ;;
        *)              error "Unknown argument: $1" ;;
    esac
    shift
done

# -------------------------------------------------------------------
# Uninstall path
# -------------------------------------------------------------------

uninstall_service() {
    info "Stopping and removing AgentDash launchd service..."

    if service_loaded; then
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        info "Service unloaded."
    else
        info "Service not loaded (or not found)."
    fi

    if [[ -f "$PLIST_DST" ]]; then
        rm -f "$PLIST_DST"
        info "Removed $PLIST_DST"
    fi

    info "Uninstall complete."
    info "Data preserved at $AGENTDASH_HOME (remove manually to delete all data)."
    exit 0
}

[[ "$UNINSTALL" == "true" ]] && uninstall_service

# -------------------------------------------------------------------
# Pre-flight checks
# -------------------------------------------------------------------

need node
NODE_BIN="$(command -v node)"
node_major=$(node --version | cut -d. -f1 | tr -d v)
if (( node_major < 20 )); then
    warn "Node.js $(node --version) detected — Node 20+ recommended"
fi
need pnpm
PNPM_BIN="$(command -v pnpm)"
PATH_VALUE="$(dirname "$PNPM_BIN"):$(dirname "$NODE_BIN"):${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Check Postgres
check_postgres() {
    if command -v psql &>/dev/null; then
        PGPASSWORD=paperclip psql -h localhost -U paperclip -d paperclip -c "SELECT 1" &>/dev/null && return 0
    fi
    if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q '^agentdash-pg$'; then
        docker exec agentdash-pg pg_isready -U paperclip -d paperclip &>/dev/null && return 0
    fi
    return 1
}

if check_postgres; then
    info "PostgreSQL connection OK"
elif [[ "$WITH_POSTGRES" == "true" ]]; then
    need docker
    info "Starting PostgreSQL 17 via Docker..."
    if ! docker ps --format '{{.Names}}' | grep -q '^agentdash-pg$'; then
        docker run -d \
            --name agentdash-pg \
            --restart unless-stopped \
            -e POSTGRES_USER=paperclip \
            -e POSTGRES_PASSWORD=paperclip \
            -e POSTGRES_DB=paperclip \
            -v "${DATA_DIR}/postgres:/var/lib/postgresql/data" \
            -p 5432:5432 \
            postgres:17-alpine
        info "PostgreSQL container started."
    else
        info "PostgreSQL container 'agentdash-pg' already running."
    fi

    # Wait for Postgres to be ready
    info "Waiting for PostgreSQL to be ready..."
    for i in $(seq 1 30); do
        if check_postgres; then
            info "PostgreSQL is ready."
            break
        fi
        sleep 1
    done

    if ! check_postgres; then
        error "PostgreSQL did not become ready in time. Check: docker logs agentdash-pg"
    fi
else
    error "PostgreSQL is not running. Either start PostgreSQL externally, or re-run with --with-postgres to start one via Docker."
fi

# -------------------------------------------------------------------
# Build
# -------------------------------------------------------------------

info "Building AgentDash..."
cd "$APP_DIR"

"$PNPM_BIN" install --frozen-lockfile || error "Dependency install failed"
"$PNPM_BIN" build || error "Build failed"

if [[ ! -d "server/dist" ]]; then
    error "Build failed: server/dist not found."
fi
if [[ ! -f "ui/dist/index.html" ]]; then
    error "Build failed: ui/dist/index.html not found."
fi
info "Build OK."

# -------------------------------------------------------------------
# Prepare directories
# -------------------------------------------------------------------

mkdir -p "$CONFIG_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_DST")"

# -------------------------------------------------------------------
# Create env file
# -------------------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
    info "Creating $ENV_FILE..."
    mkdir -p "$CONFIG_DIR"
    BETTER_AUTH_SECRET_VALUE="$(generate_secret)"
    AGENT_JWT_SECRET_VALUE="$(generate_secret)"
    HERMES_COMMAND_VALUE="$(command -v hermes 2>/dev/null || true)"
    TAILNET_HOST_VALUE="$(detect_tailnet_host || true)"
    if [[ -n "$TAILNET_HOST_VALUE" ]]; then
        BIND_VALUE="tailnet"
        PUBLIC_URL_VALUE="http://${TAILNET_HOST_VALUE}:3100"
    else
        BIND_VALUE="loopback"
        PUBLIC_URL_VALUE="http://127.0.0.1:3100"
    fi
    cat > "$ENV_FILE" << ENVVARS
# AgentDash environment — loaded by the launchd service
# Edit this file to configure your deployment.

# Database
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip

# Server
NODE_ENV=production
PORT=3100
SERVE_UI=true

# Deployment
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_BIND=${BIND_VALUE}
PAPERCLIP_PUBLIC_URL=${PUBLIC_URL_VALUE}

# Auth
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET_VALUE}
PAPERCLIP_AGENT_JWT_SECRET=${AGENT_JWT_SECRET_VALUE}

# Tailscale bind. Leave blank for loopback-only, or set to the Mac mini's
# Tailscale IPv4 and set PAPERCLIP_BIND=tailnet.
PAPERCLIP_TAILNET_BIND_HOST=${TAILNET_HOST_VALUE}

# Auto-apply DB migrations on startup
PAPERCLIP_MIGRATION_AUTO_APPLY=true

# CoS chat adapter. Only claude_api, claude_local, and hermes_local are
# supported for CoS chat. Agent execution can use additional adapters.
AGENTDASH_DEFAULT_ADAPTER=hermes_local
AGENTDASH_HERMES_COMMAND=${HERMES_COMMAND_VALUE}

# Optional production integrations.
# ANTHROPIC_API_KEY=
# RESEND_API_KEY=
# AGENTDASH_EMAIL_FROM='AgentDash <noreply@example.com>'
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
# STRIPE_PRO_PRICE_ID=
# BILLING_PUBLIC_BASE_URL=${PUBLIC_URL_VALUE}
ENVVARS
    chmod 600 "$ENV_FILE"
    info "$ENV_FILE created."
else
    info "Using existing $ENV_FILE"
fi

# -------------------------------------------------------------------
# Install launchd plist
# -------------------------------------------------------------------

info "Installing launchd service..."

HOME_ESCAPED="$(sed_escape "$HOME")"
APP_DIR_ESCAPED="$(sed_escape "$APP_DIR")"
ENV_FILE_ESCAPED="$(sed_escape "$ENV_FILE")"
LOG_DIR_ESCAPED="$(sed_escape "$LOG_DIR")"
PNPM_BIN_ESCAPED="$(sed_escape "$PNPM_BIN")"
PATH_VALUE_ESCAPED="$(sed_escape "$PATH_VALUE")"

sed "s|%%HOME%%|${HOME_ESCAPED}|g; s|%%APP_DIR%%|${APP_DIR_ESCAPED}|g; s|%%ENV_FILE%%|${ENV_FILE_ESCAPED}|g; s|%%LOG_DIR%%|${LOG_DIR_ESCAPED}|g; s|%%PNPM_BIN%%|${PNPM_BIN_ESCAPED}|g; s|%%PATH_VALUE%%|${PATH_VALUE_ESCAPED}|g" \
    "$PLIST_SRC" > "$PLIST_DST"
chmod 644 "$PLIST_DST"

# -------------------------------------------------------------------
# Load the service
# -------------------------------------------------------------------

info "Loading launchd service..."

# Unload first in case already loaded
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

# Wait a moment and verify
sleep 2

if service_loaded; then
    info ""
    info "AgentDash is installed and running."
    info "  App dir: ${APP_DIR}"
    info "  Logs:    tail -f ${LOG_DIR}/agentdash.log"
    info "  Stop:    launchctl unload ${PLIST_DST}"
    info "  Restart: launchctl kickstart -k gui/\$(id -u)/${LABEL}"
    info "  Uninstall: ${SCRIPT_DIR}/install.sh --uninstall"
    info ""
    info "Health:  curl -fsS http://127.0.0.1:3100/api/health"
else
    error "Service failed to load. Check: tail -50 ${LOG_DIR}/agentdash.err"
fi
