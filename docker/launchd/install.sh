#!/bin/bash
# AgentDash LaunchD Installation Script
# Installs AgentDash as a macOS launchd service (per-user)
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
AGENTDASH_HOME="${HOME}/.agentdash"
CONFIG_DIR="${HOME}/.config/agentdash"
DATA_DIR="${AGENTDASH_HOME}/data"
LOG_DIR="${AGENTDASH_HOME}/logs"
SHARE_DIR="/usr/local/share/agentdash"
PLIST_SRC="${SCRIPT_DIR}/ai.agentdash.agent.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/ai.agentdash.agent.plist"
ENV_FILE="${CONFIG_DIR}/agentdash.env"
LAUNCH_WRAPPER="${AGENTDASH_HOME}/agentdash-launchd.sh"
LABEL="ai.agentdash.agent"
LEGACY_PLIST_DST="${HOME}/Library/LaunchAgents/com.paperclip.server.plist"
LEGACY_WRAPPER="${HOME}/.paperclip/paperclip-launchd.sh"
LEGACY_LABEL="com.paperclip.server"

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

    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64") + "\n")'
}

launchd_label_loaded() {
    launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "$1"
}

replace_or_append_env_var() {
    local key="$1"
    local value="$2"
    local current=""

    if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
        current="$(grep "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)"
        if [[ -n "$current" ]]; then
            return
        fi

        local tmp_file
        tmp_file="$(mktemp)"
        awk -v key="$key" -v value="$value" '
            BEGIN { replaced = 0 }
            $0 ~ "^" key "=" && replaced == 0 {
                print key "=" value
                replaced = 1
                next
            }
            { print }
        ' "$ENV_FILE" > "$tmp_file"
        mv "$tmp_file" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        info "Filled missing ${key} in ${ENV_FILE}"
        return
    fi

    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    info "Added missing ${key} to ${ENV_FILE}"
}

disable_broken_legacy_service() {
    if [[ ! -f "$LEGACY_PLIST_DST" ]]; then
        return
    fi

    if ! grep -Fq "$LEGACY_WRAPPER" "$LEGACY_PLIST_DST"; then
        warn "Legacy launchd plist exists at ${LEGACY_PLIST_DST}; leaving it in place because it does not reference the known stale wrapper path."
        return
    fi

    if [[ -x "$LEGACY_WRAPPER" ]]; then
        warn "Legacy Paperclip launchd plist exists and its wrapper is executable; leaving it in place."
        return
    fi

    warn "Disabling broken legacy Paperclip launchd plist that points to missing ${LEGACY_WRAPPER}."
    if launchd_label_loaded "$LEGACY_LABEL"; then
        launchctl unload "$LEGACY_PLIST_DST" 2>/dev/null || true
    fi
    mv "$LEGACY_PLIST_DST" "${LEGACY_PLIST_DST}.disabled-$(date +%Y%m%d%H%M%S)"
}

write_launch_wrapper() {
    local node_bin
    node_bin="$(command -v node)"

    cat > "$LAUNCH_WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME}"
export PAPERCLIP_HOME="${AGENTDASH_HOME}"
export PATH="$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ ! -f "${ENV_FILE}" ]; then
  echo "AgentDash launchd env file missing: ${ENV_FILE}" >&2
  exit 1
fi

set -a
. "${ENV_FILE}"
set +a

mkdir -p "${LOG_DIR}"
exec "${node_bin}" "${SHARE_DIR}/server/dist/index.js"
EOF

    chmod 700 "$LAUNCH_WRAPPER"
}

