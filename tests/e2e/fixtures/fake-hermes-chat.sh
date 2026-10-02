#!/bin/sh
# Stand-in for `hermes chat -Q` used by cos-dispatch-failure.spec.ts.
# Fails exactly the way canary1's CoS profile did (exit 1, reason on STDOUT,
# only the session id on stderr) until the flag file next to this script
# exists (the server strips most env vars from adapter children, so the flag
# is a file, not a variable), then answers normally.
sleep 2
if [ -f "$(dirname "$0")/.fake-hermes-ok" ]; then
  echo "Hello, I am your Chief of Staff and I am back."
  exit 0
fi
echo "Billing or credits exhausted: HTTP 429: Insufficient balance or no resource package. Please recharge."
echo "Add credits or update billing with that provider, then retry."
echo "session_id: 20261002_085216_21b463" 1>&2
exit 1
