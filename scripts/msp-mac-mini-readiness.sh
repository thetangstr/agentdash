#!/usr/bin/env bash
# Readiness evidence collector for the first MSP Mac mini design-partner launch.
#
# Default mode is read-only. Use --run-backup to create a manual logical database
# backup as part of the P1 backup rehearsal.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# SSH and launchd evidence runs often start with only /usr/bin:/bin:/usr/sbin:/sbin.
# Include the standard Homebrew and user-local locations used by the Mac mini install.
export PATH="${AGENTDASH_READINESS_PATH:-${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}:${PATH}"

LABEL="${AGENTDASH_LAUNCHD_LABEL:-ai.agentdash.agent}"
AGENTDASH_HOME="${PAPERCLIP_HOME:-${HOME}/.agentdash}"
CONFIG_DIR="${AGENTDASH_CONFIG_DIR:-${HOME}/.config/agentdash}"
ENV_FILE="${AGENTDASH_ENV_FILE:-${CONFIG_DIR}/agentdash.env}"
LOG_DIR="${AGENTDASH_LOG_DIR:-${AGENTDASH_HOME}/logs}"
PLIST_FILE="${HOME}/Library/LaunchAgents/${LABEL}.plist"
BACKUP_DIR="${AGENTDASH_BACKUP_DIR:-${AGENTDASH_HOME}/instances/default/data/backups}"

RUN_BACKUP=false
BASE_URL_OVERRIDE=""

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

usage() {
  cat <<EOF
Usage: scripts/msp-mac-mini-readiness.sh [--run-backup] [--base-url URL]

Checks the Mac mini launch P0/P1 evidence:
  - launchd service, health endpoint, logs
  - authenticated/private env posture
  - Hermes harness command wiring
  - Tailscale/private URL posture
  - backup posture, optional backup creation
  - billing/email decision posture
  - local security basics

Options:
  --run-backup    Create a manual database backup using pnpm db:backup.
  --base-url URL  Override PAPERCLIP_PUBLIC_URL for the remote health check.
  -h, --help      Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-backup)
      RUN_BACKUP=true
      ;;
    --base-url)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --base-url" >&2; exit 2; }
      BASE_URL_OVERRIDE="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

status_line() {
  local status="$1"
  local message="$2"
  printf '[%s] %s\n' "$status" "$message"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  status_line "PASS" "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  status_line "WARN" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  status_line "FAIL" "$1"
}

