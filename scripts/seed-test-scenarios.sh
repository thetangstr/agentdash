#!/bin/bash
set -e
BASE="http://localhost:3100/api"
PY='import json,sys; print(json.load(sys.stdin)["id"])'
PY2='import json,sys; d=json.load(sys.stdin); print(d.get("spawnRequest",d).get("id",""))'
PYA='import json,sys; d=json.load(sys.stdin); print(d.get("approval",{}).get("id",""))'

echo "=========================================="
echo "  AgentDash Test Scenario Seeder"
echo "=========================================="
echo ""

# ============================================
# COMPANY 1: NovaTech AI — SaaS Engineering
# ============================================
echo ">>> Creating Company 1: NovaTech AI"
C1=$(curl -s -X POST "$BASE/companies" -H "Content-Type: application/json" \
  -d '{"name":"NovaTech AI","description":"AI-powered analytics SaaS platform","issuePrefix":"NT"}' | python3 -c "$PY")
echo "  Company: $C1"

echo "  Creating department..."
curl -s -X POST "$BASE/companies/$C1/departments" -H "Content-Type: application/json" \
  -d '{"name":"Engineering","description":"Core product engineering"}' > /dev/null

echo "  Creating templates..."
curl -s -X POST "$BASE/companies/$C1/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"tech-lead","name":"Tech Lead","role":"cto","adapterType":"claude_local","authorityLevel":"leader","taskClassification":"deterministic","budgetMonthlyCents":10000,"skillKeys":["paperclip"],"okrs":[{"objective":"Deliver v2.0 platform","keyResults":[{"metric":"api_endpoints","target":20,"unit":"count"},{"metric":"test_coverage","target":90,"unit":"percent"}]}]}' > /dev/null

curl -s -X POST "$BASE/companies/$C1/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"backend-engineer","name":"Backend Engineer","role":"engineer","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":5000,"skillKeys":["paperclip"]}' > /dev/null

curl -s -X POST "$BASE/companies/$C1/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"frontend-engineer","name":"Frontend Engineer","role":"engineer","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"deterministic","budgetMonthlyCents":5000,"skillKeys":["paperclip"]}' > /dev/null

curl -s -X POST "$BASE/companies/$C1/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"qa-engineer","name":"QA Engineer","role":"qa","adapterType":"claude_local","authorityLevel":"specialist","taskClassification":"deterministic","budgetMonthlyCents":3000,"skillKeys":["paperclip"]}' > /dev/null

