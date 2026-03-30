# AgentDash Business Plan

**Prepared for:** First Client Engagement
**Date:** 2026-03-29
**Confidential**

---

## Executive Summary

AgentDash is an AI agent orchestration platform that helps companies deploy, manage, and scale AI agent workforces alongside their human teams. We don't replace people — we give every team AI teammates that handle the repetitive, time-consuming work so humans can focus on decisions, strategy, and relationships.

**Our approach:** Start small, prove value fast, expand with trust. We don't try to automate your whole company on day 1. We find the 2-3 highest-impact pain points, deploy agents to solve them in 2 weeks, and grow from there.

---

## 1. The Problem

Every company has work that:
- Is important but repetitive (data entry, report generation, first-draft content)
- Falls through the cracks because humans are busy (follow-up emails, ticket triage, documentation)
- Could be done 24/7 but only gets done 9-5 (monitoring, customer response, lead qualification)
- Requires coordination that nobody has time to manage (cross-team handoffs, status updates)

AI agents can do this work. But deploying agents is chaotic without orchestration:
- Who assigns work to which agent?
- How do you track what they're doing and spending?
- How do you prevent them from going rogue?
- How do they work alongside humans, not in a separate silo?

AgentDash solves this. It's the management layer between your business and your AI agents.

---

## 2. Who We Serve

### Ideal First Client Profile
- **Company size:** 20-100 employees
- **Industry:** SaaS, professional services, e-commerce, or any knowledge-work company
- **Current AI usage:** Using Claude, ChatGPT, or similar — but manually, not systematically
- **Pain:** Specific teams are overwhelmed with work that AI could handle
- **Decision maker:** CEO/COO/VP Ops who wants to move fast but responsibly
- **CRM:** HubSpot (our first deep integration) or willing to adopt

### Not a fit (yet)
- Companies with zero AI experience (need more education first)
- Heavily regulated industries requiring certified AI (healthcare, finance — future)
- Companies looking for a single chatbot, not an agent workforce

---

## 3. What We Sell

### The Product: AgentDash Platform
Self-hosted on the client's infrastructure (or ours). Includes:
- Agent management dashboard ("morning briefing" for the CEO)
- Agent Factory (spawn agents from templates, scale up/down)
- Task management with dependency chains (auto-delegation)
- Security policies, kill switch, audit trails
- Budget management with forecasting
- CRM integration (HubSpot sync)
- Skills registry (teach agents new capabilities)
- AutoResearch (experiment loops tied to business goals)

### The Service: Managed Onboarding + Ongoing Support
We don't just hand over software. We:
1. Learn the client's business, workflows, and pain points
2. Configure and deploy the first agents
3. Train the Board Operator (the human who oversees agents)
4. Iterate weekly during the pilot
5. Expand to new departments after proving value

---

## 4. Business Model

### Pricing Philosophy
- **Low barrier to start** — the pilot should feel like a no-brainer
- **Pay for value, not seats** — price scales with agent count and impact
- **Transparent** — client always knows what they're paying for
- **The LLM tokens are theirs** — BYOT (bring your own tokens). We charge for orchestration, not AI inference.

### Pricing Structure

#### Pilot Phase (2-4 weeks)
| Item | Cost |
|------|------|
| Setup & configuration | $2,500 one-time |
| Platform license (pilot) | $0 (free during pilot) |
| Weekly check-in calls | Included |
| Up to 5 agents | Included |
| **Total pilot cost** | **$2,500** |

The pilot is intentionally cheap. It's a loss-leader. The goal is to prove value so the client signs a 12-month agreement.

#### Production Phase (post-pilot)

**Platform License (monthly):**
| Tier | Agent Count | Monthly Price |
|------|------------|---------------|
| Starter | Up to 5 agents | $500/mo |
| Growth | Up to 20 agents | $1,500/mo |
| Scale | Up to 50 agents | $3,000/mo |
| Enterprise | Unlimited | $5,000+/mo |

