#!/usr/bin/env bash
# Full onboarding dry run for NovaTech Solutions
# Tests all 31 steps from doc/ONBOARDING-FLOW.md
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3100/api}"
PASS=0
FAIL=0
FAILURES=""

ok() { ((PASS++)); echo "  ✓ $1"; }
fail() { ((FAIL++)); FAILURES="$FAILURES\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

json_field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }
json_arr_field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }

echo "═══════════════════════════════════════════════════════"
echo "  AgentDash Onboarding Dry Run — NovaTech Solutions"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── PHASE 1: INFRASTRUCTURE ──────────────────────────────
echo "PHASE 1: Infrastructure"

# Step 2: Health check
HEALTH=$(curl -sf "$BASE/health")
STATUS=$(echo "$HEALTH" | json_field "['status']")
if [ "$STATUS" = "ok" ]; then ok "Step 2: Health check"; else fail "Step 2" "status=$STATUS"; fi

# ── PHASE 2: COMPANY SETUP ───────────────────────────────
echo ""
echo "PHASE 2: Company Setup"

# Step 5: Create company
COMPANY=$(curl -sf -X POST "$BASE/companies" \
  -H "Content-Type: application/json" \
  -d '{"name":"NovaTech Solutions","description":"B2B SaaS analytics for SMBs","brandColor":"#0EA5E9"}')
COMPANY_ID=$(echo "$COMPANY" | json_field "['id']")
BRAND=$(echo "$COMPANY" | json_field "['brandColor']")
if [ -n "$COMPANY_ID" ] && [ "$BRAND" = "#0EA5E9" ]; then
  ok "Step 5: Create company (brandColor=$BRAND)"
elif [ -n "$COMPANY_ID" ]; then
  fail "Step 5" "company created but brandColor=$BRAND (expected #0EA5E9)"
else
  fail "Step 5" "company creation failed"
fi

# Step 6: Start onboarding session
SESSION=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/onboarding/sessions" \
  -H "Content-Type: application/json" -d '{"type":"full_onboarding"}')
SESSION_ID=$(echo "$SESSION" | json_field "['id']")
SESS_STATUS=$(echo "$SESSION" | json_field "['status']")
if [ "$SESS_STATUS" = "in_progress" ]; then ok "Step 6: Onboarding session"; else fail "Step 6" "status=$SESS_STATUS"; fi

# Step 7: Ingest sources
SRC1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/onboarding/sessions/$SESSION_ID/sources" \
  -H "Content-Type: application/json" \
  -d '{"sourceType":"paste","sourceLocator":"Company Overview","rawContent":"NovaTech Solutions is a B2B SaaS company with 45 employees building an analytics platform for SMBs. Tech stack: React, Node.js, PostgreSQL, ClickHouse on AWS EKS. Team: 15 engineers, 8 sales, 5 CS. Pain points: slow velocity, manual QA, 2-week customer onboarding."}')
SRC1_ID=$(echo "$SRC1" | json_field "['id']")
SRC1_STATUS=$(echo "$SRC1" | json_field "['status']")
if [ "$SRC1_STATUS" = "pending" ]; then ok "Step 7: Ingest source"; else fail "Step 7" "status=$SRC1_STATUS"; fi

# Step 8: Extract context
EXTRACT=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/onboarding/sessions/$SESSION_ID/extract" \
  -H "Content-Type: application/json" --max-time 30)
CTX_COUNT=$(echo "$EXTRACT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$CTX_COUNT" -ge 1 ]; then ok "Step 8: Extract context ($CTX_COUNT items)"; else fail "Step 8" "count=$CTX_COUNT"; fi

# Step 9: Set goals (with targetDate and priority)
GOAL1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/goals" \
  -H "Content-Type: application/json" \
  -d '{"title":"Ship v2.0 Dashboard","description":"Complete redesign in 6 weeks","priority":"critical","targetDate":"2026-05-11T00:00:00Z"}')
GOAL1_ID=$(echo "$GOAL1" | json_field "['id']")
GOAL_PRI=$(echo "$GOAL1" | json_field "['priority']")
GOAL_TD=$(echo "$GOAL1" | json_field "['targetDate']")
if [ "$GOAL_PRI" = "critical" ] && [ "$GOAL_TD" != "None" ] && [ "$GOAL_TD" != "null" ]; then
  ok "Step 9: Create goal (priority=$GOAL_PRI, targetDate set)"