validate_launch_wrapper() {
    if [[ ! -x "$LAUNCH_WRAPPER" ]]; then
        error "Launch wrapper missing or not executable: ${LAUNCH_WRAPPER}"
    fi
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

    if launchd_label_loaded "$LABEL"; then
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
node_major=$(node --version | cut -d. -f1 | tr -d v)
if (( node_major < 20 )); then
    warn "Node.js $(node --version) detected — Node 20+ recommended"
fi
need pnpm

# Check Postgres
check_postgres() {
    PGPASSWORD=paperclip psql -h localhost -U paperclip -d paperclip -c "SELECT 1" &>/dev/null
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
cd "$SCRIPT_DIR/../.."

# Build server + CLI packages
pnpm --filter @paperclipai/server build || error "Server build failed"
pnpm --filter agentdash build           || error "CLI build failed"

if [[ ! -d "server/dist" ]]; then
    error "Build failed: server/dist not found."
fi
info "Build OK."

# -------------------------------------------------------------------
# Install files
# -------------------------------------------------------------------

info "Installing to $SHARE_DIR..."

mkdir -p "$SHARE_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_DST")"

# Copy built artifacts
rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='*.ts' \
    --exclude='*.map' \
    server/dist/ "${SHARE_DIR}/server/dist/"

rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    packages/db/dist/ "${SHARE_DIR}/packages/db/dist/" 2>/dev/null || true
rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    packages/shared/dist/ "${SHARE_DIR}/packages/shared/dist/" 2>/dev/null || true
rsync -av --delete \
    --exclude='node_modules' \
    --exclude='.git' \
    packages/adapters/dist/ "${SHARE_DIR}/packages/adapters/dist/" 2>/dev/null || true

# Copy UI dist if available
if [[ -d "ui-dist" ]]; then
    rsync -av --delete ui-dist/ "${SHARE_DIR}/ui-dist/"
elif [[ -d "packages/ui/dist" ]]; then
    rsync -av --delete packages/ui/dist/ "${SHARE_DIR}/ui-dist/"
fi

# Copy node_modules needed at runtime (better-sqlite3, drizzle, etc.)
# These are needed by the server at runtime
if [[ -d "node_modules/.pnpm" ]]; then
    mkdir -p "${SHARE_DIR}/node_modules"
    # Copy only the packages the server actually needs at runtime
    for pkg in drizzle-orm better-sqlite3 drizzle-driver-pg-like postgres pg pg-native \
                better-auth @auth/core better-sqlite3-admitter \
                embedded-postgres ws express cors helmet \
                ; do
        if [[ -d "node_modules/${pkg}" ]]; then
            rsync -av --delete node_modules/"${pkg}" "${SHARE_DIR}/node_modules/" 2>/dev/null || true
        fi
        # Also check pnpm store
        pnpm_path=$(pnpm ls --depth=0 "${pkg}" --json 2>/dev/null | grep -o '"path":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [[ -n "${pnpm_path}" && -d "${pnpm_path}" ]]; then
            rsync -av --delete "${pnpm_path}" "${SHARE_DIR}/node_modules/" 2>/dev/null || true
        fi
    done
fi

info "Installed to $SHARE_DIR"

# -------------------------------------------------------------------
# Create env file
# -------------------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
    info "Creating $ENV_FILE..."
    mkdir -p "$CONFIG_DIR"
    better_auth_secret="$(generate_secret)"
    agent_jwt_secret="$(generate_secret)"
    cat > "$ENV_FILE" << ENVVARS
# AgentDash environment — loaded by the launchd service
# Edit this file to configure your deployment.

# Database
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip

# Server
PORT=3100
SERVE_UI=true

# Deployment
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private

# Auth
BETTER_AUTH_SECRET=${better_auth_secret}
PAPERCLIP_AGENT_JWT_SECRET=${agent_jwt_secret}

# Optional private-network bind override. Leave commented unless this
# machine needs to bind to a specific Tailscale/private address.
# PAPERCLIP_TAILNET_BIND_HOST=

# Auto-apply DB migrations on startup
PAPERCLIP_MIGRATION_AUTO_APPLY=true

ENVVARS
    chmod 600 "$ENV_FILE"
    info "$ENV_FILE created with generated local auth secrets."
else
    info "Using existing $ENV_FILE"
fi

replace_or_append_env_var "BETTER_AUTH_SECRET" "$(generate_secret)"
replace_or_append_env_var "PAPERCLIP_AGENT_JWT_SECRET" "$(generate_secret)"

# -------------------------------------------------------------------
# Install launchd plist
# -------------------------------------------------------------------

info "Installing launchd service..."

disable_broken_legacy_service
write_launch_wrapper
validate_launch_wrapper

# Generate plist from template, substituting local paths.
sed "s|%%HOME%%|${HOME}|g; s|%%SHARE_DIR%%|${SHARE_DIR}|g; s|%%ENV_FILE%%|${ENV_FILE}|g; s|%%LOG_DIR%%|${LOG_DIR}|g; s|%%LAUNCH_WRAPPER%%|${LAUNCH_WRAPPER}|g" \
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

if launchd_label_loaded "$LABEL"; then
    info ""
    info "AgentDash is installed and running."
    info "  Logs:    tail -f ${LOG_DIR}/agentdash.log"
    info "  Stop:    launchctl unload ${PLIST_DST}"
    info "  Restart: launchctl kickstart -k gui/\$(id -u)/${LABEL}"
    info "  Uninstall: ${SCRIPT_DIR}/install.sh --uninstall"
else
    error "Service failed to load. Check: tail -50 ${LOG_DIR}/agentdash.err"
fi
