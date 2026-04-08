#!/bin/bash
set -e
BASE="http://localhost:3100/api"
PY='import json,sys; print(json.load(sys.stdin)["id"])'

echo "=========================================="
echo "  MKthink Pipeline Demo Seeder"
echo "=========================================="
echo ""

# ============================================
# COMPANY: MKthink — Architecture & Design
# ============================================
echo ">>> Creating Company: MKthink"
COMPANY=$(curl -s -X POST "$BASE/companies" -H "Content-Type: application/json" \
  -d '{"name":"MKthink","description":"Architecture, planning, and design firm — AI-augmented project delivery","issuePrefix":"MK"}' | python3 -c "$PY")
echo "  Company: $COMPANY"

echo "  Creating department..."
curl -s -X POST "$BASE/companies/$COMPANY/departments" -H "Content-Type: application/json" \
  -d '{"name":"Business Development","description":"RFP response and client acquisition"}' > /dev/null

echo "  Creating agent templates..."
curl -s -X POST "$BASE/companies/$COMPANY/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"bd-lead","name":"BD Lead","role":"cmo","adapterType":"claude_local","authorityLevel":"leader","taskClassification":"stochastic","budgetMonthlyCents":12000,"okrs":[{"objective":"Win 5 new RFPs this quarter","keyResults":[{"metric":"rfps_submitted","target":15,"unit":"count"},{"metric":"win_rate","target":33,"unit":"percent"}]}]}' > /dev/null

curl -s -X POST "$BASE/companies/$COMPANY/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"research-analyst","name":"Research Analyst","role":"researcher","adapterType":"claude_local","authorityLevel":"specialist","taskClassification":"deterministic","budgetMonthlyCents":6000}' > /dev/null

curl -s -X POST "$BASE/companies/$COMPANY/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"proposal-writer","name":"Proposal Writer","role":"general","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"stochastic","budgetMonthlyCents":8000}' > /dev/null

curl -s -X POST "$BASE/companies/$COMPANY/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"project-coordinator","name":"Project Coordinator","role":"general","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":5000}' > /dev/null