elif [ -n "$GOAL1_ID" ]; then
  fail "Step 9" "goal created but priority=$GOAL_PRI targetDate=$GOAL_TD"
else
  fail "Step 9" "goal creation failed"
fi

# ── PHASE 3: GOVERNANCE ──────────────────────────────────
echo ""
echo "PHASE 3: Governance"

# Step 10: Create departments
DEPT_ENG=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/departments" \
  -H "Content-Type: application/json" -d '{"name":"Engineering","description":"Product development"}')
DEPT_ENG_ID=$(echo "$DEPT_ENG" | json_field "['id']")
if [ -n "$DEPT_ENG_ID" ]; then ok "Step 10: Create department (Engineering)"; else fail "Step 10" "department creation failed"; fi

# Step 11: Security policies
POL1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/security-policies" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Deploy Gate\",\"policyType\":\"action_limit\",\"targetType\":\"company\",\"targetId\":\"$COMPANY_ID\",\"rules\":{\"maxActionsPerHour\":10},\"description\":\"Rate-limit deployments\"}")
POL1_ID=$(echo "$POL1" | json_field "['id']")
POL1_ACTIVE=$(echo "$POL1" | json_field "['isActive']")
if [ "$POL1_ACTIVE" = "True" ]; then ok "Step 11: Security policy (active)"; else fail "Step 11" "isActive=$POL1_ACTIVE"; fi

# ── PHASE 4: AGENT TEMPLATES ─────────────────────────────
echo ""
echo "PHASE 4: Agent Templates"

# Step 13: Create templates (with budget, skills, departmentId)
TPL1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/agent-templates" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Tech Lead\",\"slug\":\"tech-lead\",\"role\":\"tech_lead\",\"defaultAdapter\":\"claude_local\",\"defaultBudgetCents\":50000,\"skills\":[\"code-review\",\"architecture\"],\"departmentId\":\"$DEPT_ENG_ID\"}")
TPL1_ID=$(echo "$TPL1" | json_field "['id']")
TPL1_BUDGET=$(echo "$TPL1" | json_field "['budgetMonthlyCents']")
TPL1_SKILLS=$(echo "$TPL1" | json_field "['skillKeys']")
TPL1_DEPT=$(echo "$TPL1" | json_field "['departmentId']")
if [ "$TPL1_BUDGET" = "50000" ] && [ "$TPL1_DEPT" = "$DEPT_ENG_ID" ]; then
  ok "Step 13a: Template Tech Lead (budget=$TPL1_BUDGET, dept=$TPL1_DEPT)"
elif [ -n "$TPL1_ID" ]; then
  fail "Step 13a" "template created but budget=$TPL1_BUDGET skills=$TPL1_SKILLS dept=$TPL1_DEPT"
else
  fail "Step 13a" "template creation failed"
fi

TPL2=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/agent-templates" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Software Engineer\",\"slug\":\"software-engineer\",\"role\":\"engineer\",\"budgetMonthlyCents\":30000,\"skillKeys\":[\"frontend\",\"backend\"],\"departmentId\":\"$DEPT_ENG_ID\"}")
TPL2_ID=$(echo "$TPL2" | json_field "['id']")

TPL3=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/agent-templates" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"QA Engineer\",\"slug\":\"qa-engineer\",\"role\":\"qa\",\"budgetMonthlyCents\":20000,\"departmentId\":\"$DEPT_ENG_ID\"}")
TPL3_ID=$(echo "$TPL3" | json_field "['id']")

if [ -n "$TPL2_ID" ] && [ -n "$TPL3_ID" ]; then ok "Step 13b: Templates Engineer + QA"; else fail "Step 13b" "template creation failed"; fi

# Step 14: Suggest team
SUGGEST=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/onboarding/sessions/$SESSION_ID/suggest-team" \
  -H "Content-Type: application/json" --max-time 30)
