#!/usr/bin/env bash
# Partner-visible access proof for the first MSP Mac mini design-partner launch.
#
# Run this from the partner machine or tailnet/LAN device that will use AgentDash.
# Default mode requires login credentials so the output can serve as P0 evidence.
# Use --network-only for a non-login precheck that does not prove the full gate.

set -u

BASE_URL="${AGENTDASH_PARTNER_BASE_URL:-}"
PROOF_EMAIL="${AGENTDASH_PROOF_EMAIL:-}"
PROOF_PASSWORD="${AGENTDASH_PROOF_PASSWORD:-}"
OUTPUT_FILE="${AGENTDASH_PROOF_OUTPUT:-}"
NETWORK_ONLY=false

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
TMP_DIR=""
COOKIE_JAR=""

usage() {
  cat <<EOF
Usage: scripts/msp-partner-access-proof.sh --base-url URL [--email EMAIL] [--password PASSWORD] [--output FILE] [--network-only]

Collects partner-device launch evidence:
  - partner-visible URL reaches the Mac mini
  - /api/health reports authenticated/private-ready posture
  - unauthenticated board APIs reject access
  - optional sign-in proves login/session/company access from this device

Options:
  --base-url URL     Partner-visible AgentDash URL, for example http://192.168.86.48:3100.
  --email EMAIL      Proof account email. Can also use AGENTDASH_PROOF_EMAIL.
  --password VALUE   Proof account password. Can also use AGENTDASH_PROOF_PASSWORD.
  --output FILE      Write the redacted proof transcript to FILE.
  --network-only     Do not sign in; useful for URL reachability prechecks only.
  -h, --help         Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --base-url" >&2; exit 2; }
      BASE_URL="$1"
      ;;
    --email)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --email" >&2; exit 2; }
      PROOF_EMAIL="$1"
      ;;
    --password)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --password" >&2; exit 2; }
      PROOF_PASSWORD="$1"
      ;;
    --output)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --output" >&2; exit 2; }
      OUTPUT_FILE="$1"
      ;;
    --network-only)
      NETWORK_ONLY=true
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

