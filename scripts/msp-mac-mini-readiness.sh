#!/usr/bin/env bash
# Readiness evidence collector for the first MSP Mac mini design-partner launch.
#
# Default mode is read-only. Use --run-backup to create a manual logical database
# backup and --run-instance-backup to archive local instance files as part of the
# P1 backup rehearsal.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# SSH and launchd evidence runs often start with only /usr/bin:/bin:/usr/sbin:/sbin.
# Include the standard Homebrew and user-local locations used by the Mac mini install.
export PATH="${AGENTDASH_READINESS_PATH:-${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}:${PATH}"

LABEL="${AGENTDASH_LAUNCHD_LABEL:-ai.agentdash.agent}"
AGENTDASH_HOME_OVERRIDE="${AGENTDASH_HOME:-}"
DEFAULT_AGENTDASH_HOME="${AGENTDASH_HOME_OVERRIDE:-${HOME}/.agentdash}"
AGENTDASH_HOME="$DEFAULT_AGENTDASH_HOME"
CONFIG_DIR="${AGENTDASH_CONFIG_DIR:-${HOME}/.config/agentdash}"
ENV_FILE="${AGENTDASH_ENV_FILE:-${CONFIG_DIR}/agentdash.env}"
LOG_DIR="${AGENTDASH_LOG_DIR:-${DEFAULT_AGENTDASH_HOME}/logs}"
PLIST_FILE="${HOME}/Library/LaunchAgents/${LABEL}.plist"
BACKUP_DIR="${AGENTDASH_BACKUP_DIR:-${AGENTDASH_HOME}/instances/default/data/backups}"
INSTANCE_BACKUP_DIR="${AGENTDASH_INSTANCE_BACKUP_DIR:-${BACKUP_DIR}}"

RUN_BACKUP=false
RUN_INSTANCE_BACKUP=false
BASE_URL_OVERRIDE=""
EXPECTED_COMPANY="${AGENTDASH_EXPECTED_COMPANY:-AgentDash MSP Demo}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
LAUNCHD_PID=""

usage() {
  cat <<EOF
Usage: scripts/msp-mac-mini-readiness.sh [--run-backup] [--run-instance-backup] [--base-url URL] [--expected-company VALUE]

Checks the Mac mini launch P0/P1 evidence:
  - launchd service, health endpoint, logs
  - authenticated/private env posture
  - Hermes harness command wiring
  - local agent API write-back URL
  - Tailscale/private URL posture
  - backup posture, optional backup creation
  - billing/email decision posture
  - local security basics

Options:
  --run-backup           Create a manual database backup using pnpm db:backup.
  --run-instance-backup  Archive env/config/storage/secret files that exist.
  --base-url URL         Override PAPERCLIP_PUBLIC_URL for the remote health check.
  --expected-company VALUE
                         Company name or id that must have pro_trial/pro_active entitlement.
                         Defaults to AGENTDASH_EXPECTED_COMPANY or AgentDash MSP Demo.
  -h, --help             Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-backup)
      RUN_BACKUP=true
      ;;
    --run-instance-backup)
      RUN_INSTANCE_BACKUP=true
      ;;
    --base-url)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --base-url" >&2; exit 2; }
      BASE_URL_OVERRIDE="$1"
      ;;
    --expected-company)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --expected-company" >&2; exit 2; }
      EXPECTED_COMPANY="$1"
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