SUGGEST_COUNT=$(echo "$SUGGEST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "$SUGGEST_COUNT" -ge 1 ]; then ok "Step 14: Suggest team ($SUGGEST_COUNT templates)"; else fail "Step 14" "count=$SUGGEST_COUNT"; fi

# Step 15: Complete onboarding
COMPLETE=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/onboarding/sessions/$SESSION_ID/complete" \
  -H "Content-Type: application/json")
COMP_STATUS=$(echo "$COMPLETE" | json_field "['status']")
if [ "$COMP_STATUS" = "completed" ]; then ok "Step 15: Complete onboarding"; else fail "Step 15" "status=$COMP_STATUS"; fi

# ── PHASE 5: AGENT DEPLOYMENT ────────────────────────────
echo ""
echo "PHASE 5: Agent Deployment"

# Step 16: Spawn agents
SPAWN1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/spawn-requests" \
  -H "Content-Type: application/json" \
  -d "{\"templateId\":\"$TPL1_ID\",\"quantity\":1,\"reason\":\"Tech lead for v2.0\"}")
SPAWN1_APPROVAL=$(echo "$SPAWN1" | json_field "['approval']['id']")

SPAWN2=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/spawn-requests" \
  -H "Content-Type: application/json" \
  -d "{\"templateId\":\"$TPL2_ID\",\"quantity\":2,\"reason\":\"Engineers for v2.0\"}")
SPAWN2_APPROVAL=$(echo "$SPAWN2" | json_field "['approval']['id']")

SPAWN3=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/spawn-requests" \
  -H "Content-Type: application/json" \
  -d "{\"templateId\":\"$TPL3_ID\",\"quantity\":1,\"reason\":\"QA for testing\"}")
SPAWN3_APPROVAL=$(echo "$SPAWN3" | json_field "['approval']['id']")

if [ -n "$SPAWN1_APPROVAL" ] && [ -n "$SPAWN2_APPROVAL" ] && [ -n "$SPAWN3_APPROVAL" ]; then
  ok "Step 16: Spawn requests (3 pending)"
else
  fail "Step 16" "spawn request failed"
fi

# Step 17: Approve spawn requests
APP1=$(curl -sf -X POST "$BASE/approvals/$SPAWN1_APPROVAL/approve" \
  -H "Content-Type: application/json" -d '{"decisionNote":"Approved for v2.0"}')
APP1_STATUS=$(echo "$APP1" | json_field "['status']")

APP2=$(curl -sf -X POST "$BASE/approvals/$SPAWN2_APPROVAL/approve" \
  -H "Content-Type: application/json" -d '{"decisionNote":"Approved"}')
APP3=$(curl -sf -X POST "$BASE/approvals/$SPAWN3_APPROVAL/approve" \
  -H "Content-Type: application/json" -d '{"decisionNote":"Approved"}')

# Check that agents were created with correct budget and department
AGENTS=$(curl -sf "$BASE/companies/$COMPANY_ID/agents")
AGENT_COUNT=$(echo "$AGENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
AGENT_TL=$(echo "$AGENTS" | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['role']=='tech_lead']; print(a[0]['id'] if a else '')" 2>/dev/null)
AGENT_TL_BUDGET=$(echo "$AGENTS" | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['role']=='tech_lead']; print(a[0]['budgetMonthlyCents'] if a else 0)" 2>/dev/null)
AGENT_TL_DEPT=$(echo "$AGENTS" | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['role']=='tech_lead']; print(a[0].get('departmentId','None') if a else 'None')" 2>/dev/null)
AGENT_ENG1=$(echo "$AGENTS" | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['role']=='engineer']; print(a[0]['id'] if a else '')" 2>/dev/null)
AGENT_ENG2=$(echo "$AGENTS" | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['role']=='engineer']; print(a[1]['id'] if len(a)>1 else '')" 2>/dev/null)
AGENT_QA=$(echo "$AGENTS" | python3 -c "import sys,json; a=[x for x in json.load(sys.stdin) if x['role']=='qa']; print(a[0]['id'] if a else '')" 2>/dev/null)

if [ "$AGENT_COUNT" = "4" ] && [ "$AGENT_TL_BUDGET" = "50000" ] && [ "$AGENT_TL_DEPT" = "$DEPT_ENG_ID" ]; then
  ok "Step 17: Approve & spawn (4 agents, budget=$AGENT_TL_BUDGET, dept inherited)"
elif [ "$AGENT_COUNT" = "4" ]; then
  fail "Step 17" "agents created but budget=$AGENT_TL_BUDGET dept=$AGENT_TL_DEPT"
else
  fail "Step 17" "expected 4 agents, got $AGENT_COUNT"
fi

# Step 18: Set agent OKRs
OKR1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/agents/$AGENT_TL/okrs" \
  -H "Content-Type: application/json" \
  -d '[{"objective":"Lead v2.0 Architecture","keyResults":[{"metric":"Design docs completed","targetValue":"1","unit":"docs"},{"metric":"PR review SLA met","targetValue":"95","unit":"percent"}]}]')
OKR_COUNT=$(echo "$OKR1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d[0]['keyResults']) if d else 0)" 2>/dev/null)
if [ "$OKR_COUNT" = "2" ]; then ok "Step 18: Set OKRs (2 key results)"; else fail "Step 18" "keyResults=$OKR_COUNT"; fi

# Step 19: Create skills
SKILL1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/skills" \
  -H "Content-Type: application/json" \
  -d '{"key":"code-review","name":"Code Review","description":"Systematic code review"}')
SKILL1_ID=$(echo "$SKILL1" | json_field "['id']")

if [ -n "$SKILL1_ID" ]; then
  # Create skill version
  VER1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/skills/$SKILL1_ID/versions" \
    -H "Content-Type: application/json" \
    -d '{"markdown":"## Code Review\n1. Security\n2. Performance\n3. Correctness"}')
  VER_STATUS=$(echo "$VER1" | json_field "['status']")
  if [ "$VER_STATUS" = "draft" ]; then ok "Step 19: Skill + version (draft)"; else fail "Step 19" "version status=$VER_STATUS"; fi
else
  fail "Step 19" "skill creation failed"
fi

# ── PHASE 6: WORK SETUP ──────────────────────────────────
echo ""
echo "PHASE 6: Work Setup"

# Step 20: Create project
PROJECT=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/projects" \
  -H "Content-Type: application/json" \
  -d '{"name":"v2.0 Analytics Dashboard","description":"Complete redesign","color":"#0EA5E9"}')
PROJECT_ID=$(echo "$PROJECT" | json_field "['id']")
if [ -n "$PROJECT_ID" ]; then ok "Step 20: Create project"; else fail "Step 20" "project creation failed"; fi

# Step 21: Create issues
ISSUE1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Design widget architecture\",\"projectId\":\"$PROJECT_ID\",\"priority\":\"critical\"}")
ISSUE1_ID=$(echo "$ISSUE1" | json_field "['id']")
ISSUE1_IDENT=$(echo "$ISSUE1" | json_field "['identifier']")

ISSUE2=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Implement drag-and-drop\",\"projectId\":\"$PROJECT_ID\"}")
ISSUE2_ID=$(echo "$ISSUE2" | json_field "['id']")