if [[ -n "$OUTPUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  exec > >(tee "$OUTPUT_FILE") 2>&1
fi

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

trim_trailing_slash() {
  local value="$1"
  while [[ "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

http_get() {
  local url="$1"
  local output="$2"
  curl -sS \
    -o "$output" \
    -w "%{http_code}" \
    -H "Accept: application/json,text/html;q=0.9,*/*;q=0.8" \
    "$url"
}

http_post_json() {
  local url="$1"
  local body="$2"
  local output="$3"
  curl -sS \
    -o "$output" \
    -w "%{http_code}" \
    -c "$COOKIE_JAR" \
    -b "$COOKIE_JAR" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    -H "Origin: $BASE_URL" \
    -X POST \
    "$url" \
    --data "$body"
}

http_get_with_cookies() {
  local url="$1"
  local output="$2"
  curl -sS \
    -o "$output" \
    -w "%{http_code}" \
    -c "$COOKIE_JAR" \
    -b "$COOKIE_JAR" \
    -H "Accept: application/json" \
    "$url"
}

check_base_url() {
  if [[ -z "$BASE_URL" ]]; then
    fail "Partner-visible URL is required; pass --base-url or set AGENTDASH_PARTNER_BASE_URL"
    return
  fi

  BASE_URL="$(trim_trailing_slash "$BASE_URL")"
  if [[ "$BASE_URL" == http://localhost* || "$BASE_URL" == https://localhost* || "$BASE_URL" == http://127.* || "$BASE_URL" == https://127.* ]]; then
    fail "Base URL is loopback (${BASE_URL}); run this from the partner-visible LAN/tailnet URL"
  else
    pass "Base URL is non-loopback: ${BASE_URL}"
  fi
}

check_health() {
  local response status
  response="$TMP_DIR/health.json"
  status="$(http_get "${BASE_URL}/api/health" "$response")"
  if [[ "$status" == "200" ]]; then
    pass "Health endpoint reachable from this device"
  else
    fail "Health endpoint returned HTTP ${status}"
    cat "$response" 2>/dev/null || true
    return
  fi

  if grep -q '"deploymentMode":"authenticated"' "$response"; then
    pass "Health reports authenticated deployment mode"
  else
    fail "Health does not report authenticated deployment mode"
  fi

  if grep -q '"bootstrapStatus":"ready"' "$response"; then
    pass "Health reports bootstrap ready"
  else
    fail "Health does not report bootstrap ready"
  fi

  if grep -q '"bootstrapInviteActive":false' "$response"; then
    pass "Health reports no active bootstrap invite"
  else
    fail "Health reports an active bootstrap invite or omitted bootstrapInviteActive"
  fi
}

check_ui() {
  local response status
  response="$TMP_DIR/root.html"
  status="$(http_get "${BASE_URL}/" "$response")"
  if [[ "$status" == "200" ]] && grep -Eqi '<html|<div id="root"|<script' "$response"; then
    pass "UI shell loads from partner-visible URL"
  else
    fail "UI shell did not load cleanly from partner-visible URL (HTTP ${status})"
  fi
}

check_unauthenticated_rejection() {
  local session_response session_status companies_response companies_status
  session_response="$TMP_DIR/unauth-session.json"
  companies_response="$TMP_DIR/unauth-companies.json"

  session_status="$(http_get "${BASE_URL}/api/auth/get-session" "$session_response")"
  if [[ "$session_status" == "401" || "$session_status" == "403" ]]; then
    pass "Unauthenticated session check is rejected with HTTP ${session_status}"
  else
    fail "Unauthenticated session check should reject; got HTTP ${session_status}"
  fi

  companies_status="$(http_get "${BASE_URL}/api/companies" "$companies_response")"
  if [[ "$companies_status" == "401" || "$companies_status" == "403" ]]; then
    pass "Unauthenticated board API is rejected with HTTP ${companies_status}"
  else
    fail "Unauthenticated /api/companies should reject; got HTTP ${companies_status}"
  fi
}

check_login() {
  local signin_response signin_status session_response session_status companies_response companies_status body

  if [[ "$NETWORK_ONLY" == "true" ]]; then
    warn "Network-only mode: login/session/company proof was intentionally skipped"
    return
  fi

  if [[ -z "$PROOF_EMAIL" || -z "$PROOF_PASSWORD" ]]; then
    fail "Login proof requires --email/--password or AGENTDASH_PROOF_EMAIL/AGENTDASH_PROOF_PASSWORD; use --network-only only for prechecks"
    return
  fi

  signin_response="$TMP_DIR/signin.json"
  body="{\"email\":$(json_string "$PROOF_EMAIL"),\"password\":$(json_string "$PROOF_PASSWORD")}"
  signin_status="$(http_post_json "${BASE_URL}/api/auth/sign-in/email" "$body" "$signin_response")"
  if [[ "$signin_status" =~ ^2 ]]; then
    pass "Proof account sign-in succeeded for ${PROOF_EMAIL}"
  else
    fail "Proof account sign-in failed for ${PROOF_EMAIL} with HTTP ${signin_status}"
    cat "$signin_response" 2>/dev/null || true
    return
  fi

  session_response="$TMP_DIR/session.json"
  session_status="$(http_get_with_cookies "${BASE_URL}/api/auth/get-session" "$session_response")"
  if [[ "$session_status" == "200" ]] && grep -q '"userId"' "$session_response"; then
    pass "Authenticated session is visible from this device"
  else
    fail "Authenticated session check failed with HTTP ${session_status}"
    cat "$session_response" 2>/dev/null || true
  fi

  companies_response="$TMP_DIR/companies.json"
  companies_status="$(http_get_with_cookies "${BASE_URL}/api/companies" "$companies_response")"
  if [[ "$companies_status" == "200" ]] && [[ "$(head -c 1 "$companies_response")" == "[" ]]; then
    pass "Authenticated /api/companies returned a JSON array"
  else
    fail "Authenticated /api/companies failed with HTTP ${companies_status}"
    cat "$companies_response" 2>/dev/null || true
  fi
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentdash-partner-proof.XXXXXX")"
COOKIE_JAR="$TMP_DIR/cookies.txt"

cat <<EOF
AgentDash MSP partner access proof
Timestamp: $(timestamp)
Base URL: ${BASE_URL:-<unset>}
Mode: $([[ "$NETWORK_ONLY" == "true" ]] && printf 'network-only precheck' || printf 'login proof')

EOF

if ! have curl; then
  fail "curl is required"
else
  pass "curl is available: $(command -v curl)"
fi

check_base_url
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  check_health
  check_ui
  check_unauthenticated_rejection
  check_login
fi

cat <<EOF

Summary: ${PASS_COUNT} pass, ${WARN_COUNT} warn, ${FAIL_COUNT} fail
EOF

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  cat <<EOF
Status: NOT READY for partner-device launch proof.
EOF
  exit 1
fi

if [[ "$NETWORK_ONLY" == "true" ]]; then
  cat <<EOF
Status: Network precheck passed. This does not satisfy the partner-device login proof gate.
EOF
else
  cat <<EOF
Status: Partner-device access proof passed.
EOF
fi
