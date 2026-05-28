#!/usr/bin/env bash
# Validate the external confirmation response before moving the MSP Mac mini
# launch PR out of draft.

set -u

RESPONSE_FILE=""
PROOF_OUTPUT_FILE=""

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

usage() {
  cat <<EOF
Usage: scripts/msp-launch-signoff-check.sh --response FILE [--proof-output FILE]

Checks the design-partner external confirmation response for:
  - required signoff fields are filled with concrete values
  - no-go yes/no fields are explicitly confirmed
  - partner proof transcript is a full login proof, not network-only

Options:
  --response FILE      Filled response-template text from the launch owner.
  --proof-output FILE  Redacted output from scripts/msp-partner-access-proof.sh.
                       If omitted, the response file itself must contain the proof transcript.
  -h, --help           Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --response)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --response" >&2; exit 2; }
      RESPONSE_FILE="$1"
      ;;
    --proof-output)
      shift
      [[ $# -gt 0 ]] || { echo "Missing value for --proof-output" >&2; exit 2; }
      PROOF_OUTPUT_FILE="$1"
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

trim() {
  printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

field_value() {
  local label="$1"
  awk -v label="$label" '
    index($0, label ":") == 1 {
      sub(/^[^:]+:[[:space:]]*/, "", $0)
      print
      exit
    }
  ' "$RESPONSE_FILE" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

is_placeholder() {
  local value normalized
  value="$(trim "$1")"
  normalized="$(lower "$value")"

  case "$normalized" in
    ""|"todo"|"tbd"|"unknown"|"n/a"|"na"|"none"|"yes/no"|"yes/no/not required"|"<"*">")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

require_file() {
  local path="$1"
  local description="$2"

  if [[ -z "$path" ]]; then
    fail "${description} is required"
  elif [[ -f "$path" ]]; then
    pass "${description} exists: ${path}"
  else
    fail "${description} does not exist: ${path}"
  fi
}

require_field() {
  local label="$1"
  local value
  value="$(field_value "$label")"

  if is_placeholder "$value"; then
    fail "${label} is required"
  else
    pass "${label} is filled"
  fi
}

require_yes() {
  local label="$1"
  local value
  value="$(lower "$(trim "$(field_value "$label")")")"

  if [[ "$value" == "yes" ]]; then
    pass "${label}=yes"
  else
    fail "${label} must be yes"
  fi
}

check_access_path() {
  local path notes normalized_path
  path="$(field_value "Chosen access path")"
  notes="$(field_value "Tailscale ACL/private-network notes")"
  normalized_path="$(lower "$(trim "$path")")"

  if is_placeholder "$path"; then
    fail "Chosen access path is required"
  else
    pass "Chosen access path is filled: $(trim "$path")"
  fi

  if is_placeholder "$notes"; then
    fail "Tailscale ACL/private-network notes is required"
  else
    pass "Tailscale ACL/private-network notes is filled"
  fi

  if [[ "$normalized_path" == *"tailscale"* ]] && is_placeholder "$notes"; then
    fail "Tailscale access path requires explicit ACL/private-network notes"
  fi
}

check_assess_field() {
  local label value
  label="Browser /assess?onboarding=1 reachable if required"
  value="$(lower "$(trim "$(field_value "$label")")")"

  case "$value" in
    "yes"|"not required")
      pass "${label}=${value}"
      ;;
    *)
      fail "${label} must be yes or not required"
      ;;
  esac
}

check_proof_transcript() {
  local source_file description expected_company
  source_file="$PROOF_OUTPUT_FILE"
  description="Partner proof transcript"
  expected_company="$(field_value "Expected company name or id used for proof")"

  if [[ -z "$source_file" ]]; then
    source_file="$RESPONSE_FILE"
    description="Partner proof transcript embedded in response"
    warn "No --proof-output file supplied; scanning response for embedded partner proof transcript"
  fi

  if [[ ! -f "$source_file" ]]; then
    fail "${description} does not exist: ${source_file}"
    return
  fi

  if grep -Eiq 'network-only|Network precheck passed' "$source_file"; then
    fail "Partner proof transcript must be a full login proof, not network-only"
  else
    pass "Partner proof transcript is not marked network-only"
  fi

  if grep -Fq 'Status: Partner-device access proof passed.' "$source_file"; then
    pass "Partner proof transcript reports partner-device access proof passed"
  else
    fail "Partner proof transcript must contain: Status: Partner-device access proof passed."
  fi

  if grep -Eq 'Summary: [0-9]+ pass, [0-9]+ warn, 0 fail' "$source_file"; then
    pass "Partner proof transcript summary reports 0 fail"
  else
    fail "Partner proof transcript must contain a Summary line with 0 fail"
  fi

  if is_placeholder "$expected_company"; then
    fail "Expected company name or id used for proof is required"
  elif grep -Fq "[PASS] Expected company is visible after login: ${expected_company}" "$source_file"; then
    pass "Partner proof transcript confirms the response expected company: ${expected_company}"
  else
    fail "Partner proof transcript must confirm the response expected company: ${expected_company}"
  fi

  if grep -Eq '^\[PASS\] Expected company is visible after login: .+' "$source_file"; then
    pass "Partner proof transcript confirms the expected company is visible"
  else
    fail "Partner proof transcript must confirm the expected company is visible"
  fi
}

cat <<EOF
AgentDash MSP launch external signoff check

EOF

require_file "$RESPONSE_FILE" "External confirmation response"

if [[ "$FAIL_COUNT" -eq 0 ]]; then
  check_access_path
  require_field "Partner proof timestamp"
  require_field "Partner proof transcript location or redacted output"
  require_yes "Proof account can see expected company"
  check_assess_field
  require_field "Browser /cos Hermes-backed reply run id or transcript"
  require_yes "Operator account maxiaoer confirmed"
  require_yes "GitHub token rotation confirmed"
  require_field "Launch owner"
  require_field "Partner champion"
  require_field "MSP service manager / first operator"
  require_field "Week-one issue channel"
  require_field "Week-one daily check-in time"
  require_field "Week-one approved data classes"
  require_yes "No public URL used unless approved"
  check_proof_transcript
fi

cat <<EOF

Summary: ${PASS_COUNT} pass, ${WARN_COUNT} warn, ${FAIL_COUNT} fail
EOF

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  cat <<EOF
Status: NOT READY for external launch signoff.
EOF
  exit 1
fi

cat <<EOF
Status: Launch external signoff check passed.
EOF
