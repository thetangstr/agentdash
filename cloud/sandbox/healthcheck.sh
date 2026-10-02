#!/bin/sh
# AgentDash: per-sandbox health check (spike R9), the shell surface.
# sandbox-ctl.mjs health emits the same checks as JSON; this script is for
# humans / image smoke tests. Exit 0 = healthy.
set -u

fail=0
check() { # name, ok?
  if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi
}

id agent >/dev/null 2>&1;      check "user:agent exists" $?
id signer >/dev/null 2>&1;     check "user:signer exists" $?
id svc >/dev/null 2>&1;        check "user:svc exists" $?

KEY=/etc/sandbox-signer/signing-key.pem
[ "$(stat -c '%a' "$KEY" 2>/dev/null || echo 0)" = "400" ]; check "key mode 0400" $?
[ "$(stat -c '%U' "$KEY" 2>/dev/null || echo x)" = "signer" ]; check "key owner signer" $?

# The agent identity must not be able to read the key — the core R2 guarantee.
su -s /bin/sh agent -c "test -r $KEY" 2>/dev/null
[ $? -ne 0 ]; check "agent cannot read key" $?

[ -S /run/sandbox-signer/sign.sock ]; check "signer socket exists" $?
nft list table inet sandbox_egress >/dev/null 2>&1; check "egress table loaded" $?

su -s /bin/sh agent -c 'echo "{\"op\":\"health\"}" | timeout 3 node /opt/sandbox/sockcat.mjs /run/sandbox-signer/sign.sock' >/dev/null 2>&1
check "agent can reach signer socket" $?

exit $fail