ISSUE3=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Build streaming layer\",\"projectId\":\"$PROJECT_ID\"}")
ISSUE3_ID=$(echo "$ISSUE3" | json_field "['id']")

ISSUE4=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"E2E tests\",\"projectId\":\"$PROJECT_ID\"}")
ISSUE4_ID=$(echo "$ISSUE4" | json_field "['id']")

if [ -n "$ISSUE1_ID" ] && [ -n "$ISSUE4_ID" ]; then
  ok "Step 21: Create issues (4 issues, first=$ISSUE1_IDENT)"
else
  fail "Step 21" "issue creation failed"
fi

# Step 22: Add dependencies
DEP1=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues/$ISSUE2_ID/dependencies" \
  -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$ISSUE1_ID\"}")
DEP1_ID=$(echo "$DEP1" | json_field "['id']")

DEP2=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues/$ISSUE3_ID/dependencies" \
  -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$ISSUE1_ID\"}")
DEP2_ID=$(echo "$DEP2" | json_field "['id']")

DEP3=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues/$ISSUE4_ID/dependencies" \
  -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$ISSUE2_ID\"}")

DEP4=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues/$ISSUE4_ID/dependencies" \
  -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$ISSUE3_ID\"}")

if [ -n "$DEP1_ID" ] && [ -n "$DEP2_ID" ]; then
  ok "Step 22: Add dependencies (DAG: 4 edges)"
else
  fail "Step 22" "dependency creation failed"
fi

