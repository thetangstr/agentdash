# Hypothetical Company Onboarding Scenario

Generated on March 30, 2026.

## Scenario

This is a realistic example of how a company onboards to AgentDash.

It is hypothetical, but it is intentionally specific.

## Company Profile

### Company

`Northstar Trail Co.`

### What the company does

Northstar Trail Co. is a premium direct-to-consumer outdoor gear brand.

Its core competence is:

- designing durable hiking packs, travel gear, and accessories
- running high-conversion ecommerce launches around seasonal product drops
- building strong customer loyalty through quality and fast post-purchase support

### Company size

- annual revenue: `~$85M`
- employees: `210`
- ecommerce orders: `~110,000 per month` during normal months
- peak season volume: `~180,000 orders per month`
- support team: `34` agents, `4` team leads, `1` support ops manager

### Current stack

- ecommerce platform: `Shopify Plus`
- helpdesk: `Zendesk`
- returns platform: `Loop`
- warehouse / 3PL feeds: `Extensiv + carrier APIs`
- payments: `Stripe`
- subscriptions: `Recharge`
- fraud / dispute signals: `Riskified`
- analytics: `Looker`
- CRM: `HubSpot` (sales + marketing hub)

## Why the company comes to AgentDash

Northstar is not looking for a chatbot.

The support org is already tired of AI demos that answer easy FAQs but fail on real operational work.

What is actually hurting them:

- damaged-delivery claims spike after major launches
- address changes and order-edit requests arrive after fulfillment has started
- late shipments create WISMO tickets and replacement demands
- refund abuse is increasing
- AI tools can draft responses, but they cannot reconcile system state or safely take action

The COO and VP of CX are aligned on one point:

- the company does not need "better support copy"
- it needs an `autonomous post-purchase operations layer`

## Pain Points

### Operational pain

- `18,000 to 24,000` support tickets per month
- `28%` of tickets are post-purchase exceptions, not simple FAQs
- `21%` of tier-2 tickets require agents to touch `3+ systems`
- average handle time on damaged-delivery cases: `14 minutes`
- average handle time on chargeback-prevention cases: `19 minutes`

### Economic pain

- annual support payroll on post-purchase operations: `~$1.9M`
- annual refund and replacement leakage from avoidable manual decisions: estimated `~$850K`
- chargeback losses and operational handling cost: `~$420K` annually
- peak-season overtime and temp staffing: `~$280K` annually

### Leadership pain

- support leadership cannot scale headcount every holiday season
- finance does not trust blanket automation on money-moving actions
- ops leadership is tired of fragmented tools that each solve one narrow slice
- the CEO wants margin protection without hurting brand trust

## Why AgentDash wins this deal

AgentDash is positioned as:

- not a chatbot
- not an "AI teammate"
- not a broad contact-center replacement

It is positioned as:

- a governed agent system for post-purchase resolution workflows

That framing matters because it matches how Northstar experiences the pain:

- the problem is not conversation volume
- the problem is operational exception handling across fragmented systems

AgentDash's specific advantages for this deal:

- **Agent Factory** — template-based agent deployment with approval gates, not ad-hoc AI spinning up
- **Security policies** — encode refund thresholds ($40 auto, $120 escalate) as enforceable rules, not suggestions
- **Kill switch** — instant company-wide halt if anything goes wrong during rollout
- **Budget management** — hard monthly limits per agent, per department. No surprise bills.
- **CRM pipeline** — HubSpot sync means agent activity flows into the existing sales/success motion
- **BYOT** — Northstar keeps their own API keys, data stays on their infrastructure

## The Specific Use Cases Northstar Wants First

### Phase 1 use cases

- damaged delivery resolution
- lost package / late shipment resolution
- address correction before cutoff
- low-risk replacement or refund decisions
- return-status and WISMO deflection

### Phase 2 use cases

- subscription billing exceptions
- dispute-prevention workflows
- VIP customer recovery paths
- high-risk abuse triage for human review

### Out of scope initially

- pre-purchase product education
- broad catalog Q&A
- loyalty save offers with open-ended discretion
- social-media support

## The Agents Northstar Wants

These map to AgentDash agent templates with specific roles, budgets, skills, and department assignments.

