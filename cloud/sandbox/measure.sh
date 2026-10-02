#!/bin/sh
# AgentDash: timing harness for the spike (R5). Measures the pieces we can
# measure locally — image build, container start to socket-ready, egress
# apply, signer init — and prints a table SPIKE.md can quote. Run from the
# repo root:  sh cloud/sandbox/measure.sh
set -eu

IMG=agentdash-sandbox-spike
cd "$(dirname "$0")"

t() { # label, command...
  local label="$1"; shift
  local start end
  start=$(python3 -c 'import time;print(time.time_ns())' 2>/dev/null || node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
  "$@" >/dev/null 2>&1
  end=$(python3 -c 'import time;print(time.time_ns())' 2>/dev/null || node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
  echo "$label: $(( (end - start) / 1000 )) ms"
}

echo "== image build (warm layer cache disabled) =="
t "docker build (cold)" docker build --no-cache -q -t "$IMG" .

echo "== container start -> signer socket ready =="
CID=$(docker run -d --rm --cap-add NET_ADMIN "$IMG" sleep infinity)
sleep 0.3
start=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
# Poll until the socket answers a health request.
for i in $(seq 1 100); do
  if docker exec "$CID" sh -c 'echo "{\"op\":\"health\"}" | node /opt/sandbox/sockcat.mjs /run/sandbox-signer/sign.sock' 2>/dev/null | grep -q '"ok":true'; then
    break
  fi
  sleep 0.05
done
end=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
echo "start->socket-ready: $(( (end - start) / 1000 )) ms (after docker run -d returned)"

echo "== egress apply (re-apply inside running container) =="
start=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
docker exec "$CID" /opt/sandbox/egress-apply.sh /etc/sandbox/egress.spec.json >/dev/null
end=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
echo "egress apply: $(( (end - start) / 1000 )) ms"

echo "== signer init roundtrip =="
start=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
docker exec "$CID" sh -c 'echo "{\"op\":\"init\",\"sessionId\":\"t-$$\"}" | node /opt/sandbox/sockcat.mjs /run/sandbox-signer/sign.sock' >/dev/null
end=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
echo "signer init: $(( (end - start) / 1000 )) ms"

echo "== sandbox-ctl apply-run-config roundtrip =="
docker exec "$CID" sh -c 'node /opt/sandbox/sandbox-ctl.mjs --state /run/sandbox open-handshake "{\"side\":\"buyer\"}" >/dev/null'
start=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
SID=$(docker exec "$CID" node -e 'const s=require("/run/sandbox/state.json");console.log(Object.keys(s.sessions)[0])')
docker exec "$CID" sh -c "node /opt/sandbox/sandbox-ctl.mjs --state /run/sandbox apply-run-config '{\"runId\":\"r1\",\"sessionId\":\"$SID\"}'" >/dev/null
end=$(node -e 'console.log(Number(process.hrtime.bigint()/1000n))')
echo "apply-run-config: $(( (end - start) / 1000 )) ms"

docker exec "$CID" /opt/sandbox/healthcheck.sh || true
docker stop "$CID" >/dev/null