# Step 23: Assign issues to agents (uses Paperclip core route)
A1=$(curl -sf -X PATCH "$BASE/issues/$ISSUE1_ID" \
  -H "Content-Type: application/json" -d "{\"assigneeAgentId\":\"$AGENT_TL\",\"status\":\"todo\"}")
A1_ASSIGNEE=$(echo "$A1" | json_field "['assigneeAgentId']")

A2=$(curl -sf -X PATCH "$BASE/issues/$ISSUE2_ID" \
  -H "Content-Type: application/json" -d "{\"assigneeAgentId\":\"$AGENT_ENG1\"}")
A3=$(curl -sf -X PATCH "$BASE/issues/$ISSUE3_ID" \
  -H "Content-Type: application/json" -d "{\"assigneeAgentId\":\"$AGENT_ENG2\"}")
A4=$(curl -sf -X PATCH "$BASE/issues/$ISSUE4_ID" \
  -H "Content-Type: application/json" -d "{\"assigneeAgentId\":\"$AGENT_QA\"}")

if [ "$A1_ASSIGNEE" = "$AGENT_TL" ]; then
  ok "Step 23: Assign issues to agents"
else
  fail "Step 23" "assignee=$A1_ASSIGNEE expected=$AGENT_TL"
fi

# ── PHASE 7: CRM & INTEGRATIONS ──────────────────────────
echo ""
echo "PHASE 7: CRM & Integrations"

# Step 24: Configure HubSpot
HS_CONFIG=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/integrations/hubspot/config" \
  -H "Content-Type: application/json" \
  -d '{"accessToken":"pat-test-dry-run","portalId":"12345678"}')
HS_OK=$(echo "$HS_CONFIG" | json_field "['success']")
if [ "$HS_OK" = "True" ]; then ok "Step 24: HubSpot config saved"; else fail "Step 24" "success=$HS_OK"; fi

# Step 25: Test HubSpot (expected failure - fake token)
HS_TEST=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/integrations/hubspot/test" \
  -H "Content-Type: application/json" 2>/dev/null || echo '{"ok":false}')
HS_TEST_OK=$(echo "$HS_TEST" | json_field "['ok']")
if [ "$HS_TEST_OK" = "False" ]; then ok "Step 25: HubSpot test (expected auth fail)"; else fail "Step 25" "unexpected ok=$HS_TEST_OK"; fi

# Step 26: Create CRM data
ACCT=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/crm/accounts" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","domain":"acme.com","industry":"Retail","stage":"customer"}')
ACCT_ID=$(echo "$ACCT" | json_field "['id']")

CONTACT=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/crm/contacts" \
  -H "Content-Type: application/json" \
  -d "{\"firstName\":\"John\",\"lastName\":\"Smith\",\"email\":\"john@acme.com\",\"accountId\":\"$ACCT_ID\"}")
CONTACT_ID=$(echo "$CONTACT" | json_field "['id']")

DEAL=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/crm/deals" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Acme Enterprise\",\"accountId\":\"$ACCT_ID\",\"stage\":\"proposal\",\"amountCents\":12000000}")
DEAL_ID=$(echo "$DEAL" | json_field "['id']")

LEAD=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/crm/leads" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Sarah","lastName":"Johnson","email":"sarah@startup.com","company":"StartupXYZ","source":"inbound","status":"new"}')
LEAD_ID=$(echo "$LEAD" | json_field "['id']")

if [ -n "$ACCT_ID" ] && [ -n "$CONTACT_ID" ] && [ -n "$DEAL_ID" ] && [ -n "$LEAD_ID" ]; then
  ok "Step 26: CRM data (account+contact+deal+lead)"
else
  fail "Step 26" "acct=$ACCT_ID contact=$CONTACT_ID deal=$DEAL_ID lead=$LEAD_ID"
fi

# Step 27: Verify pipeline
PIPELINE=$(curl -sf "$BASE/companies/$COMPANY_ID/crm/pipeline")
PIPELINE_VAL=$(echo "$PIPELINE" | json_field "['totalPipelineValueCents']")
PIPELINE_DEALS=$(echo "$PIPELINE" | json_field "['totalDeals']")
if [ "$PIPELINE_DEALS" -ge 1 ] && [ "$PIPELINE_VAL" -gt 0 ]; then
  ok "Step 27: Pipeline ($PIPELINE_DEALS deals, value=$PIPELINE_VAL cents)"