info() {
  status_line "INFO" "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

file_mode() {
  local path="$1"
  if stat -f %Lp "$path" >/dev/null 2>&1; then
    stat -f %Lp "$path"
  else
    stat -c %a "$path" 2>/dev/null || true
  fi
}

env_value() {
  local key="$1"
  local line value

  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0

  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" == \"* && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  elif [[ "$value" == \'* && "$value" == *\' ]]; then
    value="${value#\'}"
    value="${value%\'}"
  fi
  printf '%s' "$value"
}

redact_url() {
  local value="$1"
  printf '%s' "$value" | sed -E 's#(postgres://[^:/@]+:)[^@]+@#\1REDACTED@#g'
}

trim_trailing_slash() {
  local value="$1"
  while [[ "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

is_loopback_url() {
  case "$1" in
    http://127.*|https://127.*|http://localhost*|https://localhost*|http://0.0.0.0*|https://0.0.0.0*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

curl_health() {
  local base_url health_url response
  base_url="$(trim_trailing_slash "$1")"
  health_url="${base_url}/api/health"
  if ! have curl; then
    warn "curl is not available; cannot check ${health_url}"
    return 2
  fi
  response="$(curl -fsS --max-time 8 "$health_url" 2>&1)"
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    pass "Health check OK at ${health_url}: ${response}"
    return 0
  fi
  fail "Health check failed at ${health_url}: ${response}"
  return 1
}

check_required_command() {
  local cmd="$1"
  if have "$cmd"; then
    pass "${cmd} is available: $(command -v "$cmd")"
  else
    fail "${cmd} is not available on PATH"
  fi
}

check_optional_command() {
  local cmd="$1"
  if have "$cmd"; then
    pass "${cmd} is available: $(command -v "$cmd")"
  else
    warn "${cmd} is not available on PATH"
  fi
}

check_env_equals() {
  local key="$1"
  local expected="$2"
  local value
  value="$(env_value "$key")"
  if [[ "$value" == "$expected" ]]; then
    pass "${key}=${expected}"
  else
    fail "${key} expected '${expected}', found '${value:-<unset>}'"
  fi
}

check_env_present() {
  local key="$1"
  local value
  value="$(env_value "$key")"
  if [[ -n "$value" ]]; then
    pass "${key} is set"
  else
    fail "${key} is not set"
  fi
}

check_postgres() {
  local db_url
  db_url="$(env_value DATABASE_URL)"
  if [[ -z "$db_url" ]]; then
    fail "DATABASE_URL is not set in ${ENV_FILE}"
    return
  fi
  pass "DATABASE_URL is set: $(redact_url "$db_url")"

  if have docker && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^agentdash-pg$'; then
    if docker exec agentdash-pg pg_isready -U paperclip -d paperclip >/dev/null 2>&1; then
      pass "Docker PostgreSQL container agentdash-pg is ready"
    else
      fail "Docker PostgreSQL container agentdash-pg exists but pg_isready failed"
    fi
    return
  fi

  if have psql; then
    if PGPASSWORD=paperclip psql "$db_url" -c "SELECT 1" >/dev/null 2>&1; then
      pass "PostgreSQL connection responds through psql"
    else
      warn "psql is present but the configured DATABASE_URL did not respond to SELECT 1"
    fi
  else
    warn "No agentdash-pg container and no psql command; database readiness is only indirectly checked through /api/health"
  fi
}

check_launchd() {
  if [[ -f "$PLIST_FILE" ]]; then
    pass "LaunchAgent plist exists: ${PLIST_FILE}"
  else
    fail "LaunchAgent plist missing: ${PLIST_FILE}"
  fi

  if have launchctl; then
    if launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label { found = 1 } END { exit found ? 0 : 1 }'; then
      pass "launchd service is loaded: ${LABEL}"
    else
      fail "launchd service is not loaded: ${LABEL}"
    fi
  else
    fail "launchctl is not available; this does not look like a macOS launchd environment"
  fi
}

check_logs() {
  local err_log="${LOG_DIR}/agentdash.err"
  local app_log="${LOG_DIR}/agentdash.log"
  local secret_pattern='(sk-ant-|sk_live_|sk_test_|whsec_|re_[A-Za-z0-9_-]{20,}|BETTER_AUTH_SECRET=|PAPERCLIP_AGENT_JWT_SECRET=|PAPERCLIP_SECRETS_MASTER_KEY)'

  if [[ -f "$err_log" ]]; then
    if tail -50 "$err_log" | grep -Eiq '(error|exception|traceback|EADDRINUSE|Refusing to start|Cannot find module|Unhandled)'; then
      fail "Recent stderr log contains startup/error-looking output: ${err_log}"
    else
      pass "Recent stderr log has no obvious startup failure: ${err_log}"
    fi
  else
    warn "stderr log not found yet: ${err_log}"
  fi

  if [[ -f "$app_log" || -f "$err_log" ]]; then
    if grep -Eiq "$secret_pattern" "$app_log" "$err_log" 2>/dev/null; then
      fail "Logs appear to contain secret-like material; inspect and rotate before launch"
    else
      pass "Logs do not match the launch secret pattern"
    fi
  else
    warn "No AgentDash logs found under ${LOG_DIR}"
  fi
}

check_hermes() {
  local hermes_cmd resolved
  hermes_cmd="$(env_value AGENTDASH_HERMES_COMMAND)"

  if [[ -z "$hermes_cmd" ]]; then
    fail "AGENTDASH_HERMES_COMMAND is not set; run hermes setup and set an absolute command path"
    if have hermes; then
      info "Hermes is on PATH at $(command -v hermes); write that absolute path into ${ENV_FILE}"
    fi
    return
  fi

  if [[ "$hermes_cmd" != /* ]]; then
    fail "AGENTDASH_HERMES_COMMAND must be absolute, found '${hermes_cmd}'"
  elif [[ -x "$hermes_cmd" ]]; then
    pass "AGENTDASH_HERMES_COMMAND is executable: ${hermes_cmd}"
  else
    fail "AGENTDASH_HERMES_COMMAND is not executable: ${hermes_cmd}"
  fi

  resolved="$(command -v hermes 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    pass "Hermes is available on interactive PATH: ${resolved}"
  else
    warn "Hermes is not on interactive PATH; launchd can still work if AGENTDASH_HERMES_COMMAND is correct"
  fi

  warn "Hermes credential/session proof is manual: run one CoS reply and one hermes_local agent run, then capture the transcript URL"
}

check_network() {
  local bind tailnet_host public_url base_url
  bind="$(env_value PAPERCLIP_BIND)"
  tailnet_host="$(env_value PAPERCLIP_TAILNET_BIND_HOST)"
  public_url="${BASE_URL_OVERRIDE:-$(env_value PAPERCLIP_PUBLIC_URL)}"

  if [[ "$bind" == "tailnet" ]]; then
    pass "PAPERCLIP_BIND=tailnet"
    if [[ -n "$tailnet_host" ]]; then
      pass "PAPERCLIP_TAILNET_BIND_HOST is set: ${tailnet_host}"
    else
      fail "PAPERCLIP_BIND=tailnet but PAPERCLIP_TAILNET_BIND_HOST is empty"
    fi
  elif [[ "$bind" == "loopback" ]]; then
    fail "PAPERCLIP_BIND=loopback; partner devices will not reach the Mac mini"
  else
    warn "PAPERCLIP_BIND is '${bind:-<unset>}'; expected tailnet for the MSP pilot"
  fi

  if have tailscale; then
    local ts_ip
    ts_ip="$(tailscale ip -4 2>/dev/null | awk 'NF { print $1; exit }')"
    if [[ -n "$ts_ip" ]]; then
      pass "Tailscale IPv4 detected: ${ts_ip}"
      if [[ -n "$tailnet_host" && "$tailnet_host" != "$ts_ip" ]]; then
        warn "PAPERCLIP_TAILNET_BIND_HOST (${tailnet_host}) differs from current tailscale ip (${ts_ip})"
      fi
    else
      fail "tailscale is installed but no IPv4 address was detected"
    fi
  else
    warn "tailscale is not installed; private LAN access must be validated another way"
  fi

  if [[ -z "$public_url" ]]; then
    fail "PAPERCLIP_PUBLIC_URL is not set"
    return
  fi

  if is_loopback_url "$public_url"; then
    fail "PAPERCLIP_PUBLIC_URL is loopback (${public_url}); partner devices need a tailnet/LAN URL"
  else
    pass "PAPERCLIP_PUBLIC_URL is non-loopback: ${public_url}"
  fi

  base_url="$(trim_trailing_slash "$public_url")"
  curl_health "$base_url" || true
  warn "Partner-device proof is manual: run the same health/login check from the partner machine or tailnet device"
}

check_backup() {
  if [[ "$RUN_BACKUP" == "true" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
      fail "Cannot run backup because env file is missing: ${ENV_FILE}"
    elif have pnpm; then
      mkdir -p "$BACKUP_DIR" 2>/dev/null || true
      info "Creating manual database backup in ${BACKUP_DIR}"
      (
        cd "$APP_DIR" || exit 1
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
        PAPERCLIP_HOME="$AGENTDASH_HOME" PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}" pnpm db:backup --dir "$BACKUP_DIR" --json
      )
      if [[ $? -eq 0 ]]; then
        pass "Manual database backup command completed"
      else
        fail "Manual database backup command failed"
      fi
    else
      fail "Cannot run backup because pnpm is not available"
    fi
  fi

  if [[ -d "$BACKUP_DIR" ]]; then
    local latest_backup
    latest_backup="$(find "$BACKUP_DIR" -type f -name '*.sql*' -print 2>/dev/null | sort | tail -n 1)"
    if [[ -n "$latest_backup" ]]; then
      pass "Latest database backup found: ${latest_backup}"
    else
      warn "No database backup file found under ${BACKUP_DIR}; run with --run-backup before launch"
    fi
  else
    warn "Backup directory does not exist yet: ${BACKUP_DIR}"
  fi

  if [[ -d "${AGENTDASH_HOME}/instances/default/data/storage" ]]; then
    pass "Local storage directory exists for disaster-recovery backup"
  else
    warn "Local storage directory not found yet; verify if uploads/work products are expected"
  fi

  if [[ -f "${AGENTDASH_HOME}/instances/default/secrets/master.key" ]]; then
    pass "Local encrypted secrets master key exists"
  else
    warn "Secrets master key not found yet; it may be created after first secret write"
  fi
}

check_billing_email() {
  local stripe_key stripe_webhook stripe_price resend from_email
  stripe_key="$(env_value STRIPE_SECRET_KEY)"
  stripe_webhook="$(env_value STRIPE_WEBHOOK_SECRET)"
  stripe_price="$(env_value STRIPE_PRO_PRICE_ID)"
  resend="$(env_value RESEND_API_KEY)"
  from_email="$(env_value AGENTDASH_EMAIL_FROM)"

  if [[ -z "$stripe_key" && -z "$stripe_webhook" && -z "$stripe_price" ]]; then
    warn "Stripe is not configured; launch posture is managed design-partner pilot without self-serve billing"
  elif [[ -n "$stripe_key" && -n "$stripe_webhook" && -n "$stripe_price" ]]; then
    pass "Stripe env vars are present; run checkout/webhook test before expanding usage"
  else
    fail "Stripe env vars are partially configured; either complete them or remove them for managed pilot posture"
  fi

  if [[ -z "$resend" ]]; then
    warn "Resend is not configured; launch posture is manual invites/password resets"
  elif [[ -n "$from_email" ]]; then
    pass "Resend is configured and AGENTDASH_EMAIL_FROM is set"
  else
    fail "RESEND_API_KEY is set but AGENTDASH_EMAIL_FROM is missing"
  fi
}

check_security() {
  if [[ -f "$ENV_FILE" ]]; then
    local mode
    mode="$(file_mode "$ENV_FILE")"
    if [[ "$mode" == "600" ]]; then
      pass "Env file mode is 600: ${ENV_FILE}"
    else
      fail "Env file mode should be 600, found ${mode:-unknown}: ${ENV_FILE}"
    fi
  else
    fail "Env file missing: ${ENV_FILE}"
  fi

  check_env_equals PAPERCLIP_DEPLOYMENT_MODE authenticated
  check_env_equals PAPERCLIP_DEPLOYMENT_EXPOSURE private
  check_env_equals NODE_ENV production
  check_env_equals PAPERCLIP_MIGRATION_AUTO_APPLY true
  check_env_equals AGENTDASH_DEFAULT_ADAPTER hermes_local
  check_env_present BETTER_AUTH_SECRET
  check_env_present PAPERCLIP_AGENT_JWT_SECRET
}

check_local_users() {
  if ! have dscl; then
    warn "dscl is not available; cannot inventory normal local macOS users"
    return
  fi

  local accounts count current_user
  accounts="$(dscl . list /Users UniqueID 2>/dev/null | awk '$2 ~ /^[0-9]+$/ && $2 >= 500 { print $1 " " $2 }' || true)"
  count="$(printf '%s\n' "$accounts" | sed '/^$/d' | wc -l | tr -d ' ')"
  current_user="$(id -un 2>/dev/null || true)"

  if [[ "$count" == "0" ]]; then
    warn "No normal local macOS users with UID >= 500 were detected"
  elif [[ "$count" == "1" ]]; then
    pass "Normal local macOS user inventory: ${accounts}"
    if [[ -n "$current_user" && "$accounts" == "${current_user} "* ]]; then
      pass "Readiness is running as the only detected normal local user: ${current_user}"
    else
      warn "Readiness is running as ${current_user:-<unknown>}, but detected normal local user inventory is: ${accounts}"
    fi
  else
    warn "Multiple normal local macOS users detected; confirm all are intended before partner launch: ${accounts//$'\n'/, }"
  fi
}

print_header() {
  cat <<EOF
AgentDash MSP Mac mini readiness evidence
Timestamp: $(timestamp)
App dir: ${APP_DIR}
Env file: ${ENV_FILE}
Home: ${AGENTDASH_HOME}
Launch label: ${LABEL}

EOF
}

print_summary() {
  cat <<EOF

Summary: ${PASS_COUNT} pass, ${WARN_COUNT} warn, ${FAIL_COUNT} fail
EOF

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    cat <<EOF
Status: NOT READY for design-partner use.
EOF
    return 1
  fi

  cat <<EOF
Status: Code/host preflight passed. Complete manual product proof before moving the PR out of draft:
- CoS returns one Hermes-backed reply.
- One hermes_local agent run completes and transcript is visible.
- Partner machine reaches PAPERCLIP_PUBLIC_URL, logs in, and confirms no unintended public access.
EOF
  return 0
}

print_header

info "Checking required local tools"
check_required_command node
check_required_command pnpm
check_required_command git
check_optional_command docker
check_optional_command tailscale

info "Checking launchd service"
check_launchd

info "Checking local health"
PORT_VALUE="$(env_value PORT)"
curl_health "http://127.0.0.1:${PORT_VALUE:-3100}" || true

info "Checking logs"
check_logs

info "Checking env/security posture"
check_security

info "Checking local macOS account posture"
check_local_users

info "Checking database posture"
check_postgres

info "Checking Hermes harness posture"
check_hermes

info "Checking partner network posture"
check_network

info "Checking backup posture"
check_backup

info "Checking billing/email posture"
check_billing_email

print_summary
exit $?