### 1. Ticket Intake Agent

- **AgentDash role:** `general`
- **Department:** Customer Operations
- **Budget:** $150/month
- **Skills:** `ticket-classification`, `urgency-detection`

Purpose:

- classify incoming cases
- identify order, customer, and urgency
- separate FAQ noise from operational exceptions

### 2. Order Context Agent

- **AgentDash role:** `engineer`
- **Department:** Customer Operations
- **Budget:** $200/month
- **Skills:** `data-aggregation`, `system-reconciliation`

Purpose:

- pull order, shipment, carrier, warehouse, payment, and return state
- create one clean operational truth for the case

### 3. Policy and Entitlement Agent

- **AgentDash role:** `pm`
- **Department:** Customer Operations
- **Budget:** $150/month
- **Skills:** `policy-evaluation`, `entitlement-check`

Purpose:

- apply refund, replacement, shipping, and loyalty rules
- determine what actions are allowed and under what thresholds

### 4. Refund / Replacement Agent

- **AgentDash role:** `general`
- **Department:** Customer Operations
- **Budget:** $250/month
- **Skills:** `refund-execution`, `replacement-routing`

Purpose:

- execute low-risk refunds, replacements, or reships
- stage higher-risk actions for approval

### 5. Fraud and Abuse Agent

- **AgentDash role:** `researcher`
- **Department:** Risk & Compliance
- **Budget:** $200/month
- **Skills:** `fraud-detection`, `abuse-pattern-analysis`

Purpose:

- detect suspicious patterns
- escalate first-party fraud or repeat refund abuse

### 6. Customer Communication Agent

- **AgentDash role:** `general`
- **Department:** Customer Operations
- **Budget:** $150/month
- **Skills:** `case-communication`, `escalation-drafting`

Purpose:

- send accurate case updates and resolution notices
- draft escalations for humans on sensitive cases

### 7. QA and Outcome Agent

- **AgentDash role:** `qa`
- **Department:** Customer Operations
- **Budget:** $100/month
- **Skills:** `action-logging`, `outcome-measurement`, `policy-tuning`

Purpose:

- log every action
- measure rollback rate, bad-resolution rate, and CSAT impact
- create a learning loop for policy tuning

## AgentDash Security Policies

These encode the human approval rules as enforceable security policies in the platform.

### Refund Threshold Policy

- **Type:** `action_limit`
- **Target:** company-wide
- **Rules:**
  - refunds under `$40` for low-risk customers: autonomous
  - refunds `$40–$500`: require CX team lead approval
  - refunds above `$500`: require finance controller approval

### Replacement Threshold Policy

- **Type:** `action_limit`
- **Target:** company-wide
- **Rules:**
  - replacements under `$120` when stock + policy + risk align: autonomous
  - replacements above `$120`: require CX team lead approval

### Blast Radius Policy

- **Type:** `blast_radius`
- **Target:** company-wide
- **Rules:**
  - max `50` autonomous refund actions per hour
  - max `$5,000` total autonomous refund value per hour
  - breach triggers kill switch and escalation to Support Ops Manager

### Data Boundary Policy

- **Type:** `data_boundary`
- **Target:** all agents
- **Rules:**
  - agents can read customer PII but cannot export or log raw PII
  - payment card data is never accessible to agents
  - all agent actions are audit-logged

### Escalation Path Policy

- **Type:** `resource_access`
- **Target:** Fraud and Abuse Agent
- **Rules:**
  - VIP or influencer orders: always escalate
  - legal threats: always escalate to legal queue
  - any open chargeback: route to Fraud/Risk Analyst
  - suspected abuse or contradictory system states: halt and escalate

## AgentDash Departments

| Department | Description | Lead |
|---|---|---|
| Customer Operations | Post-purchase support agents: intake, context, policy, refund, comms | Support Ops Manager |
| Risk & Compliance | Fraud detection, abuse triage, dispute prevention | Fraud/Risk Analyst |

## AgentDash Goals

| Goal | Level | Priority | Target |
|---|---|---|---|
| Automate 35% of post-purchase exceptions | Company | Critical | 90 days |
| Reduce damaged-delivery handle time by 55% | Team | High | 60 days |
| Reduce chargeback rate by 20% | Team | High | 90 days |
| Reduce refund leakage by 15% | Company | Medium | 90 days |
| Zero CSAT regression | Company | Critical | Ongoing |

