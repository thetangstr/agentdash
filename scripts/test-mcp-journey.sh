#!/bin/bash
# Full MCP onboarding-journey E2E on a pristine container, using the STUB
# adapter (PAPERCLIP_E2E_SKIP_LLM=true) — so it proves the whole journey
# (signup → setup_adapter → interview → plan card → confirm → agents + goals)
# WITHOUT burning any LLM credits and WITHOUT the claude CLI (respects the
# no-localhost-credit-testing directive).
#
# Gate bypass: AGENTDASH_INVITE_VALIDATION=off (this tests the JOURNEY, not the
# gate; the gate has its own SOP at doc/INVITE-GATE-TEST-SOP.md).
set -u
IMG="${1:-agentdash-journey-test}"
PORT="${JOURNEY_PORT:-3123}"
BASE="http://localhost:${PORT}/api"

ct() { echo; echo "──── $* ────"; }
fail() { echo "FAIL: $1"; docker logs journey-test 2>&1 | tail -25; exit 1; }

# wait for health
for i in $(seq 1 60); do
  [ "$(curl -sS -m5 -o /dev/null -w '%{http_code}' ${BASE}/health 2>/dev/null)" = "200" ] && break
  sleep 3
done
curl -sS ${BASE}/health | head -c 400; echo

ct "1) health reports adapterReady=false (fresh install, no key)"
curl -sS ${BASE}/health | grep -o '"adapterReady":[^,]*' | grep false || fail "expected adapterReady false on fresh install"

ct "2) signup (founding user) — invite validation OFF for journey test"
BODY=$(curl -sS -m20 -X POST ${BASE}/onboarding/mcp-signup \
  -H 'content-type: application/json' \
  -d '{"email":"founder@journey.test","name":"Founder"}' -w "\n%{http_code}")
echo "$BODY"
CODE=$(echo "$BODY" | tail -1)
[ "$CODE" = "201" ] || fail "signup not 201 (got $CODE)"
APIKEY=$(echo "$BODY" | grep -o '"apiKey":"[^"]*"' | head -1 | sed 's/.*"apiKey":"//;s/".*//')
[ -n "$APIKEY" ] || fail "no apiKey in signup response"
AUTH="Authorization: Bearer ${APIKEY}"
echo "got apiKey: ${APIKEY:0:12}…"

ct "3) setup_adapter = stub"
curl -sS -X POST ${BASE}/onboarding/setup-adapter -H "$AUTH" -H 'content-type: application/json' \
  -d '{"preset":"stub"}' -w "\n%{http_code}\n"
curl -sS ${BASE}/health | grep -o '"adapterReady":[^,]*' | grep true || fail "adapterReady not true after stub preset"

ct "4) bootstrap company + CoS"
BOOT=$(curl -sS -X POST ${BASE}/onboarding/bootstrap -H "$AUTH" -H 'content-type: application/json' -d '{}')
echo "$BOOT"
COMPANY=$(echo "$BOOT" | grep -o '"companyId":"[^"]*"' | head -1 | sed 's/.*"companyId":"//;s/".*//')
CONVO=$(echo "$BOOT" | grep -o '"conversationId":"[^"]*"' | head -1 | sed 's/.*"conversationId":"//;s/".*//')
COS=$(echo "$BOOT" | grep -o '"cosAgentId":"[^"]*"' | head -1 | sed 's/.*"cosAgentId":"//;s/".*//')
[ -n "$COMPANY" ] && [ -n "$CONVO" ] && [ -n "$COS" ] || fail "bootstrap missing ids"

ct "5) interview turns (3 fixed Qs + 1 follow-up → stub signals ready)"
PLAN=0
for msg in "fintech for SMBs" "manual onboarding is the bottleneck" "100 paying customers in 90 days" "we use Stripe and Notion"; do
  R=$(curl -sS -X POST ${BASE}/onboarding/interview/turn -H "$AUTH" -H 'content-type: application/json' \
    -d "{\"conversationId\":\"$CONVO\",\"cosAgentId\":\"$COS\",\"userMessage\":\"$msg\"}")
  echo "$R" | head -c 300; echo
  echo "$R" | grep -q '"planGenerated":true' && { PLAN=1; break; }
done
[ "$PLAN" = "1" ] || fail "interview never produced a plan card"

ct "6) confirm-plan → materialize agents + goals"
CONFIRM=$(curl -sS -X POST ${BASE}/onboarding/confirm-plan -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"conversationId\":\"$CONVO\"}" -w "\n%{http_code}")
echo "$CONFIRM"
CCODE=$(echo "$CONFIRM" | tail -1)
[ "$CCODE" = "201" ] || fail "confirm-plan not 201 (got $CCODE)"
echo "$CONFIRM" | grep -q '"createdAgentIds"' || fail "no createdAgentIds"

ct "7) verify team + goals exist"
AGENTS=$(curl -sS ${BASE}/companies/${COMPANY}/agents -H "$AUTH")
echo "agents: $(echo "$AGENTS" | grep -o '"name":"[^"]*"' | head -5)"
echo "$AGENTS" | grep -q 'chief_of_staff' || fail "no CoS in agent list"
echo "$AGENTS" | grep -q 'operations' || fail "stub 'Sam/operations' agent not materialized"
echo
echo "✅ FULL JOURNEY OK — signup → adapter → interview → plan → confirm → agents materialized"