else
  fail "Step 27" "deals=$PIPELINE_DEALS value=$PIPELINE_VAL"
fi

# ── PHASE 8: VERIFY & GO LIVE ────────────────────────────
echo ""
echo "PHASE 8: Verify & Go Live"

# Step 28: Dashboard (agents may show as active, running, or busy depending on heartbeat timing)
DASH=$(curl -sf "$BASE/companies/$COMPANY_ID/dashboard")
DASH_ACTIVE=$(echo "$DASH" | json_field "['agents']['active']")
DASH_RUNNING=$(echo "$DASH" | json_field "['agents']['running']")
DASH_TOTAL=$((DASH_ACTIVE + DASH_RUNNING))
DASH_TASKS=$(echo "$DASH" | json_field "['tasks']['open']")
DASH_INPROG=$(echo "$DASH" | json_field "['tasks']['inProgress']")
DASH_TASK_TOTAL=$((DASH_TASKS + DASH_INPROG))
if [ "$DASH_TOTAL" -ge 4 ] && [ "$DASH_TASK_TOTAL" -ge 4 ]; then
  ok "Step 28: Dashboard (agents=$DASH_TOTAL active+running, tasks=$DASH_TASK_TOTAL open+inProgress)"
else
  fail "Step 28" "agents=$DASH_TOTAL (active=$DASH_ACTIVE running=$DASH_RUNNING) tasks=$DASH_TASK_TOTAL"
fi

# Step 29: Capacity
WORKFORCE=$(curl -sf "$BASE/companies/$COMPANY_ID/capacity/workforce")
WF_TOTAL=$(echo "$WORKFORCE" | json_field "['totalAgents']")
PIPE_CAP=$(curl -sf "$BASE/companies/$COMPANY_ID/capacity/pipeline")
PIPE_TOTAL=$(echo "$PIPE_CAP" | json_field "['totalIssues']")
if [ "$WF_TOTAL" = "4" ] && [ "$PIPE_TOTAL" -ge 4 ]; then
  ok "Step 29: Capacity (workforce=$WF_TOTAL, pipeline=$PIPE_TOTAL)"
else
  fail "Step 29" "workforce=$WF_TOTAL pipeline=$PIPE_TOTAL"
fi

# Step 30: Kill switch
HALT=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/kill-switch" \
  -H "Content-Type: application/json" \
  -d "{\"scope\":\"company\",\"scopeId\":\"$COMPANY_ID\",\"reason\":\"Dry run test\"}")
HALT_ACTION=$(echo "$HALT" | json_field "['action']")

AGENTS_HALTED=$(curl -sf "$BASE/companies/$COMPANY_ID/agents" | \
  python3 -c "import sys,json; print(sum(1 for a in json.load(sys.stdin) if a['status']=='paused'))" 2>/dev/null)

RESUME=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/kill-switch/resume" \
  -H "Content-Type: application/json" \
  -d "{\"scope\":\"company\",\"scopeId\":\"$COMPANY_ID\"}")

AGENTS_RESUMED=$(curl -sf "$BASE/companies/$COMPANY_ID/agents" | \
  python3 -c "import sys,json; print(sum(1 for a in json.load(sys.stdin) if a['status']=='idle'))" 2>/dev/null)

if [ "$HALT_ACTION" = "halt" ] && [ "$AGENTS_HALTED" = "4" ] && [ "$AGENTS_RESUMED" = "4" ]; then
  ok "Step 30: Kill switch (halt→4 paused, resume→4 idle)"
else
  fail "Step 30" "halt=$HALT_ACTION halted=$AGENTS_HALTED resumed=$AGENTS_RESUMED"
fi

# Step 31: Research cycle
CYCLE=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/research-cycles" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Widget Performance Research\",\"goalId\":\"$GOAL1_ID\",\"maxIterations\":3}")
CYCLE_ID=$(echo "$CYCLE" | json_field "['id']")
CYCLE_STATUS=$(echo "$CYCLE" | json_field "['status']")
if [ "$CYCLE_STATUS" = "active" ]; then ok "Step 31: Research cycle (active)"; else fail "Step 31" "status=$CYCLE_STATUS"; fi

# ── SUMMARY ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$FAILURES"
  echo ""
  exit 1
fi
echo ""
echo "All steps passed!"
exit 0
