# AgentDash Deployment SOP

## Target: 50-Person Company with Claude Enterprise Subscription

**Scenario:** Mid-size company (50 employees), managers have Claude Enterprise seats. Deploy AgentDash to orchestrate AI agents that augment the existing workforce.

---

## Phase 0: Pre-Engagement (Week -1)

### Discovery Call Checklist
- [ ] Company size, departments, reporting structure
- [ ] Current tools: CRM (HubSpot?), project management (Jira/Linear?), comms (Slack/Teams?)
- [ ] Claude Enterprise subscription details: how many seats, which roles
- [ ] What work do they want agents to do? (engineering, support, marketing, sales, ops)
- [ ] Current pain points: what takes too long, what falls through cracks
- [ ] Budget expectations for agent operations (monthly LLM token spend)
- [ ] IT/security requirements: where can we deploy, data residency, SSO needs
- [ ] Who will be the Board Operator (primary human overseer)?

### Deliverables
- Deployment architecture diagram
- Agent team proposal (roles, count, estimated monthly cost)
- Timeline estimate (typically 2-3 weeks to production)

---

## Phase 1: Infrastructure Setup (Day 1-2)

### Option A: On-Premise / Bare Metal
```bash
# 1. Clone AgentDash
git clone <agentdash-repo> && cd agentdash

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env:
#   DATABASE_URL=postgresql://user:pass@localhost:5432/agentdash
#   PAPERCLIP_DEPLOYMENT_MODE=authenticated
#   PAPERCLIP_DEPLOYMENT_EXPOSURE=private
#   PORT=3100

# 4. Run migrations
pnpm db:migrate

# 5. Start
pnpm dev  # or: node server/dist/index.js for production
```

### Option B: Docker (Recommended)
```bash
docker compose up -d
# AgentDash available at http://localhost:3100
# Embedded PostgreSQL auto-configured
```

### Option C: Cloud VM (AWS/GCP/Azure)
```bash
# 1. Provision a VM (t3.medium or equivalent, 4GB RAM minimum)
# 2. Install Node.js 20+, pnpm, git
# 3. Follow Option A steps
# 4. Set up reverse proxy (nginx/caddy) for HTTPS
# 5. Configure firewall: only 443 inbound
```

### Verify
```bash
curl http://localhost:3100/api/health
# Should return: {"status":"ok","deploymentMode":"authenticated",...}
```

### Bootstrap First Admin
```bash
pnpm agentdash auth bootstrap-ceo
# Generates a one-time invite URL → give to the Board Operator
```

---

## Phase 2: Company Configuration (Day 2-3)

### 2.1 Board Operator Onboarding
1. Board Operator opens invite URL → creates account
2. Navigate to `/setup` (Onboarding Wizard)
3. **Discovery:** Paste company description, link to wiki/docs
4. **Scope:** Choose operating mode:
   - 50-person company → likely "department" mode (start with 1-2 departments)
   - Recommended: start with Engineering or Growth, expand later
5. **Goals:** Define 1 company goal + 2-3 department goals
6. **Access:** Configure the Board Operator as primary overseer

### 2.2 Department Setup
```
Example for a 50-person SaaS company:

Engineering (20 people)
├── Product Engineering (12)
├── Platform/Infra (5)
└── QA (3)

Growth (10 people)
├── Marketing (5)
├── Sales (3)
└── Customer Success (2)

Operations (8 people)
├── Finance (3)
├── HR (2)
└── IT (3)

Leadership (5 people)
└── CEO, CTO, VP Growth, VP Ops, Head of Product

Other (7 people)
└── Design, Legal, etc.
```

Create departments via dashboard: `/capacity` → Add Department

### 2.3 Agent Templates
Create templates for each agent role the company needs:

| Template | Role | Adapter | Classification | Monthly Budget |
|----------|------|---------|---------------|---------------|
| Tech Lead | cto | claude_local | deterministic | $150 |
| Backend Engineer | engineer | claude_local | deterministic | $100 |
| Frontend Engineer | engineer | claude_local | deterministic | $100 |
| QA Engineer | qa | claude_local | deterministic | $75 |
| Content Writer | general | claude_local | stochastic | $80 |
| Growth Analyst | researcher | claude_local | stochastic | $100 |
| Support Agent | general | claude_local | deterministic | $60 |

**Note on Claude Enterprise:** Since managers have Claude Enterprise seats, agents use `claude_local` adapter which connects to Claude via the CLI. Each agent gets its own API key allocation — the company's Claude Enterprise billing handles the token costs centrally.

### 2.4 Security Policies
Configure before any agents go live:

1. **Production deploy gate:** All deploy actions require Board Operator approval
2. **Data boundary:** Agents cannot access customer PII outside of support contexts
3. **Rate limit:** Max 100 API calls per agent per hour
4. **Blast radius:** Max 50 files changed per task, max $50 spend per task

Create via dashboard: `/security` → Add Policy

### 2.5 CRM Integration (if HubSpot)
1. Create a HubSpot Private App (Settings → Integrations → Private Apps)
2. Grant scopes: contacts, companies, deals, timeline
3. Configure in AgentDash: install `agentdash.integration-hubspot` plugin
4. Enter access token and portal ID
5. Run initial sync (automatic on plugin activation)

---

