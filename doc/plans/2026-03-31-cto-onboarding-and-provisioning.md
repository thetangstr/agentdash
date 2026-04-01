# CTO Onboarding And Provisioning Plan

Date: 2026-03-31
Status: Proposed
Audience: Product, design, engineering, sales, and onboarding

## 1. Goal

Design the onboarding and provisioning model that makes AgentDash compelling to a CTO evaluating the product for real company use.

This plan focuses on:

- the first 30 days of customer experience
- how onboarding should scale from founder-led pilots to repeatable GTM
- what should be auto-provisioned versus configured later
- how onboarding ties directly to monetization

## 2. Important Clarification: What Commercial Provisioning Is

Commercial provisioning is **not** primarily an internal BI/admin tool.

It is the customer-account layer that sits around the product and answers:

- who is the customer org?
- what plan are they on?
- what deployment mode do they use?
- what environments do they have?
- what features and limits are enabled?
- what onboarding state are they in?

Internally, sales/support will use this data too, but the main purpose is customer lifecycle control, not back-office reporting.

Good commercial provisioning should be mostly invisible to the customer.

The customer should feel:

- "I signed up"
- "my workspace is ready"
- "my company is seeded"
- "my trial is active"
- "my deployment is connected"

They should **not** feel:

- "I am inside someone else's revenue ops system"

## 3. Target Buyer

Primary buyer:

- CTO at an SMB or mid-market company
- often still hands-on
- owns security, architecture, integration risk, and platform choices

Secondary buyers/supporters:

- COO / head of ops
- VP Eng
- RevOps or CS ops lead
- security lead

The CTO is usually not buying "AI magic."
They are buying:

- a safer path to operational AI adoption
- a faster path to production value
- governance without building it all themselves
- flexibility on deployment and model/runtime choices

## 4. What The CTO Actually Wants In The First Meeting

The CTO does not want a blank canvas.

They want confidence in five things:

1. **Time to value**
   Can this produce one useful workflow quickly?

2. **Governance**
   Can I see what agents are doing, approve risky actions, and stop bad behavior?

3. **Integration**
   Will this connect to the systems we already run?

4. **Security / deployment flexibility**
   Can we start in a safe way that fits our environment and policies?

5. **Expandability**
   If the first workflow works, can this become a real internal platform?

That means onboarding should be optimized for one sentence:

> "In one session, the CTO should believe AgentDash can safely own one real operational workflow."

## 5. Product Thesis For CTO Onboarding

Do **not** onboard a CTO into "AgentDash the generic control plane."

Onboard them into:

- one department
- one workflow
- one measurable outcome

The right onboarding unit is:

- not "company setup"
- not "hire some agents"
- not "configure adapters"

The right onboarding unit is:

- **launch a governed AI workflow**

Examples:

- Engineering issue triage and delegation
- CRM pipeline hygiene and follow-up
- Customer research digest and escalation
- Security review queue and approval routing
- Internal product/ops request handling

## 6. Three-Layer Onboarding Model

### Layer A. Commercial Provisioning

Purpose:
Create the customer shell around the product.

This layer provisions:

- org/account
- deployment record
- trial or subscription status
- environment
- feature entitlements
- onboarding run state

This should be thin and mostly invisible.

The customer-facing UX should feel like:

1. Create org
2. Choose hosted or self-hosted
3. Confirm trial / contract access
4. Land immediately in guided onboarding

### Layer B. Operational Onboarding

Purpose:
Connect the product to the customer's operating reality.

This layer should gather:

- company name and function
- primary team or department
- target workflow
- source systems to connect
- initial success metric
- deployment/security posture

This is where the CTO should see that the product understands their environment.

### Layer C. Workforce Provisioning

Purpose:
Create the first working company inside AgentDash.

This layer seeds:

- company
- top goal
- starter project
- starter issues
- starter agents
- starter skills
- starter approval policy
- starter budget policy

This should end with a visible first run and a clear next action.

## 6.5. Interaction Model: Wizard First, LLM Optional

The primary onboarding experience should be a **guided wizard**.

An **LLM-assisted onboarding mode** should exist, but only as a helper layered onto the wizard, not as a replacement for it.

### Why The Wizard Must Be Primary

- deterministic and testable
- easier to secure and govern
- easier to measure funnel drop-off
- easier to support for enterprise buyers
- easier to map onto provisioning jobs and templates

The wizard is the canonical source of onboarding state.

### What The LLM Mode Should Do

The LLM should help the user:

- describe their team and workflow in natural language
- import or summarize source material
- recommend a department/workflow template
- prefill structured fields in the wizard
- explain tradeoffs between hosted, self-hosted, and hybrid
- draft a suggested first company/agent/project setup

### What The LLM Mode Should Not Do

It should **not**:

- become the only path through onboarding
- store onboarding state only in freeform chat
- silently skip required governance or deployment questions
- create resources without a final structured confirmation step

### Product Rule

The structured wizard state must always remain the system of record.

The LLM can:

- suggest values
- summarize user input
- generate drafts
- explain choices

But the user should still confirm the structured onboarding answers before provisioning happens.

### Recommended UX

Use one product, not two separate onboarding systems:

- primary: multi-step wizard
- optional: "Talk me through setup" side panel or inline helper
- optional: "Paste docs / describe your workflow" freeform entry
- required: review + confirm generated structured setup before apply

This preserves the magic of natural-language onboarding without turning setup into an opaque chatbot flow.

## 6.6. Hard Constraint: LLM Help Requires A Connected Adapter

This is an important product constraint:

- LLM-assisted onboarding is only available if at least one healthy adapter is connected

That means the wizard cannot depend on AI availability.

### Product Rule

The wizard must be fully functional in a deterministic, non-LLM mode.

The LLM assistant should be:

- available immediately if the instance already has a healthy adapter
- unlocked mid-flow once the user connects and validates an adapter
- completely optional even after it becomes available

### UX Implication

The correct pattern is:

- show the wizard to everyone
- show the AI assistant as `locked` until an adapter is healthy
- explain the unlock clearly:
  - "Connect an adapter to unlock AI-assisted setup"

Once unlocked, the assistant can:

- backfill earlier steps
- summarize imported context
- recommend templates
- draft the initial company/agent/issue setup

But the structured wizard answers remain canonical.

## 7. Canonical CTO Onboarding Flow

### Recommended Wizard Length

Use **5 core steps**.

That is the best tradeoff:

- short enough to finish
- long enough to separate key decisions
- flexible enough to support AI unlock after adapter setup

Do **not** make the launch screen a decorative extra step.
If there is a final review, it should be the fifth step.

If a special deployment-specific check is needed for self-hosted users, treat it as an inline branch or interstitial, not a permanent sixth step for everyone.

### Recommended Step Model

#### Step 1. Outcome

Collect:

- company name
- first department
- first workflow
- success metric

This is where the customer decides what they are trying to launch.

#### Step 2. Runtime

Collect:

- adapter choice
- adapter connection / environment validation

This is the unlock step for AI-assisted onboarding.

If a healthy adapter is present after this step, the UI can enable:

- "Have AI draft the rest"
- "Summarize my docs"
- "Recommend a setup"

#### Step 3. Context

Collect:

- one source system connection
- optional docs / freeform description

This is the best place for LLM help, because by now the adapter should be available.

Without AI, this step still works as:

- choose one system
- optionally paste description or skip

#### Step 4. Guardrails

Collect:

- deployment posture
- approval defaults
- budget defaults
- failure behavior / safety defaults

This is what makes the product feel enterprise-safe instead of toy-like.

#### Step 5. Review And Launch

Show:

- seeded company
- seeded workflow template
- agents to be created
- starter issues/projects
- guardrails to be applied

Then:

- confirm
- provision
- launch first run

The step should end on output, not another summary screen.

### Step 1. Choose Deployment Posture

This should no longer be the literal first screen for every user.

It belongs in the **Guardrails** step unless deployment mode is being chosen earlier in a separate product entry flow.

Prompt:

- hosted
- self-hosted
- hybrid / not sure yet

Why it matters:

- the CTO wants to know the architecture fit immediately
- this changes the downstream setup burden

### Step 2. Choose The First Department

Prompt:

- engineering
- revenue / CRM
- customer success / research
- security / ops

Why it matters:

- prevents generic onboarding
- narrows the workflow and template set

### Step 3. Choose The First Workflow

Examples by department:

- engineering: backlog triage, issue delegation, release readiness
- revenue: lead qualification, deal follow-up, partner tracking
- customer success: call digest, escalation routing, renewal risk notes
- security/ops: review queue, approval routing, incident intake

Why it matters:

- this is the real wedge
- onboarding should end in a job, not a dashboard tour
- the LLM assistant can be especially useful here to translate a freeform description into a recommended template

### Step 4. Connect One System Of Record

Examples:

- GitHub
- Linear
- HubSpot
- Slack

Rule:

- exactly one required integration for first value
- everything else is optional later

Why it matters:

- import-driven onboarding beats rebuild-from-scratch onboarding
- this is a strong place for LLM-assisted source ingestion and recommendation, but the chosen system should still be captured as a structured field

### Step 5. Set Governance Defaults

Default questions:

- who can approve?
- what actions require approval?
- what is the initial budget cap?
- what should happen on error or overspend?

Rule:

- show safe defaults first
- expose advanced settings later

### Step 6. Auto-Provision The First Company

Auto-create:

- company goal
- starter project
- starter issue queue
- one lead agent
- one operator/reviewer policy
- one workflow-specific skill pack