**Managed Services (optional):**
| Service | Price |
|---------|-------|
| Monthly agent optimization & tuning | $1,000/mo |
| Custom skill development | $2,500 per skill |
| New department onboarding | $1,500 per department |
| Priority support (< 4hr response) | $500/mo |
| Quarterly business review | Included with Scale+ |

**What the client also pays (not to us):**
- Claude API tokens: ~$50-200/mo per agent depending on usage
- Infrastructure: their own servers or cloud VM (~$50/mo)

### Annual Contract Value (ACV) Targets
| Scenario | Platform | Services | Client's LLM | Total Annual |
|----------|---------|----------|-------------|-------------|
| Starter (5 agents) | $6,000 | $12,000 | $3,000 | $21,000 |
| Growth (15 agents) | $18,000 | $18,000 | $12,000 | $48,000 |
| Scale (30 agents) | $36,000 | $24,000 | $30,000 | $90,000 |

---

## 5. Go-to-Market: Land and Expand

### The "Start Small" Playbook

**Week 0: Discovery (free)**
- 60-minute call: understand the business, identify top 3 pain points
- Rank pain points by: impact (high/med/low) x ease of automation (easy/medium/hard)
- Select the #1 pain point that is HIGH impact + EASY to automate
- Examples of great first wins:
  - Triage incoming support tickets and draft responses
  - Generate weekly reports from HubSpot data
  - First-draft blog posts or social media content
  - Code review / automated testing
  - Lead research and qualification from inbound

**Week 1-2: Pilot Deploy**
- Deploy AgentDash on their infrastructure (or a cloud VM we manage)
- Configure 2-3 agents for the selected pain point
- Board Operator training (30 minutes — just the dashboard)
- Agents start producing work; human reviews output
- Daily Slack check-ins during week 1

**Week 3-4: Measure & Iterate**
- Measure: hours saved, tasks completed, output quality, cost
- Iterate: tune agent instructions, add/remove skills, adjust
- Demo results to decision maker
- Proposal for production deployment

**Month 2+: Expand**
- Sign production contract
- Add agents for pain point #2 and #3
- Onboard new departments
- Monthly business reviews

### Why This Works
1. **$2,500 is a no-brainer** for any company doing $1M+ revenue
2. **2 weeks is fast enough** to hold attention, slow enough to prove value
3. **Specific pain point** means clear before/after measurement
4. **Human stays in the loop** throughout — builds trust, not fear
5. **Expansion is natural** — "if this worked for support, what about marketing?"

---

## 6. Security & Governance

### What We Promise Clients

**Data sovereignty:**
- AgentDash runs on YOUR infrastructure (or a VM we provision for you)
- Your data never touches our servers
- BYOT: your API keys, your token billing, your control

**Agent governance:**
- Every agent action is logged in a tamper-proof audit trail
- Security policies define what agents can and cannot do
- Kill switch: instantly halt all agents from the dashboard
- Approval gates: sensitive actions require human sign-off
- Budget caps: agents auto-pause when spend limit is reached

**Access control:**
- Board Operator has full control
- Agents have scoped permissions (can only access assigned projects/data)
- CRM data access is read-only by default (write requires explicit policy)
- No agent can create other agents without Board Operator approval

### Security FAQ for the Client

**Q: Can an agent go rogue and do something destructive?**
A: Agents operate within security policies you define. Destructive actions (deploy, delete, publish) require explicit approval. If anything unexpected happens, the kill switch halts everything instantly.

**Q: Who can see our data?**
A: Only you. AgentDash runs on your infrastructure. We have access only during setup/support, and only with your explicit permission.

**Q: What if we want to stop?**
A: Export your data (one click), shut down the server. No lock-in, no data hostage.

**Q: How do agents interact with our CRM?**
A: Through a controlled integration layer. Agents can read customer data for context. Write operations (updating deals, logging activities) are configurable — you decide what agents can modify.

---