echo "  Spawning agents..."
SR1=$(curl -s -X POST "$BASE/companies/$COMPANY/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"bd-lead","quantity":1,"reason":"Lead RFP pipeline and business development"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR1/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

SR2=$(curl -s -X POST "$BASE/companies/$COMPANY/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"research-analyst","quantity":2,"reason":"RFP research and competitive analysis"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR2/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

SR3=$(curl -s -X POST "$BASE/companies/$COMPANY/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"proposal-writer","quantity":1,"reason":"Draft and refine RFP proposals"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR3/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

SR4=$(curl -s -X POST "$BASE/companies/$COMPANY/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"project-coordinator","quantity":1,"reason":"Track RFP submissions and deadlines"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR4/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

echo "  Creating goals..."
G1=$(curl -s -X POST "$BASE/companies/$COMPANY/goals" -H "Content-Type: application/json" \
  -d '{"title":"Win 5 new project RFPs by Q3 2026","level":"company","status":"active"}' | python3 -c "$PY")
G2=$(curl -s -X POST "$BASE/companies/$COMPANY/goals" -H "Content-Type: application/json" \
  -d "{\"title\":\"Automate RFP discovery and response\",\"level\":\"team\",\"parentId\":\"$G1\",\"status\":\"active\"}" | python3 -c "$PY")

echo "  Creating project..."
P1=$(curl -s -X POST "$BASE/companies/$COMPANY/projects" -H "Content-Type: application/json" \
  -d "{\"name\":\"RFP Pipeline Automation\",\"description\":\"AI-powered RFP discovery, evaluation, and response generation\",\"status\":\"in_progress\",\"goalId\":\"$G1\"}" | python3 -c "$PY")

# ============================================
# PIPELINE 1: RFP Response (canonical demo)
# ============================================
echo ""
echo ">>> Creating Pipeline 1: RFP Response"
PIPE1=$(curl -s -X POST "$BASE/companies/$COMPANY/pipelines" -H "Content-Type: application/json" \
  -d '{
  "name": "RFP Response Pipeline",
  "description": "End-to-end RFP discovery, evaluation, and proposal generation with human review gates",
  "executionMode": "sync",
  "defaults": {
    "stageTimeoutMinutes": 30,
    "hitlTimeoutHours": 48,
    "maxSelfHealRetries": 3,
    "budgetCapUsd": 25.00
  },
  "stages": [
    {
      "id": "scrape-rfps",
      "name": "Scrape RFPs",
      "type": "agent",
      "scopedInstruction": "Search public RFP sources (SAM.gov, state procurement portals, BidSync) for new architecture and design postings matching MKthink'\''s profile. Return structured list with title, deadline, requirements, estimated budget, and source URL.",
      "timeoutMinutes": 15
    },
    {
      "id": "compare-context",
      "name": "Compare with Proprietary Context",
      "type": "agent",
      "scopedInstruction": "Compare each RFP against MKthink'\''s past projects, team capabilities, and certifications. Add match_score (0-1), relevant_experience array, and gap_analysis fields to each RFP.",
      "stateMapping": {"rfps": "data.rfps"}
    },
    {
      "id": "rank-match",
      "name": "Rank & Match RFPs",
      "type": "agent",
      "scopedInstruction": "Rank RFPs by match_score weighted with deadline urgency and estimated value. Select top 3 candidates with rationale for each. Output ranked_rfps array.",
      "stateMapping": {"scored_rfps": "data.scored_rfps"}
    },
    {
      "id": "hitl-select",
      "name": "Select RFP to Pursue",
      "type": "hitl_gate",
      "scopedInstruction": "Present ranked RFPs to the BD team for selection.",
      "hitlInstructions": "Review the top 3 ranked RFPs below. Select which ones MKthink should pursue. Consider team availability, strategic fit, and win probability.",
      "hitlTimeoutHours": 24
    },
    {
      "id": "research-domain",
      "name": "Research Domain & Competition",
      "type": "agent",
      "scopedInstruction": "Research the selected RFP domain: past winners, evaluation criteria patterns, client priorities, and competitive landscape. Compile a research brief for the proposal writer.",
      "stateMapping": {"selected_rfp": "data.selected_rfp"},
      "timeoutMinutes": 20
    },
    {
      "id": "draft-proposal",
      "name": "Draft Proposal",
      "type": "agent",
      "scopedInstruction": "Draft a compelling RFP response incorporating MKthink'\''s strengths, past work, competitive positioning, and the research brief. Structure per RFP requirements. Include executive summary, technical approach, team qualifications, timeline, and budget.",
      "stateMapping": {"selected_rfp": "data.selected_rfp", "research_brief": "data.research_brief"},
      "timeoutMinutes": 45
    },
    {
      "id": "merge-research-draft",
      "name": "Merge Research & Draft",
      "type": "merge",
      "scopedInstruction": "Combine research findings and draft proposal into a single review package.",
      "mergeStrategy": "all"
    },
    {
      "id": "hitl-review",
      "name": "Review Proposal",
      "type": "hitl_gate",
      "scopedInstruction": "Present the draft proposal for human review and approval.",
      "hitlInstructions": "Review the draft RFP response below. You can: approve to finalize and submit, reject with revision notes to send back for editing, or reject to abandon this RFP.",
      "hitlTimeoutHours": 48
    }
  ],
  "edges": [
    {"id": "e1", "fromStageId": "scrape-rfps", "toStageId": "compare-context"},
    {"id": "e2", "fromStageId": "compare-context", "toStageId": "rank-match"},
    {"id": "e3", "fromStageId": "rank-match", "toStageId": "hitl-select"},
    {"id": "e4", "fromStageId": "hitl-select", "toStageId": "research-domain"},
    {"id": "e5", "fromStageId": "hitl-select", "toStageId": "draft-proposal"},
    {"id": "e6", "fromStageId": "research-domain", "toStageId": "merge-research-draft"},
    {"id": "e7", "fromStageId": "draft-proposal", "toStageId": "merge-research-draft"},
    {"id": "e8", "fromStageId": "merge-research-draft", "toStageId": "hitl-review"}
  ]
}' | python3 -c "$PY")
echo "  Pipeline: $PIPE1"

echo "  Activating pipeline..."
curl -s -X PATCH "$BASE/companies/$COMPANY/pipelines/$PIPE1" -H "Content-Type: application/json" \
  -d '{"status": "active"}' > /dev/null

# ============================================
# PIPELINE 2: Client Onboarding (simpler DAG)
# ============================================
echo ""
echo ">>> Creating Pipeline 2: Client Onboarding"
PIPE2=$(curl -s -X POST "$BASE/companies/$COMPANY/pipelines" -H "Content-Type: application/json" \
  -d '{
  "name": "Client Onboarding",
  "description": "Automated new client setup: intake, document collection, kickoff preparation",
  "executionMode": "sync",
  "defaults": {
    "stageTimeoutMinutes": 20,
    "hitlTimeoutHours": 72,
    "maxSelfHealRetries": 2
  },
  "stages": [
    {
      "id": "intake",
      "name": "Client Intake",
      "type": "agent",
      "scopedInstruction": "Process new client information: extract key contacts, project scope, timeline, budget, and special requirements from the signed contract and intake form."
    },
    {
      "id": "doc-collection",
      "name": "Document Collection",
      "type": "agent",
      "scopedInstruction": "Generate checklist of required documents based on project type. Send collection requests and track responses.",
      "stateMapping": {"client_info": "data.client_info"}
    },
    {
      "id": "team-assignment",
      "name": "Team Assignment",
      "type": "agent",
      "scopedInstruction": "Match project requirements to available team members based on skills, capacity, and past experience. Propose team composition.",
      "stateMapping": {"client_info": "data.client_info", "project_scope": "data.project_scope"}
    },
    {
      "id": "hitl-approve-team",
      "name": "Approve Team",
      "type": "hitl_gate",
      "scopedInstruction": "Present proposed team for manager approval.",
      "hitlInstructions": "Review the proposed team assignment. Approve or adjust team members based on current workload and client preferences."
    },
    {
      "id": "kickoff-prep",
      "name": "Prepare Kickoff",
      "type": "agent",
      "scopedInstruction": "Create kickoff meeting agenda, project charter draft, and initial milestone schedule based on approved team and project scope.",
      "stateMapping": {"team": "data.approved_team", "client_info": "data.client_info"}
    }
  ],
  "edges": [
    {"id": "e1", "fromStageId": "intake", "toStageId": "doc-collection"},
    {"id": "e2", "fromStageId": "intake", "toStageId": "team-assignment"},
    {"id": "e3", "fromStageId": "doc-collection", "toStageId": "hitl-approve-team"},
    {"id": "e4", "fromStageId": "team-assignment", "toStageId": "hitl-approve-team"},
    {"id": "e5", "fromStageId": "hitl-approve-team", "toStageId": "kickoff-prep"}
  ]
}' | python3 -c "$PY")
echo "  Pipeline: $PIPE2"

echo "  Activating pipeline..."
curl -s -X PATCH "$BASE/companies/$COMPANY/pipelines/$PIPE2" -H "Content-Type: application/json" \
  -d '{"status": "active"}' > /dev/null

# ============================================
# PIPELINE 3: Site Assessment (conditional branching)
# ============================================
echo ""
echo ">>> Creating Pipeline 3: Site Assessment"
PIPE3=$(curl -s -X POST "$BASE/companies/$COMPANY/pipelines" -H "Content-Type: application/json" \
  -d '{
  "name": "Site Assessment Workflow",
  "description": "Automated site analysis with conditional paths for different building types",
  "executionMode": "sync",
  "defaults": {
    "stageTimeoutMinutes": 25,
    "hitlTimeoutHours": 48,
    "maxSelfHealRetries": 2
  },
  "stages": [
    {
      "id": "site-data",
      "name": "Gather Site Data",
      "type": "agent",
      "scopedInstruction": "Collect site data from public records, satellite imagery, and provided documents. Extract: lot size, zoning, existing structures, environmental constraints, utilities."
    },
    {
      "id": "zoning-analysis",
      "name": "Zoning & Compliance",
      "type": "agent",
      "scopedInstruction": "Analyze zoning requirements, setback rules, height restrictions, parking ratios, and ADA compliance requirements for the target use.",
      "stateMapping": {"site": "data.site_data"}
    },
    {
      "id": "env-review",
      "name": "Environmental Review",
      "type": "agent",
      "scopedInstruction": "Assess environmental factors: flood zones, soil conditions, protected species, contamination history. Flag any CEQA/NEPA triggers.",
      "stateMapping": {"site": "data.site_data"}
    },
    {
      "id": "merge-analysis",
      "name": "Merge Analyses",
      "type": "merge",
      "scopedInstruction": "Combine zoning and environmental analyses into unified site assessment.",
      "mergeStrategy": "all"
    },
    {
      "id": "feasibility",
      "name": "Feasibility Report",
      "type": "agent",
      "scopedInstruction": "Generate feasibility report combining all analyses. Include go/no-go recommendation with confidence score, risk factors, estimated timeline, and budget range.",
      "stateMapping": {"zoning": "data.zoning", "environmental": "data.environmental"}
    },
    {
      "id": "hitl-decision",
      "name": "Review Feasibility",
      "type": "hitl_gate",
      "scopedInstruction": "Present feasibility report for partner review.",
      "hitlInstructions": "Review the site feasibility report. Approve to proceed with detailed design, or reject with notes on concerns."
    }
  ],
  "edges": [
    {"id": "e1", "fromStageId": "site-data", "toStageId": "zoning-analysis"},
    {"id": "e2", "fromStageId": "site-data", "toStageId": "env-review"},
    {"id": "e3", "fromStageId": "zoning-analysis", "toStageId": "merge-analysis"},
    {"id": "e4", "fromStageId": "env-review", "toStageId": "merge-analysis"},
    {"id": "e5", "fromStageId": "merge-analysis", "toStageId": "feasibility"},
    {"id": "e6", "fromStageId": "feasibility", "toStageId": "hitl-decision"}
  ]
}' | python3 -c "$PY")
echo "  Pipeline: $PIPE3"

echo "  Activating pipeline..."
curl -s -X PATCH "$BASE/companies/$COMPANY/pipelines/$PIPE3" -H "Content-Type: application/json" \
  -d '{"status": "active"}' > /dev/null

# ============================================
# Issues for context
# ============================================
echo ""
echo "  Creating issues..."
set +e
I1=$(curl -s -X POST "$BASE/companies/$COMPANY/issues" -H "Content-Type: application/json" \
  -d '{"title":"Set up automated RFP monitoring","description":"Configure agents to monitor SAM.gov, state portals, and BidSync for relevant RFPs","status":"todo","priority":"critical"}' | python3 -c "$PY")
echo "  Issue 1: $I1"
I2=$(curl -s -X POST "$BASE/companies/$COMPANY/issues" -H "Content-Type: application/json" \
  -d '{"title":"Build proprietary context knowledge base","description":"Index MKthink past projects, team bios, certifications for RFP matching","status":"todo","priority":"high"}' | python3 -c "$PY")
echo "  Issue 2: $I2"
I3=$(curl -s -X POST "$BASE/companies/$COMPANY/issues" -H "Content-Type: application/json" \
  -d '{"title":"Calibrate RFP scoring model","description":"Tune match_score weights based on historical win/loss data","status":"blocked","priority":"high"}' | python3 -c "$PY")
echo "  Issue 3: $I3"

if [ -n "$I2" ] && [ -n "$I3" ]; then
  curl -s -X POST "$BASE/companies/$COMPANY/issues/$I3/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$I2\"}" > /dev/null
fi
set -e

echo ""
echo "=========================================="
echo "  MKthink Demo Ready!"
echo ""
echo "  Company: MKthink ($COMPANY)"
echo "    - 5 agents (1 BD Lead, 2 Research, 1 Writer, 1 Coordinator)"
echo "    - 2 goals, 1 project, 3 issues"
echo ""
echo "  Pipelines:"
echo "    1. RFP Response Pipeline ($PIPE1)"
echo "       8 stages: scrape → compare → rank → HITL select → research + draft (fan-out) → merge → HITL review"
echo "    2. Client Onboarding ($PIPE2)"
echo "       5 stages: intake → docs + team (fan-out) → HITL approve → kickoff"
echo "    3. Site Assessment ($PIPE3)"
echo "       6 stages: gather → zoning + env (fan-out) → merge → feasibility → HITL review"
echo ""
echo "  Open http://localhost:3100 → select MKthink → Pipelines"
echo "=========================================="