### Step 7. Run One Live Workflow

Success moment:

- customer sees a real run
- sees output
- sees audit trail
- sees approval/cost context

This is the actual activation point.

### Step 8. Show The Expansion Map

After the first workflow:

- add more agents
- connect more systems
- widen approval policy
- invite collaborators
- add second workflow

The message should be:

- "You do not need to redesign your company today."
- "You can expand from one trusted workflow."

## 8. What Should Be Auto-Provisioned

Auto-provision aggressively:

- company skeleton
- first goal/project/issues
- starter agent(s)
- workflow-specific templates
- safe approval defaults
- safe budget defaults
- sample dashboard state if customer data is still sparse

Do **not** require manual setup up front for:

- full org chart
- many agents
- advanced policy matrix
- many integrations
- custom skills authoring
- connector sprawl

The first run should feel opinionated and fast.

## 9. The Right Onboarding Templates

The product should ship opinionated templates for the jobs CTOs can sponsor quickly.

### Template A. Engineering Triage Desk

Outcome:

- turn incoming engineering work into structured issues with ownership and approvals

Why it sells:

- familiar pain
- measurable
- high visibility

### Template B. Revenue Pipeline Operator

Outcome:

- maintain CRM hygiene, follow-up tasks, and partner/deal tracking

Why it sells:

- directly tied to revenue operations
- strong executive visibility

### Template C. Customer Research Desk

Outcome:

- ingest feedback/calls/docs and produce structured summaries, priorities, and tasks

Why it sells:

- high leverage
- easy to show value quickly

### Template D. Security / Approval Queue

Outcome:

- centralize risky actions behind clear routing, policy, and audit trail

Why it sells:

- governance is the differentiator

## 10. Monetization Strategy Tied To Onboarding

The best monetization motion is:

### Stage 1. Paid Pilot

Sell:

- one workflow
- one department
- guided onboarding
- defined success criteria

Why:

- lowers risk for buyer
- creates urgency around time-to-value
- gives services leverage without pretending the product is self-serve before it is

### Stage 2. Annual Platform Subscription

Convert successful pilots into platform contracts based on:

- operator seats
- managed workflow count
- managed agent bands
- premium integrations
- governance/compliance tier

### Stage 3. Usage Add-Ons

Charge usage for:

- hosted execution
- premium research loops
- long retention / storage
- premium connectors or managed services

Do not lead with token markup.
The value is workflow control and governance.

## 11. Most Appealing Value Proposition To A CTO

The most appealing message is:

> "Start with one operational workflow. Put AI to work with governance, approvals, budget controls, and deployment flexibility from day one."

Why this is stronger than "AI agents for your company":

- it is concrete
- it reduces perceived risk
- it gives the CTO a narrow internal champion story
- it preserves optionality on models and deployment

The emotional win is not autonomy.
It is **safe leverage**.

## 12. Metrics That Matter

### Onboarding Metrics

- time from signup/deploy to first connected system
- time to first successful workflow run
- onboarding completion rate
- percentage of customers who reach first run within one session

### Activation Metrics

- first 7-day workflow repeat rate
- number of customer-visible outputs produced
- number of approvals handled
- number of interventions avoided through defaults/automation

### Expansion Metrics

- second workflow launched
- second system connected
- additional collaborators invited
- upgrade from pilot to annual platform

## 13. Product Implications For The Current Repo

The current repo already has useful pieces:

- company creation
- guided onboarding wizard
- company context ingestion
- team suggestion scaffolding
- issue/project/agent seeding
- approval and budget surfaces
- CRM and governance surfaces

But the product still needs a more opinionated CTO-first wrapper:

- template-driven onboarding instead of generic setup
- one-workflow activation path
- clearer deployment posture selection
- stronger import-driven integration step
- explicit success-metric framing
- expansion recommendations after first run
- wizard-first onboarding with optional LLM assistance rather than a standalone chat onboarding flow

## 14. Recommended Next Build Order

1. Redesign onboarding around department + workflow templates
2. Keep the wizard as the canonical onboarding state machine
3. Redesign the wizard into 5 core steps: outcome, runtime, context, guardrails, review/launch
4. Add adapter health detection and AI-assistant locked/unlocked states
5. Add optional LLM-assisted intake that fills wizard fields from freeform input after adapter validation
6. Add one required source-system connection step
7. Seed workflow-specific company/agent/issue defaults
8. End onboarding on a real first run with visible output
9. Add a post-onboarding "expand safely" screen
10. Later, add commercial provisioning objects for org/trial/subscription

## 15. Bottom Line

Commercial provisioning is necessary, but it should mostly disappear into the background.

The real product moment is not:

- "your account is provisioned"

It is:

- "your first governed AI workflow is live, useful, and safe"

That is what the CTO buys.