## 7. Implementation Plan

### For a 50-Person Company with Claude Enterprise

#### Pre-Engagement (Week -1)
- [ ] Discovery call (60 min)
- [ ] Identify top 3 pain points
- [ ] Select pilot scope
- [ ] Confirm infrastructure (where to deploy)
- [ ] Confirm Claude API access
- [ ] Identify Board Operator

#### Pilot (Week 1-4)

**Week 1: Setup**
| Day | Activity |
|-----|----------|
| Mon | Deploy AgentDash, bootstrap admin, Board Operator creates account |
| Tue | Configure company: goals, departments, security policies |
| Wed | Create agent templates for pilot use case |
| Thu | Spawn 2-3 agents, assign first tasks |
| Fri | Review first agent outputs, iterate on instructions |

**Week 2: Operate**
| Activity | Frequency |
|----------|-----------|
| Agents execute tasks | Continuous (heartbeat) |
| Board Operator morning check-in | Daily (60 seconds) |
| Our team reviews agent output quality | Daily |
| Iterate on agent skills/instructions | As needed |
| Slack check-in with client | Daily (5 min) |

**Week 3: Measure**
- Collect metrics: tasks completed, hours saved, quality score
- Build ROI case: "$X of work done by agents this week"
- Identify improvement areas
- Prepare expansion proposal

**Week 4: Decide**
- Present results to decision maker
- Proposal: production contract + expansion scope
- If yes → move to production
- If needs more time → extend pilot (no additional cost)

#### Production (Month 2+)
- Sign 12-month agreement
- Expand agent count
- Add new departments (1 per month)
- Monthly business reviews
- Quarterly OKR reset

---

## 8. Contract Structure

### Pilot Agreement (LOE / Statement of Work)
- **Duration:** 4 weeks
- **Cost:** $2,500 one-time
- **Includes:** Platform setup, 5 agents, weekly calls, training
- **Deliverable:** ROI report and expansion recommendation
- **Termination:** Either party, any time, no penalty
- **Data:** Client owns all data; export available at any time

### Production Agreement (Annual)
- **Duration:** 12 months, auto-renew
- **Pricing:** Platform license (tiered) + managed services (optional)
- **Payment:** Monthly billing, annual commitment
- **SLA:** 99.9% platform uptime (when self-hosted: client responsible for infrastructure)
- **Termination:** 30 days notice; data export included
- **IP:** Client owns their data, agent configurations, and custom skills
- **Security:** Terms reference our security practices document

### What We DON'T Do (Scope Boundaries)
- We don't build custom software (we configure agents)
- We don't manage their infrastructure (they own their servers)
- We don't guarantee specific business outcomes (we guarantee the platform works)
- We don't provide Claude/LLM tokens (BYOT)

---

## 9. Competitive Positioning

### vs. Salesforce Agentforce
- Salesforce is CRM-first, agents bolted on. We're agent-first, CRM integrated.
- Salesforce requires their ecosystem. We're CRM-agnostic (HubSpot, Salesforce, any).
- Salesforce is expensive ($2/conversation or $175/agent/mo). We're simpler.
- Our advantage: deployment flexibility, open architecture, start-small approach.

### vs. Building It Themselves
- Most companies try to "just use Claude/ChatGPT" manually. It works for 1-2 people.
- At 5+ agents, they need orchestration, governance, budgets, coordination.
- Building this from scratch takes 3-6 months of engineering time.
- We're that 3-6 months of work, ready to deploy in a week.

### vs. Other Agent Platforms (CrewAI, LangChain, etc.)
- Developer tools, not business tools. Require engineering to set up.
- No dashboard, no CRM integration, no budget management.
- We're the "Salesforce of agent orchestration" — turnkey for business operators.

---

## 10. First Client Conversation Guide

