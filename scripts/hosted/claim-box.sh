#!/usr/bin/env bash
# AgentDash: the founder claims their hosted box.
#
# Run by the FOUNDER (not the operator). Creates the founder's account on a
# fresh box with the one-time invite code, using a password only the founder
# types. The browser sign-up form does not yet send an invite code, which is
# why this step is a script (see doc/runbooks/hosted-box.md, "Known gaps").
#
# Usage:
#   scripts/hosted/claim-box.sh https://<box-host> --code-file <path>
#
# After it succeeds: sign in at <box>/auth and create your company. The first
# company on a fresh box makes its creator the box's instance admin.

set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

URL="${1:-}"; shift || true
CODE_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --code-file) CODE_FILE="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$URL" == https://* ]] || die "usage: claim-box.sh https://<box-host> --code-file <path>"
URL="${URL%/}"
[ -n "$CODE_FILE" ] && [ -r "$CODE_FILE" ] || die "--code-file must point at the invite code file"
command -v jq >/dev/null && command -v curl >/dev/null || die "needs jq and curl"

health="$(curl -fsS "$URL/api/health")" || die "box not reachable at $URL"
[ "$(jq -r .deploymentMode <<<"$health")" = "authenticated" ] || die "box is not in authenticated mode; stop and tell the operator"

read -r -p "Your name: " NAME
read -r -p "Your email: " EMAIL
read -r -s -p "Choose a password (12+ characters): " PASSWORD; echo
read -r -s -p "Repeat the password: " PASSWORD2; echo
[ "$PASSWORD" = "$PASSWORD2" ] || die "passwords do not match"
[ "${#PASSWORD}" -ge 12 ] || die "use at least 12 characters"

# Everything goes through stdin; nothing sensitive reaches argv or the terminal.
status="$(jq -n --arg n "$NAME" --arg e "$EMAIL" --arg p "$PASSWORD" --rawfile c "$CODE_FILE" \
    '{name:$n, email:$e, password:$p, inviteCode:($c | gsub("\\s"; ""))}' \
  | curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL/api/auth/sign-up/email" \
      -H 'Content-Type: application/json' -H "Origin: $URL" -d @-)"
unset PASSWORD PASSWORD2

case "$status" in
  200|201) ;;
  403) die "the invite code was refused (HTTP 403). Ask the operator for a fresh code." ;;
  422|400) die "sign-up refused (HTTP $status): the email may already have an account on this box." ;;
  429) die "rate limited; wait 15 minutes and retry." ;;
  *) die "sign-up failed (HTTP $status)." ;;
esac

cat <<EOF
Account created for ${EMAIL}.
Next: open ${URL}/auth, sign in, and create your company.
The first company on this box makes you its instance admin.
EOF