pid_has_ancestor() {
  local pid="$1"
  local ancestor="$2"
  local parent

  [[ -n "$pid" && -n "$ancestor" && "$pid" != "-" && "$ancestor" != "-" ]] || return 1
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    if [[ "$pid" == "$ancestor" ]]; then
      return 0
    fi
    parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$parent" && "$parent" != "$pid" ]] || return 1
    pid="$parent"
  done
  return 1
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

PAPERCLIP_HOME_FROM_ENV="$(env_value PAPERCLIP_HOME)"
if [[ -z "$AGENTDASH_HOME_OVERRIDE" && -n "$PAPERCLIP_HOME_FROM_ENV" ]]; then
  AGENTDASH_HOME="$PAPERCLIP_HOME_FROM_ENV"
  BACKUP_DIR="${AGENTDASH_BACKUP_DIR:-${AGENTDASH_HOME}/instances/default/data/backups}"
  INSTANCE_BACKUP_DIR="${AGENTDASH_INSTANCE_BACKUP_DIR:-${BACKUP_DIR}}"
fi

redact_url() {
  local value="$1"
  printf '%s' "$value" | sed -E 's#(postgres://[^:/@]+:)[^@]+@#\1REDACTED@#g'
}

sql_literal_value() {
  local value="$1"
  printf '%s' "$value" | sed "s/'/''/g"
}

default_embedded_db_url() {
  local port
  port="$(env_value PAPERCLIP_EMBEDDED_POSTGRES_PORT)"
  printf 'postgres://paperclip:paperclip@localhost:%s/paperclip' "${port:-54329}"
}

resolved_database_url() {
  local db_url
  db_url="$(env_value DATABASE_URL)"
  if [[ -n "$db_url" ]]; then
    printf '%s' "$db_url"
  else
    default_embedded_db_url
  fi
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
  db_url="$(resolved_database_url)"
  if [[ -n "$(env_value DATABASE_URL)" ]]; then
    pass "DATABASE_URL is set: $(redact_url "$db_url")"
  else
    pass "DATABASE_URL is unset; checking managed embedded Postgres default: $(redact_url "$db_url")"
  fi

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
  local launchd_row expected_port listener_pids listener_pid listener_owned

  if [[ -f "$PLIST_FILE" ]]; then
    pass "LaunchAgent plist exists: ${PLIST_FILE}"
  else
    fail "LaunchAgent plist missing: ${PLIST_FILE}"
  fi

  if have launchctl; then
    launchd_row="$(launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label { print $0; exit }' || true)"
    if [[ -n "$launchd_row" ]]; then
      LAUNCHD_PID="$(printf '%s' "$launchd_row" | awk '{ print $1 }')"
      pass "launchd service is loaded: ${LABEL}"
    else
      fail "launchd service is not loaded: ${LABEL}"
    fi
  else
    fail "launchctl is not available; this does not look like a macOS launchd environment"
  fi

  expected_port="$(env_value PORT)"
  expected_port="${expected_port:-3100}"
  if ! have lsof; then
    warn "lsof is not available; cannot prove launchd owns TCP port ${expected_port}"
    return
  fi
  if [[ -z "$LAUNCHD_PID" || "$LAUNCHD_PID" == "-" ]]; then
    fail "launchd service has no live PID; cannot prove it owns TCP port ${expected_port}"
    return
  fi

  listener_pids="$(lsof -nP -t -iTCP:"$expected_port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  if [[ -z "$listener_pids" ]]; then
    fail "No process is listening on configured PORT=${expected_port}"
    return
  fi

  listener_owned=false
  while IFS= read -r listener_pid; do
    [[ -n "$listener_pid" ]] || continue
    if pid_has_ancestor "$listener_pid" "$LAUNCHD_PID"; then
      listener_owned=true
      break
    fi
  done <<< "$listener_pids"

  if [[ "$listener_owned" == "true" ]]; then
    pass "launchd service owns configured TCP port ${expected_port}"
  else
    fail "Configured TCP port ${expected_port} is not owned by launchd service ${LABEL}; a stale process may be masking a shifted service port"
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
    warn "PAPERCLIP_BIND=loopback; acceptable only when Tailscale Serve or another private proxy reaches this app"
  elif [[ "$bind" == "lan" ]]; then
    pass "PAPERCLIP_BIND=lan; confirm the Mac mini is not publicly port-forwarded"
  else
    warn "PAPERCLIP_BIND is '${bind:-<unset>}'; expected lan, tailnet, or loopback behind Tailscale Serve for the MSP pilot"
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

check_agent_api_url() {
  local api_url base_url
  api_url="$(env_value PAPERCLIP_API_URL)"

  if [[ -z "$api_url" ]]; then
    fail "PAPERCLIP_API_URL is not set; local agent harnesses may inherit the partner URL and fail API write-back"
    return
  fi

  if is_loopback_url "$api_url"; then
    pass "PAPERCLIP_API_URL is loopback for local agent write-back: ${api_url}"
  else
    fail "PAPERCLIP_API_URL must be loopback for local Mac mini agents, found ${api_url}"
  fi

  base_url="$(trim_trailing_slash "$api_url")"
  curl_health "$base_url" || true
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

  if [[ "$RUN_INSTANCE_BACKUP" == "true" ]]; then
    local archive rel_paths path rel
    archive="${INSTANCE_BACKUP_DIR}/agentdash-instance-files-$(date -u +%Y%m%dT%H%M%SZ).tgz"
    rel_paths=()

    for path in \
      "$ENV_FILE" \
      "${AGENTDASH_HOME}/instances/default/config.json" \
      "${AGENTDASH_HOME}/instances/default/data/storage" \
      "${AGENTDASH_HOME}/instances/default/secrets/master.key"
    do
      if [[ -e "$path" ]]; then
        rel="${path#${HOME}/}"
        if [[ "$rel" == "$path" ]]; then
          warn "Instance backup path is outside HOME and was skipped: ${path}"
        else
          rel_paths+=("$rel")
        fi
      else
        warn "Instance backup path not found yet: ${path}"
      fi
    done

    if [[ "${#rel_paths[@]}" -eq 0 ]]; then
      warn "No instance files were available for archive backup"
    else
      mkdir -p "$INSTANCE_BACKUP_DIR" 2>/dev/null || true
      info "Creating instance file backup in ${INSTANCE_BACKUP_DIR}"
      if tar -czf "$archive" -C "$HOME" "${rel_paths[@]}" 2>/dev/null && chmod 600 "$archive"; then
        pass "Instance file backup created: ${archive}"
      else
        fail "Instance file backup failed: ${archive}"
      fi
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

  if [[ -d "$INSTANCE_BACKUP_DIR" ]]; then
    local latest_instance_backup
    latest_instance_backup="$(find "$INSTANCE_BACKUP_DIR" -type f -name 'agentdash-instance-files-*.tgz' -print 2>/dev/null | sort | tail -n 1)"
    if [[ -n "$latest_instance_backup" ]]; then
      pass "Latest instance file backup found: ${latest_instance_backup}"
    else
      warn "No instance file backup archive found under ${INSTANCE_BACKUP_DIR}; run with --run-instance-backup before expanding usage"
    fi
  else
    warn "Instance backup directory does not exist yet: ${INSTANCE_BACKUP_DIR}"
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
  local stripe_key stripe_webhook stripe_price resend from_email entitlement_tier db_url
  stripe_key="$(env_value STRIPE_SECRET_KEY)"
  stripe_webhook="$(env_value STRIPE_WEBHOOK_SECRET)"
  stripe_price="$(env_value STRIPE_PRO_PRICE_ID)"
  resend="$(env_value RESEND_API_KEY)"
  from_email="$(env_value AGENTDASH_EMAIL_FROM)"
  db_url="$(resolved_database_url)"

  if [[ -z "$stripe_key" && -z "$stripe_webhook" && -z "$stripe_price" ]]; then
    pass "Stripe is not configured on the private Mac mini; paid trial is collected through AgentDash-owned Stripe"
  elif [[ -n "$stripe_key" && -n "$stripe_webhook" && -n "$stripe_price" ]]; then
    warn "Stripe env vars are present on the private Mac mini; confirm this host is not relying on public inbound webhooks"
  else
    fail "Stripe env vars are partially configured; either complete them or remove them for managed pilot posture"
  fi

  if ! have psql; then
    fail "Cannot verify local entitlement because psql is not available"
  else
    local expected_company_sql
    expected_company_sql="$(sql_literal_value "$EXPECTED_COMPANY")"
    entitlement_tier="$(
      PGPASSWORD=paperclip psql "$db_url" -At \
        -c "SELECT plan_tier FROM companies WHERE name = '${expected_company_sql}' OR id::text = '${expected_company_sql}' ORDER BY updated_at DESC LIMIT 1;" \
        2>/dev/null || true
    )"
    case "$entitlement_tier" in
      pro_trial|pro_active)
        pass "Local entitlement for ${EXPECTED_COMPANY} is ${entitlement_tier}"
        ;;
      "")
        fail "Local entitlement company was not found: ${EXPECTED_COMPANY}"
        ;;
      *)
        fail "Local entitlement for ${EXPECTED_COMPANY} must be pro_trial or pro_active, found ${entitlement_tier}"
        ;;
    esac
  fi

  if [[ -z "$resend" ]]; then
    warn "Resend is not configured; launch posture is manual invites/password resets"
  elif [[ -n "$from_email" ]]; then
    pass "Resend is configured and AGENTDASH_EMAIL_FROM is set"
  else
    fail "RESEND_API_KEY is set but AGENTDASH_EMAIL_FROM is missing"
  fi
}

check_git_remote_security() {
  if ! have git; then
    warn "git is not available; cannot inspect launch checkout remotes for embedded credentials"
    return
  fi

  if ! git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "Launch checkout is not a git repository; cannot inspect remotes for embedded credentials"
    return
  fi

  local remotes credential_pattern
  remotes="$(git -C "$APP_DIR" remote -v 2>/dev/null || true)"
  credential_pattern='https?://[^[:space:]/]+:[^[:space:]@]+@|https?://(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[^[:space:]@]*@|(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+'

  if [[ -z "$remotes" ]]; then
    warn "No git remotes configured for launch checkout"
  elif printf '%s\n' "$remotes" | grep -Eiq "$credential_pattern"; then
    fail "Git remotes appear to contain embedded credentials; sanitize remote URLs and rotate exposed tokens before launch"
  else
    pass "Git remotes do not contain embedded credentials"
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
  check_git_remote_security
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
Log dir: ${LOG_DIR}
Launch label: ${LABEL}
Expected company entitlement: ${EXPECTED_COMPANY}

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

info "Checking local agent API posture"
check_agent_api_url

info "Checking backup posture"
check_backup

info "Checking billing/email posture"
check_billing_email

print_summary
exit $?