### Agenda (60 minutes)
1. **(5 min)** Intros, context
2. **(15 min)** Listen: what's your biggest operational pain right now?
3. **(10 min)** Identify: which of those could AI agents handle?
4. **(10 min)** Demo: show AgentDash dashboard with test data
5. **(10 min)** Propose: "Here's what a 2-week pilot would look like"
6. **(10 min)** Questions, next steps

### Key Messages
- "We start small and prove value fast — just 2-3 agents on your #1 pain point"
- "Your data stays on your infrastructure, you bring your own Claude keys"
- "You're always in control — kill switch, approval gates, budget caps"
- "The pilot is $2,500 and takes 2 weeks. If it doesn't work, you stop."
- "We're not replacing your team — we're giving them AI teammates"

### Objection Handling

**"We're already using Claude/ChatGPT"**
→ "Great — that's exactly who we help. Individual AI use is powerful. AgentDash makes it systematic: assign work, track output, control costs, scale up. It's the difference between one person using a spreadsheet and the whole company using Salesforce."

**"What if the AI makes mistakes?"**
→ "That's why every agent has a human in the loop. During the pilot, a human reviews every output. Over time, you decide what agents can do autonomously vs. what needs approval. The kill switch halts everything instantly."

**"We don't have the budget"**
→ "The pilot is $2,500 — less than one day of a contractor's time. If 3 agents save your team even 10 hours per week, that's $500-$1,000/week in value. We measure the ROI together and you decide if it's worth continuing."

**"Our IT team won't approve this"**
→ "We run on your infrastructure, behind your firewall. No data leaves your network. We support your existing Claude Enterprise subscription. The IT team stays in control."

**"We need to think about it"**
→ "Totally fair. Here's what I'd suggest: let's do a 30-minute technical call with your IT lead next week to answer security questions. If that goes well, we can start the pilot the following Monday. No commitment until you see results."

---

## 11. Financial Projections (Year 1)

### Conservative Scenario: 5 Clients
| Quarter | New Clients | Active Clients | MRR | Revenue |
|---------|------------|---------------|-----|---------|
| Q2 2026 | 2 | 2 | $3,000 | $11,500 |
| Q3 2026 | 2 | 4 | $8,000 | $26,500 |
| Q4 2026 | 1 | 5 | $12,000 | $38,500 |
| **Year 1 Total** | **5** | **5** | | **$76,500** |

*Assumes: avg $1,500/mo platform + $1,000/mo services per client, 2-month ramp*

### Growth Scenario: 12 Clients
| Quarter | New Clients | Active Clients | MRR | Revenue |
|---------|------------|---------------|-----|---------|
| Q2 2026 | 3 | 3 | $5,000 | $17,500 |
| Q3 2026 | 4 | 7 | $14,000 | $47,000 |
| Q4 2026 | 5 | 12 | $28,000 | $89,000 |
| **Year 1 Total** | **12** | **12** | | **$153,500** |

### Cost Structure
| Item | Monthly |
|------|---------|
| Cloud infrastructure (dev/staging) | $200 |
| Claude API (our own usage) | $300 |
| Domain/hosting | $50 |
| **Total fixed costs** | **$550/mo** |

Human costs (your time) not included — assumed founder-operated initially.

### Path to $1M ARR
At $2,500/mo average per client: need 34 clients.
At current growth rate (3-5 new clients/quarter): achievable in 18-24 months.

---

## Appendix: Demo Script

### Preparing the Demo Environment
```bash
# Start AgentDash with test data
cd /Users/Kailor/Documents/townhall
pnpm dev
# In another terminal:
bash scripts/seed-test-scenarios.sh
```

### Demo Flow (10 minutes)
1. Open `http://localhost:3100` → show the morning briefing dashboard
2. Switch companies (NovaTech AI) → show agent team, tasks, goals
3. Go to Templates → show how agent blueprints work
4. Go to Security → demo the kill switch (halt → resume)
5. Go to CRM Pipeline → show deals, leads, partners
6. Go to Capacity → show workforce snapshot
7. "This is what your company looks like when AI agents are working alongside your team"