## The Human Requirements

Northstar does not want fully hands-off autonomy on day one.

They want bounded autonomy with clear human ownership.

### Human roles required

These are Board Operators in AgentDash — humans who oversee and approve agent actions.

#### Support Operations Manager

Owns:

- policy configuration
- rollout thresholds
- QA review
- KPI ownership

#### Fraud / Risk Analyst

Owns:

- review of suspicious refund or replacement patterns
- abuse thresholds
- dispute-prevention escalation paths

#### CX Team Leads

Own:

- exception queue review
- approval of high-value or ambiguous cases
- tone review for sensitive customer comms

#### Finance Controller

Owns:

- refund authority thresholds
- reconciliation review
- exposure limits

#### Ecommerce Operations Lead

Owns:

- order-edit windows
- warehouse cutoffs
- coordination with 3PLs and inventory operations

## How Onboarding Actually Happens in AgentDash

### Day 0: Platform setup + intake

**Infrastructure** (30 minutes):

```
agentdash onboard --yes
# → embedded PostgreSQL starts
# → config written to ~/.paperclip/config.json
# → server starts on localhost:3100
```

**Company creation + context ingestion** (1 hour):

The COO or VP of CX pastes Northstar's company description, support workflows, pain points, and policy documents into AgentDash. This is the raw material for the LLM-driven plan.

```
POST /api/companies
  → { name: "Northstar Trail Co.", brandColor: "#2D5F3E" }

POST /api/companies/:id/onboarding/sessions
  → starts onboarding session

POST /api/companies/:id/onboarding/sessions/:sid/sources
  → ingest company overview, support policies, workflow docs

POST /api/companies/:id/onboarding/sessions/:sid/extract
  → LLM extracts: domain, products, team structure, tech stack, pain points
```

**Plan generation** (seconds):

```
POST /api/companies/:id/onboarding/sessions/:sid/generate-plan
  → LLM analyzes context and produces:
    - 2 departments (Customer Operations, Risk & Compliance)
    - 5 security policies (refund threshold, replacement threshold, blast radius, data boundary, escalation)
    - 7 agent templates (Ticket Intake, Order Context, Policy, Refund, Fraud, Comms, QA)
    - 5 goals (automation rate, handle time, chargeback, leakage, CSAT)
    - 2 projects (Phase 1: Damaged Delivery, Phase 1: Address Correction)
```

**Plan review** (30 minutes):

The COO and Support Ops Manager review the generated plan. They can:

- adjust agent budgets
- modify security policy thresholds
- add or remove agents
- edit goals and target dates

```
PATCH /api/companies/:id/onboarding/sessions/:sid/plan
  → edit any section before applying
```

**Plan execution** (seconds):

```
POST /api/companies/:id/onboarding/sessions/:sid/apply-plan
  → creates all entities in dependency order:
    1. departments
    2. security policies
    3. goals
    4. agent templates
    5. spawn requests (pending approval)
    6. projects + issues
```

### Day 0 output

- 2 departments created
- 5 security policies active
- 7 agent templates ready
- 7 spawn requests pending approval
- 5 measurable goals with target dates
- 2 projects with initial issues
- HubSpot integration configured

Total setup time: **~2 hours** from zero to a reviewable, executable plan.

### Week 1: Approval + shadow mode

The Support Ops Manager reviews each spawn request in AgentDash's approval queue. For the Phase 1 pilot, they approve 5 agents:

1. Ticket Intake Agent
2. Order Context Agent
3. Policy and Entitlement Agent
4. Refund / Replacement Agent
5. Customer Communication Agent

The Fraud and QA agents are held back for Week 2.

```
POST /api/approvals/:id/approve
  → agent spawned with template config, budget, department
```

Each approved agent gets:

- OKRs tied to company goals
- Skills from the registry (versioned, reviewed)
- Budget limits enforced by department
- Security policies automatically applied

Shadow mode means agents process tickets but only recommend actions — no autonomous execution yet.

### Week 2: Policy tuning + connector validation