echo "  Spawning agents..."
# Tech Lead
SR1=$(curl -s -X POST "$BASE/companies/$C1/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"tech-lead","quantity":1,"reason":"Technical leadership for v2.0"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR1/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

# Backend Engineers x2
SR2=$(curl -s -X POST "$BASE/companies/$C1/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"backend-engineer","quantity":2,"reason":"API migration work"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR2/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

# Frontend Engineer x1
SR3=$(curl -s -X POST "$BASE/companies/$C1/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"frontend-engineer","quantity":1,"reason":"Dashboard rebuild"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR3/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

# QA Engineer x1
SR4=$(curl -s -X POST "$BASE/companies/$C1/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"qa-engineer","quantity":1,"reason":"Quality assurance"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR4/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

echo "  Creating goals..."
G1=$(curl -s -X POST "$BASE/companies/$C1/goals" -H "Content-Type: application/json" \
  -d '{"title":"Launch Platform v2.0 by Q2 2026","level":"company","status":"active"}' | python3 -c "$PY")
G2=$(curl -s -X POST "$BASE/companies/$C1/goals" -H "Content-Type: application/json" \
  -d "{\"title\":\"Complete API migration\",\"level\":\"team\",\"parentId\":\"$G1\",\"status\":\"active\"}" | python3 -c "$PY")
G3=$(curl -s -X POST "$BASE/companies/$C1/goals" -H "Content-Type: application/json" \
  -d "{\"title\":\"Ship new analytics dashboard\",\"level\":\"team\",\"parentId\":\"$G1\",\"status\":\"active\"}" | python3 -c "$PY")

echo "  Creating project..."
P1=$(curl -s -X POST "$BASE/companies/$C1/projects" -H "Content-Type: application/json" \
  -d "{\"name\":\"Platform v2.0\",\"description\":\"Next generation analytics platform\",\"status\":\"in_progress\",\"goalId\":\"$G1\"}" | python3 -c "$PY")

echo "  Creating issues with dependencies..."
I1=$(curl -s -X POST "$BASE/companies/$C1/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Design new REST API schema\",\"description\":\"Define endpoints, request/response formats, auth flow for v2 API\",\"status\":\"todo\",\"priority\":\"critical\",\"projectId\":\"$P1\",\"goalId\":\"$G2\"}" | python3 -c "$PY")
I2=$(curl -s -X POST "$BASE/companies/$C1/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Implement authentication endpoints\",\"description\":\"OAuth2, JWT tokens, refresh flow\",\"status\":\"blocked\",\"priority\":\"high\",\"projectId\":\"$P1\",\"goalId\":\"$G2\"}" | python3 -c "$PY")
I3=$(curl -s -X POST "$BASE/companies/$C1/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Implement data query endpoints\",\"description\":\"Analytics data API with filtering, aggregation, export\",\"status\":\"blocked\",\"priority\":\"high\",\"projectId\":\"$P1\",\"goalId\":\"$G2\"}" | python3 -c "$PY")
I4=$(curl -s -X POST "$BASE/companies/$C1/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Build dashboard components\",\"description\":\"Charts, tables, filters for the new analytics dashboard\",\"status\":\"blocked\",\"priority\":\"high\",\"projectId\":\"$P1\",\"goalId\":\"$G3\"}" | python3 -c "$PY")
I5=$(curl -s -X POST "$BASE/companies/$C1/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Integration test suite\",\"description\":\"End-to-end tests for all v2 API endpoints\",\"status\":\"blocked\",\"priority\":\"medium\",\"projectId\":\"$P1\"}" | python3 -c "$PY")
I6=$(curl -s -X POST "$BASE/companies/$C1/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Performance and load testing\",\"description\":\"Benchmark API under load, optimize bottlenecks\",\"status\":\"todo\",\"priority\":\"medium\",\"projectId\":\"$P1\"}" | python3 -c "$PY")

echo "  Adding dependencies..."
curl -s -X POST "$BASE/companies/$C1/issues/$I2/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$I1\"}" > /dev/null
curl -s -X POST "$BASE/companies/$C1/issues/$I3/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$I1\"}" > /dev/null
curl -s -X POST "$BASE/companies/$C1/issues/$I4/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$I2\"}" > /dev/null
curl -s -X POST "$BASE/companies/$C1/issues/$I4/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$I3\"}" > /dev/null
curl -s -X POST "$BASE/companies/$C1/issues/$I5/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$I4\"}" > /dev/null

echo "  Creating security policy..."
curl -s -X POST "$BASE/companies/$C1/security-policies" -H "Content-Type: application/json" \
  -d '{"name":"Production deploy gate","policyType":"action_limit","targetType":"company","rules":[{"action":"deploy_prod","requiresApproval":true}],"effect":"deny","priority":10}' > /dev/null

echo "  NovaTech AI ready!"
echo ""

# ============================================
# COMPANY 2: GrowthStack — E-Commerce Growth
# ============================================
echo ">>> Creating Company 2: GrowthStack"
C2=$(curl -s -X POST "$BASE/companies" -H "Content-Type: application/json" \
  -d '{"name":"GrowthStack","description":"AI-driven e-commerce growth platform","issuePrefix":"GS"}' | python3 -c "$PY")
echo "  Company: $C2"

echo "  Creating department..."
curl -s -X POST "$BASE/companies/$C2/departments" -H "Content-Type: application/json" \
  -d '{"name":"Growth","description":"Growth marketing and analytics"}' > /dev/null

echo "  Creating templates..."
curl -s -X POST "$BASE/companies/$C2/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"growth-lead","name":"Growth Lead","role":"cmo","adapterType":"claude_local","authorityLevel":"leader","taskClassification":"stochastic","budgetMonthlyCents":8000,"okrs":[{"objective":"Reach 50K monthly visitors","keyResults":[{"metric":"monthly_visitors","target":50000,"unit":"count"},{"metric":"conversion_rate","target":3.5,"unit":"percent"}]}]}' > /dev/null

curl -s -X POST "$BASE/companies/$C2/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"content-strategist","name":"Content Strategist","role":"general","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"stochastic","budgetMonthlyCents":4000}' > /dev/null

curl -s -X POST "$BASE/companies/$C2/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"data-analyst","name":"Data Analyst","role":"researcher","adapterType":"claude_local","authorityLevel":"specialist","taskClassification":"deterministic","budgetMonthlyCents":5000}' > /dev/null

curl -s -X POST "$BASE/companies/$C2/agent-templates" -H "Content-Type: application/json" \
  -d '{"slug":"seo-engineer","name":"SEO Engineer","role":"engineer","adapterType":"claude_local","authorityLevel":"executor","taskClassification":"stochastic","budgetMonthlyCents":4000}' > /dev/null

echo "  Spawning agents..."
SR5=$(curl -s -X POST "$BASE/companies/$C2/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"growth-lead","quantity":1,"reason":"Growth strategy leadership"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR5/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

SR6=$(curl -s -X POST "$BASE/companies/$C2/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"content-strategist","quantity":2,"reason":"Content pipeline"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR6/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

SR7=$(curl -s -X POST "$BASE/companies/$C2/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"data-analyst","quantity":1,"reason":"Analytics and measurement"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR7/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

SR8=$(curl -s -X POST "$BASE/companies/$C2/spawn-requests" -H "Content-Type: application/json" \
  -d '{"templateSlug":"seo-engineer","quantity":1,"reason":"Technical SEO"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$SR8/approve" -H "Content-Type: application/json" -d '{}' > /dev/null

echo "  Creating goals..."
G4=$(curl -s -X POST "$BASE/companies/$C2/goals" -H "Content-Type: application/json" \
  -d '{"title":"Reach 50K monthly visitors by Q3 2026","level":"company","status":"active"}' | python3 -c "$PY")
G5=$(curl -s -X POST "$BASE/companies/$C2/goals" -H "Content-Type: application/json" \
  -d "{\"title\":\"Increase organic traffic by 40%\",\"level\":\"team\",\"parentId\":\"$G4\",\"status\":\"active\"}" | python3 -c "$PY")
G6=$(curl -s -X POST "$BASE/companies/$C2/goals" -H "Content-Type: application/json" \
  -d "{\"title\":\"Launch content marketing pipeline\",\"level\":\"team\",\"parentId\":\"$G4\",\"status\":\"active\"}" | python3 -c "$PY")

echo "  Creating project..."
P2=$(curl -s -X POST "$BASE/companies/$C2/projects" -H "Content-Type: application/json" \
  -d "{\"name\":\"Q2 Growth Sprint\",\"description\":\"Aggressive growth push for Q2\",\"status\":\"in_progress\",\"goalId\":\"$G4\"}" | python3 -c "$PY")

echo "  Creating issues with dependencies..."
J1=$(curl -s -X POST "$BASE/companies/$C2/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Keyword research and SEO strategy\",\"description\":\"Identify high-value keywords, analyze competitors, build content strategy\",\"status\":\"todo\",\"priority\":\"critical\",\"projectId\":\"$P2\",\"goalId\":\"$G5\"}" | python3 -c "$PY")
J2=$(curl -s -X POST "$BASE/companies/$C2/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Create content calendar\",\"description\":\"Plan 3 months of blog posts, social content, email campaigns\",\"status\":\"blocked\",\"priority\":\"high\",\"projectId\":\"$P2\",\"goalId\":\"$G6\"}" | python3 -c "$PY")
J3=$(curl -s -X POST "$BASE/companies/$C2/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Build SEO analytics dashboard\",\"description\":\"Real-time dashboard for tracking organic traffic, rankings, conversions\",\"status\":\"todo\",\"priority\":\"high\",\"projectId\":\"$P2\",\"goalId\":\"$G5\"}" | python3 -c "$PY")
J4=$(curl -s -X POST "$BASE/companies/$C2/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Write 10 pillar blog posts\",\"description\":\"Long-form SEO-optimized content targeting identified keywords\",\"status\":\"blocked\",\"priority\":\"high\",\"projectId\":\"$P2\",\"goalId\":\"$G6\"}" | python3 -c "$PY")
J5=$(curl -s -X POST "$BASE/companies/$C2/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"Set up conversion tracking\",\"description\":\"Google Analytics, PostHog events, funnel visualization\",\"status\":\"todo\",\"priority\":\"medium\",\"projectId\":\"$P2\"}" | python3 -c "$PY")
J6=$(curl -s -X POST "$BASE/companies/$C2/issues" -H "Content-Type: application/json" \
  -d "{\"title\":\"A/B test landing pages\",\"description\":\"Test 3 landing page variants for conversion optimization\",\"status\":\"blocked\",\"priority\":\"medium\",\"projectId\":\"$P2\"}" | python3 -c "$PY")

echo "  Adding dependencies..."
curl -s -X POST "$BASE/companies/$C2/issues/$J2/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$J1\"}" > /dev/null
curl -s -X POST "$BASE/companies/$C2/issues/$J4/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$J2\"}" > /dev/null
curl -s -X POST "$BASE/companies/$C2/issues/$J6/dependencies" -H "Content-Type: application/json" -d "{\"blockedByIssueId\":\"$J5\"}" > /dev/null

echo "  Creating research cycle..."
curl -s -X POST "$BASE/companies/$C2/research-cycles" -H "Content-Type: application/json" \
  -d "{\"goalId\":\"$G4\",\"title\":\"Growth Channel Discovery\",\"description\":\"Test different acquisition channels to find highest ROI path to 50K visitors\",\"maxIterations\":5}" > /dev/null

echo "  Creating security policy..."
curl -s -X POST "$BASE/companies/$C2/security-policies" -H "Content-Type: application/json" \
  -d '{"name":"Content approval gate","policyType":"action_limit","targetType":"company","rules":[{"action":"publish_content","requiresApproval":true}],"effect":"deny","priority":10}' > /dev/null

echo "  GrowthStack ready!"
echo ""

echo "=========================================="
echo "  Seeding complete!"
echo ""
echo "  Company 1: NovaTech AI ($C1)"
echo "    - 5 agents (1 Tech Lead, 2 Backend, 1 Frontend, 1 QA)"
echo "    - 3 goals, 1 project, 6 issues with dependency DAG"
echo "    - 4 templates, 1 security policy"
echo ""
echo "  Company 2: GrowthStack ($C2)"
echo "    - 5 agents (1 Growth Lead, 2 Content, 1 Data, 1 SEO)"
echo "    - 3 goals, 1 project, 6 issues with dependencies"
echo "    - 4 templates, 1 research cycle, 1 security policy"
echo ""
echo "  Open http://localhost:3100 to see the dashboard"
echo "=========================================="
