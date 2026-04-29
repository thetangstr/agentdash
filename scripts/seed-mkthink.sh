#!/bin/bash
# ============================================================================
# AgentDash — MKthink seed script (AGE-92)
# Pre-seeds the first paying client company so their Day-1 walkthrough starts
# with a personalized wizard, not a blank slate.
#
# Usage:   bash scripts/seed-mkthink.sh
# Idempotent: rerun is safe — exits early if "MKthink" already exists.
# ============================================================================
set -e

BASE="${AGENTDASH_BASE:-http://localhost:3100/api}"
COMPANY_NAME="MKthink"

jq_() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

# Sanity: server reachable
curl -sf "$BASE/health" > /dev/null || {
  echo "ERROR: AgentDash server not reachable at $BASE"
  echo "Start it with: pnpm dev"
  exit 1
}

echo "MKthink seed — target $BASE"

# ----------------------------------------------------------------------------
# Idempotence: we embed a unique sentinel in the description so this script
# only collides with prior runs of itself, not unrelated rows that happen to
# be named "MKthink" (e.g. older manual test data).
#
# (We'd prefer a structured `metadata` field, but the GET /companies query
# doesn't project the column today — tracked in AGE-98.)
# ----------------------------------------------------------------------------
SEED_SENTINEL="[seed:mkthink-first-client]"

EXISTING=$(curl -s "$BASE/companies" | jq_ "
existing = [c for c in d
            if c['name'] == '$COMPANY_NAME'
            and '$SEED_SENTINEL' in (c.get('description') or '')]
print(existing[0]['id'] if existing else '')")

if [ -n "$EXISTING" ]; then
  echo "  [SKIP] $COMPANY_NAME (seeded) already exists (id=$EXISTING)"
  echo "  Done. Visit http://localhost:3100/ to open the dashboard."
  exit 0
fi

# ----------------------------------------------------------------------------
# Create the company. Industry/HubSpot context lives in `metadata` JSONB
# (companies schema has no first-class industry column today).
# ----------------------------------------------------------------------------
echo "  Creating company..."
# Description embeds the sentinel above so future re-runs skip cleanly.
# Industry / workflow context is duplicated into the onboarding source below
# (which IS persisted and surfaces in the wizard).
COMPANY_PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'name': 'MKthink',
    'description': '$SEED_SENTINEL SMB construction services company on HubSpot CRM, ~30 people. First AgentDash pilot client.',
}))")
CID=$(curl -s -X POST "$BASE/companies" -H "Content-Type: application/json" \
  -d "$COMPANY_PAYLOAD" | jq_ "print(d['id'])")
echo "    id=$CID"

# ----------------------------------------------------------------------------
# Onboarding session pre-populated with construction-services context so the
# wizard starts at "confirm or correct," not "tell us about yourself."
# ----------------------------------------------------------------------------
echo "  Creating onboarding session..."
SESS=$(curl -s -X POST "$BASE/companies/$CID/onboarding/sessions" \
  -H "Content-Type: application/json" \
  -d '{"createdByUserId":"mkthink-seed"}' | jq_ "print(d.get('id',''))")
echo "    session=$SESS"

# Ingest a description so context-extraction has something real to chew on.
# Sourced from BUSINESS-PLAN §5 candidate first-wins for construction.
CONTEXT='MKthink is a construction services company with ~30 employees serving general contractors and developers. Pain points: (1) RFIs and submittals get lost in email threads — coordinator spends 4+ hours/day chasing status; (2) inbound leads from website + referrals are not consistently qualified within 24 hours so we lose deals to faster competitors; (3) weekly pipeline review meeting takes 2 hours because nobody has a single source of truth — HubSpot data is partially stale. Tech stack: HubSpot CRM, Slack, Microsoft 365, Procore (project mgmt), DocuSign. Budget: ~$1500/mo for managed AI services in pilot, scaling to ~$3K/mo if value proves out.'

echo "  Ingesting onboarding source..."
curl -s -X POST "$BASE/companies/$CID/onboarding/sessions/$SESS/sources" \
  -H "Content-Type: application/json" \
  -d "{\"sourceType\":\"text_paste\",\"sourceLocator\":\"seed\",\"rawContent\":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$CONTEXT")}" > /dev/null
echo "    source ingested"

echo "  Extracting context (LLM if ANTHROPIC_API_KEY set, else fallback)..."
CTX=$(curl -s -X POST "$BASE/companies/$CID/onboarding/sessions/$SESS/extract" \
  -H "Content-Type: application/json" | jq_ "print(len(d))")
echo "    extracted $CTX context items"

# ----------------------------------------------------------------------------
# Inline starter templates so Day-1 walkthrough has something to spawn.
# AGE-93 will replace these with a proper construction-services starter
# library shipped via migration; this is a tide-over so the seed script
# alone delivers a usable demo.
# ----------------------------------------------------------------------------
echo "  Creating starter agent templates (will be replaced by AGE-99 cross-company library)..."
for tpl in \
  '{"slug":"submittal-coord","name":"Submittal Coordinator","role":"engineer","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":15000,"okrs":[{"objective":"Cut submittal cycle time by 30%","keyResults":[{"metric":"cycle_time_days","target":7,"unit":"days"}]}]}' \
  '{"slug":"rfi-tracker","name":"RFI Tracker","role":"engineer","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":10000,"okrs":[{"objective":"Surface every open RFI within 1 day","keyResults":[{"metric":"rfi_surfacing_lag_hours","target":24,"unit":"hours"}]}]}' \
  '{"slug":"lead-qualifier","name":"Lead Qualifier (SDR)","role":"engineer","adapterType":"opencode_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":12000,"okrs":[{"objective":"Qualify all inbound leads within 1 hour","keyResults":[{"metric":"lead_qual_lag_minutes","target":60,"unit":"minutes"}]}]}' \
  '{"slug":"weekly-pipeline-report","name":"Weekly Pipeline Report","role":"engineer","adapterType":"gemini_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":5000,"okrs":[{"objective":"CEO gets pipeline summary every Monday 8am","keyResults":[{"metric":"reports_delivered","target":4,"unit":"per_month"}]}]}' \
  '{"slug":"proposal-drafter","name":"Proposal First-Drafter","role":"engineer","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":10000,"okrs":[{"objective":"First draft of proposal within 4 hours of RFP","keyResults":[{"metric":"draft_lag_hours","target":4,"unit":"hours"}]}]}'
do
  curl -s -X POST "$BASE/companies/$CID/agent-templates" -H "Content-Type: application/json" -d "$tpl" > /dev/null
done
echo "    5 starter templates created (Submittal Coord, RFI Tracker, Lead Qualifier, Pipeline Report, Proposal Drafter)"

# ----------------------------------------------------------------------------
# Suggest team (returns ranked templates if LLM enabled, all otherwise).
# ----------------------------------------------------------------------------
echo "  Generating suggested team..."
TEAM=$(curl -s -X POST "$BASE/companies/$CID/onboarding/sessions/$SESS/suggest-team" \
  -H "Content-Type: application/json" | jq_ "print(len(d))")
echo "    suggested $TEAM templates"

echo ""
echo "Done."
echo "  Company: $COMPANY_NAME (id=$CID, prefix=MK)"
echo "  Onboarding session: $SESS"
echo "  Templates: 5 starter (Submittal Coord, RFI Tracker, Lead Qualifier, Pipeline Report, Proposal Drafter)"
echo ""
echo "  Open the dashboard: http://localhost:3100/"
echo "  Run again to verify idempotence — should print [SKIP]."