- Connectors verified for Shopify, Zendesk, Loop, Stripe, carrier APIs
- Policy thresholds tuned based on shadow mode results
- Fraud and QA agents approved and spawned
- HubSpot CRM sync verified — agent activity visible in HubSpot

### Week 3: Bounded-live pilot

The Support Ops Manager adjusts agent statuses from shadow to live for approved action classes:

Live autonomous actions:

- damaged-delivery replacements under $120
- address changes before fulfillment cutoff
- WISMO responses with carrier-grounded status
- refunds under $40 for low-risk customers

Human-reviewed actions:

- all fraud-risk cases
- all open-dispute cases
- all high-value replacements

The kill switch is tested:

```
POST /api/companies/:id/kill-switch
  → all 7 agents halt instantly
POST /api/companies/:id/kill-switch/resume
  → all 7 agents resume
```

### Week 4: Measurement + expansion planning

The dashboard shows:

- automation rate per agent
- budget utilization by department
- issue throughput and resolution times
- CRM pipeline impact

OKR progress is tracked per agent:

```
GET /api/companies/:id/agents/:agentId/okrs
  → { objective: "Reduce handle time", keyResults: [{ metric: "avg_minutes", target: "6", current: "7.2" }] }
```

Research cycles are launched to test policy variations:

```
POST /api/companies/:id/research-cycles
  → { title: "Refund threshold optimization", maxIterations: 5 }
```

## Example Ticket During Live Operation

### Customer issue

A customer emails saying:

- the pack arrived damaged
- they need a replacement before a trip next week
- they are unhappy and may dispute the charge

### What the agent pipeline does

1. **Ticket Intake Agent** classifies the case: `damaged_delivery`, urgency `high`
2. **Order Context Agent** pulls order from Shopify, shipment from carrier API, payment from Stripe, return status from Loop — creates unified case context
3. **Policy Agent** checks: order value $94, customer LTV $410, zero prior refunds, stock available, no open dispute — resolution: `replacement` within autonomous threshold
4. **Refund/Replacement Agent** initiates replacement order in Shopify, no return label required
5. **Communication Agent** drafts and sends resolution email to customer

### What the human sees

On a low-risk order:

- nothing; the action executes autonomously
- the action is logged and visible in the AgentDash dashboard

On a borderline order:

- CX team lead sees an approval request in AgentDash
- evidence packet attached:

```
order value:          $94
customer LTV:         $410
prior refunds (12mo): 0
carrier exception:    box damage reported
stock available:      yes
allowed paths:        replacement, refund
recommended path:     replacement
confidence:           0.92
```

- team lead approves or overrides

### What the security policies enforce

- order value $94 < $120 threshold → autonomous replacement allowed
- if order were $150 → approval request automatically created
- if 50th autonomous refund in the hour → blast radius policy triggers kill switch

## What success looks like after 90 days

- `35%` of post-purchase exception tickets resolved without human touch
- `55%` reduction in average handle time on damaged-delivery cases
- `20%` reduction in chargeback rate on delayed-response tickets
- `15%` reduction in avoidable refund leakage
- no material drop in CSAT
- no finance or ops override crisis

## Why this customer would expand

If the pilot works, Northstar will not stop at one workflow.

The expansion path in AgentDash:

- create new agent templates for Phase 2 use cases (subscription billing, dispute prevention, VIP recovery)
- spawn from templates — same approval gate, same security policies, same budget controls
- add new departments (Marketing Operations, Supply Chain)
- connect additional CRM data through HubSpot sync
- launch research cycles to optimize each new workflow

That is the AgentDash thesis in company form:

- start with one painful, bounded workflow
- prove trust and ROI
- then expand horizontally across adjacent exception-heavy operations

## What this scenario teaches us

The best customers for AgentDash are not asking for "AI."

They are asking for:

- fewer manual exception queues
- fewer cross-system decisions made by humans under time pressure
- safer bounded autonomy
- better human escalation when the case is genuinely hard

AgentDash delivers this through:

- **Agent Factory** for governed deployment
- **Security policies** for enforceable thresholds
- **Kill switch** for instant control
- **Budget management** for cost certainty
- **CRM integration** for business visibility
- **Research cycles** for continuous improvement

That is the onboarding story we are designing for.