## Phase 3: Agent Deployment (Day 3-5)

### 3.1 Start Small
**Do NOT deploy all agents at once.** Start with 2-3 agents in one department.

Recommended first deployment:
```
Engineering Department:
  1x Tech Lead (leader, oversees the engineering agents)
  2x Backend Engineer (executors, do the coding work)
```

### 3.2 Spawn Agents
1. Go to `/templates` → select "Tech Lead" → Spawn (quantity: 1)
2. Board Operator approves the spawn request
3. Agent appears in `/agents` with status "idle"
4. Repeat for Backend Engineers (quantity: 2)

### 3.3 Create First Project
1. Create project: "Week 1 Pilot"
2. Create 3-5 well-defined tasks with clear acceptance criteria
3. Add task dependencies if applicable
4. Assign tasks to agents

### 3.4 First Heartbeat
- Agents pick up tasks via scheduled heartbeats (default: every 30 seconds)
- Monitor via dashboard: team pulse shows running/idle status
- Check agent detail pages for run logs and output

### 3.5 Human Review Loop
- Tech Lead agent reviews Backend Engineer output
- Board Operator reviews anything flagged for approval
- Iterate on agent instructions/skills based on output quality

---

## Phase 4: Expansion (Week 2-3)

### 4.1 Add More Agents
Once the pilot agents are producing quality work:
- Spawn additional engineers (via Agent Factory)
- Add QA agents to review engineering output
- Set up task dependency chains: design → build → test → review

### 4.2 Add Growth Department
- Create Growth templates (Content Writer, Growth Analyst)
- Spawn growth agents
- Link to CRM: agents can read customer data for context
- Set up research cycles for growth experiments

### 4.3 Set Up Routines
- Daily: agents check for new assigned tasks
- Weekly: growth agents review metrics and suggest experiments
- Monthly: auto-generate cost/ROI reports

### 4.4 Integrate Communication
- Connect Slack (when plugin is active): agents post updates to channels
- Connect GitHub: agents create PRs, participate in code review

---

## Phase 5: Steady State Operations

### Daily Operations (Board Operator)
1. **Morning check-in** (60 seconds): Open dashboard, scan "Needs Attention"
2. **Approve/reject** pending items (spawn requests, budget overrides)
3. **Review escalations** from agent leaders

### Weekly Operations
1. Review capacity dashboard: are agents underutilized or overloaded?
2. Review budget: burn rate, ROI per project
3. Review agent OKRs: are key results progressing?
4. Adjust agent count if needed (spawn more or retire idle agents)

### Monthly Operations
1. Review security policy audit logs
2. Review skill effectiveness (analytics)
3. Update agent templates based on learnings
4. Update OKRs for next period

---

## Rollback Plan

If something goes wrong at any stage:

1. **Kill Switch** — instantly halt all agents: `/security` → HALT ALL AGENTS
2. **Per-agent pause** — pause individual problematic agents from agent detail page
3. **Full rollback** — stop AgentDash, data persists in PostgreSQL, no work is lost
4. **Data export** — company data can be exported as ZIP from `/company/export`

---

## Cost Estimation for 50-Person Company

### Starting Configuration (Pilot)
| Item | Count | Monthly Cost |
|------|-------|-------------|
| Tech Lead agent | 1 | ~$150 (Claude tokens) |
| Backend Engineer agents | 2 | ~$200 |
| AgentDash Pro license | 1 | $500 (up to 10 agents) |
| **Total pilot** | **3 agents** | **~$850/mo** |

### Full Deployment (after expansion)
| Item | Count | Monthly Cost |
|------|-------|-------------|
| Engineering agents | 8 | ~$800 |
| Growth agents | 4 | ~$400 |
| Support agents | 3 | ~$200 |
| AgentDash Pro license | 1 | $2,000 (up to 50 agents) |
| **Total full** | **15 agents** | **~$3,400/mo** |

### ROI Target
If 15 agents replace work equivalent to 3-5 human FTEs (at ~$8K/mo each), the monthly savings are $24K-$40K against $3.4K spend — **7-12x ROI**.

---

## Support Escalation Path

1. **Agent issues** → Board Operator resolves via dashboard
2. **Platform issues** → Contact AgentDash support (support@agentdash.ai)
3. **Claude API issues** → Anthropic Enterprise support (via existing subscription)
4. **Infrastructure issues** → Company's IT team (their servers, their network)

---

## Checklist Summary

### Pre-Deploy
- [ ] Discovery call completed
- [ ] Infrastructure provisioned
- [ ] Claude Enterprise API access confirmed
- [ ] Board Operator identified

### Day 1-2
- [ ] AgentDash installed and running
- [ ] First admin bootstrapped
- [ ] Health check passing

### Day 2-3
- [ ] Company created with goals
- [ ] Departments configured
- [ ] Agent templates created
- [ ] Security policies in place
- [ ] CRM connected (if applicable)

### Day 3-5
- [ ] Pilot agents spawned (2-3 agents)
- [ ] First project created with tasks
- [ ] First heartbeat executed successfully
- [ ] Board Operator comfortable with dashboard

### Week 2-3
- [ ] Agent count expanded to target
- [ ] All departments onboarded
- [ ] Routines set up
- [ ] Communication integrations active
- [ ] Board Operator operating independently
