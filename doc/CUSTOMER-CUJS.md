# AgentDash Customer CUJs

Status: Canonical customer-user journey and task taxonomy
Date: 2026-03-31
Audience: Product, design, engineering, onboarding, and agent authors

## 1. Purpose

This document is the canonical list of how customer users are expected to use AgentDash.

It answers two questions:

1. What are the critical user journeys for AgentDash customers?
2. What recurring customer tasks must the product support clearly and repeatedly?

This is not a list of internal engineering workflows. It is a list of customer-facing operator workflows for the people running AI agent teams inside AgentDash.

## 2. Sources Reviewed

This document is based on:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `ARCHITECTURE.md`
- `doc/PRD.md`
- current UI surfaces and routes in `ui/src/`
- Linear `AGE` team issue inventory and project list reviewed on 2026-03-31
- local repo issue and plan references using `PAP-*` identifiers

Linear snapshot reviewed:

- Team: `AGE` / AgentDash
- Projects: `AgentDash v1 Launch`, `AgentDash UI Sprint`
- States in use: `Backlog`, `Todo`, `Done`
- Current issue mix heavily favors `epic:crm`, `epic:ux`, `epic:pipelines`, `epic:agents`, `epic:onboarding`, and `epic:governance`

## 3. Users In Scope

### P1. Board Operator

The primary customer user. Usually a founder, CEO, operator, or functional lead responsible for outcomes, oversight, cost, and approvals.

### P2. Department Lead

A secondary customer user. Usually manages one function or project area and directs work through goals, issues, agents, and approvals.

### P3. Human Reviewer / Approver

A customer user acting in governance mode. Reviews hires, strategy, skills, budgets, or other gated actions.

Out of scope:

- external stakeholders interacting indirectly through CRM, Slack, or email
- agents themselves as product users
- internal maintainers/developers working on AgentDash code

## 4. Product Frame

AgentDash is a control plane, not a chatbot and not a generic task manager.

The core customer loop is:

1. Set up a company and operating context
2. Create and organize agents
3. Create goals, projects, and issues
4. Let agents execute through heartbeat-driven work
5. Monitor progress, cost, and incidents
6. Intervene through approvals, comments, reassignments, policies, and kill switches

The product should therefore optimize for:

- visibility
- control
- delegation
- governance
- output review
- cost awareness

## 5. Canonical Customer Tasks

These are the stable top-level jobs customers come to AgentDash to do.

### T1. Stand Up The Company

Create a company, define the top-level goal, configure initial context, and get to first useful agent activity.

### T2. Understand What Is Happening

Open the dashboard/inbox and understand company health, active work, blockers, approvals, and spend quickly.

### T3. Define Work

Create goals, projects, and issues so work is explicit, scoped, assigned, and traceable to company outcomes.

### T4. Build The Team

Create agents directly or from templates, place them in the org, and control who reports to whom.

### T5. Delegate And Launch Work

Assign issues, trigger heartbeats, and let agents begin execution.

### T6. Govern Decisions

Review approvals, revision requests, security boundaries, budget incidents, and escalation points before work proceeds.

### T7. Unblock And Redirect Work

Comment on issues, reassign work, pause agents, update priorities, or intervene when runs fail or tasks stall.

### T8. Manage Capacity And Cost

Review cost, burn, budget incidents, capacity, and workforce size; then adjust budgets or staffing.

### T9. Configure Trust Boundaries

Set policies, define kill switches, manage secrets/access assumptions, and limit blast radius.

### T10. Bring In Business Context

Use CRM/customer context, company docs, imports, and other source-of-truth systems to ground agent work.

### T11. Improve The Workforce

Manage templates, skills, and research loops so the system gets more effective over time.

### T12. Reuse And Port The Company

Import/export company packages, carry forward working setups, and reuse proven teams or templates.

## 6. Canonical CUJs

These CUJs are the canonical customer journeys AgentDash should optimize for. They are ordered by product importance, not implementation ease.

### CUJ-1. Bootstrap A Working Company

Persona: P1

Goal:
Go from zero to a company with a goal, a CEO agent, and an initial issue in one short session.

Primary surfaces:

- `/companies`
- `/setup`
- onboarding wizard

Success criteria:

- customer creates a company without understanding provider plumbing first
- at least one agent exists
- at least one issue exists
- customer reaches a visible "work has started" state

Why canonical:

- this is the first-value moment
- failure here kills adoption

### CUJ-2. Do A 60-Second Morning Scan

Persona: P1

Goal:
Open the dashboard and quickly know whether the company is healthy or needs intervention.

Primary surfaces:

- `/dashboard`
- `/inbox`
- activity and live-run summaries

Success criteria:

- customer sees needs-attention items first
- customer can identify blocked work, approvals, failures, or budget incidents
- customer can decide whether action is required within a minute

Why canonical:

- this is the default recurring behavior for an operator

### CUJ-3. Create A Goal -> Project -> Issue Chain

Persona: P1, P2

Goal:
Turn business intent into explicit work objects with traceable parentage.

Primary surfaces:

- `/goals`
- `/projects`
- `/issues`

Success criteria:

- customer can create goals and projects
- customer can create issues tied to goals/projects
- work stays legible as a hierarchy rather than a loose backlog

Why canonical:

- AgentDash’s control-plane value depends on work being structured, not just chatted about

### CUJ-4. Hire Or Spawn The Right Agents

Persona: P1, P2

Goal:
Add the right agents to the org, either manually or from templates, without losing governance.

Primary surfaces:

- `/agents`
- `/templates`
- `/org`
- `/approvals`

Success criteria:

- customer can create agents or spawn from templates
- reporting structure is visible
- approval-gated hires are reviewable

Why canonical:

- team formation is a core differentiator versus a simple task board

### CUJ-5. Assign Work And Let Agents Run

Persona: P1, P2

Goal:
Give an agent a concrete issue and let execution begin with clear ownership.

Primary surfaces:

- `/issues`
- issue detail
- agent detail

Success criteria:

- customer can assign a single owner
- work moves into active execution cleanly
- customer can tell who is doing what

Why canonical:

- this is the core delegation moment of the product

### CUJ-6. Review Approvals And Escalations

Persona: P1, P3

Goal:
Handle the set of decisions that must stay human-governed.

Primary surfaces:

- `/inbox`
- `/approvals`
- approval detail

Success criteria:

- customer sees pending approvals clearly
- customer can approve, reject, or request revision
- the audit trail is preserved

Why canonical:

- governance is part of the product’s identity, not optional garnish

### CUJ-7. Unblock, Redirect, Or Recover Work

Persona: P1, P2

Goal:
Intervene when work is blocked, poor, stale, misassigned, or failing.

Primary surfaces:

- issue detail and comments
- `/issues`
- `/agents`
- `/activity`

Success criteria:

- customer can comment, reassign, pause, or reprioritize
- the intervention is visible to the system
- progress resumes without hidden state

Why canonical:

- autonomous work without a clear recovery path is operationally unsafe

### CUJ-8. Monitor Budget, Burn, And Capacity

Persona: P1, P2

Goal:
Understand whether the company can afford current behavior and whether the team can meet demand.

Primary surfaces:

- `/costs`
- `/capacity`
- dashboard attention items

Success criteria:

- customer can see spend, budget incidents, and basic burn
- customer can reason about workforce sufficiency
- the system can pause or warn when limits are hit

Why canonical:

- "safe autonomy" requires visibility into cost, not blind automation

### CUJ-9. Set Policies And Use The Kill Switch

Persona: P1

Goal:
Define what agents may do and halt activity immediately when trust is broken.

Primary surfaces:

- `/security`

Success criteria:

- customer can configure policies in human terms
- customer can halt agents quickly
- halted state is obvious and auditable

Why canonical:

- this is the trust boundary for adopting the product in real companies

### CUJ-10. Use CRM And Customer Context To Direct Work

Persona: P1, P2

Goal:
Bring business-system context into the control plane so agents act on real customer and revenue information.

Primary surfaces:

- `/crm`
- onboarding/import context surfaces

Success criteria:

- customer can inspect core pipeline context
- agents and humans can align work to customer/revenue state

Why canonical:

- AgentDash is explicitly positioned between systems of record and systems of execution

### CUJ-11. Improve The System With Skills, Templates, And Research

Persona: P1, P2

Goal:
Make the workforce better over time by upgrading repeatable capabilities.

Primary surfaces:

- `/skills`
- `/templates`
- `/research`

Success criteria:

- customer can review and publish skills
- customer can reuse templates
- customer can run or oversee research/experiment loops

Why canonical:

- long-term product value comes from compound leverage, not one-off setup

### CUJ-12. Port, Import, And Reuse Proven Setups

Persona: P1

Goal:
Reuse successful companies, teams, or configurations across environments and customers.

Primary surfaces:

- `/company/import`
- `/company/export`

Success criteria:

- customer can package and move a company cleanly
- imports preserve the structure people care about

Why canonical:

- reusable AI orgs and templates are part of the product strategy

## 7. Non-Canonical Or Secondary Journeys

These matter, but they should not outrank the core operator loop:

- plugin management as a primary daily job
- low-level runtime diagnostics
- developer worktree workflows
- release/maintainer workflows
- raw transcript inspection as the default top-layer view

These should support the core CUJs, not replace them.

## 8. Canonical Task Taxonomy By Product Area

This taxonomy is intended to drive backlog planning, UI IA, and future Linear issue structure.

### Company Setup

- create company
- describe company
- define top-level goal
- configure onboarding inputs
- select company

### Org And Workforce

- create agent
- spawn agent from template
- assign reporting line
- pause/resume agent
- inspect agent status

### Work Definition

- create goal
- create project
- create issue
- assign issue
- comment on issue
- change issue status
- inspect dependencies/blockers

### Governance

- review approval
- approve
- reject
- request revision
- inspect audit trail

### Execution Oversight

- trigger or observe heartbeat runs
- inspect live work
- inspect failures
- reassign blocked work
- pause unsafe work

### Budget And Capacity

- inspect spend
- inspect budget incident
- adjust budget allocation
- inspect capacity
- inspect forecast

### Security

- create policy
- update policy
- inspect policy evaluation
- halt all agents
- resume halted agents

### Business Context

- inspect CRM pipeline
- inspect deals/leads/accounts
- import company context
- review connected source data

### Workforce Improvement

- create/edit skill
- submit skill for review
- publish skill
- inspect skill analytics
- create/edit template
- run research cycle

### Portability

- export company package
- preview import
- import package into existing or new company

## 9. Implications For Planning

The current PRD has useful CUJs, but it mixes:

- top-tier recurring customer loops
- platform extension surfaces
- future-heavy capabilities

For roadmap and issue planning, use this priority stack:

1. bootstrap company
2. daily dashboard scan
3. define work
4. build team
5. delegate work
6. govern approvals
7. unblock/recover
8. monitor budget/capacity
9. secure with policies/kill switch
10. enrich with CRM context
11. improve with skills/templates/research
12. port/reuse setups

## 10. What The Current Linear Backlog Says

The current `AGE` backlog is useful but skewed toward a subset of the full product.

Observed backlog concentration:

- CRM pages and lifecycle flows
- pipelines and action-proposal UI
- UX/detail surfaces
- some agent/governance improvements

Observed backlog gaps relative to the canonical customer loop:

- fewer explicit issues for the daily board-operator loop
- fewer explicit issues for goal -> project -> issue authoring
- limited explicit backlog around issue assignment, recovery, and unblock workflows
- limited explicit backlog around inbox/approval-as-primary-surface framing
- limited explicit backlog around import/export portability as a customer-facing journey

Interpretation:

The current backlog is not wrong, but it is feature-surface heavy. It over-represents extension areas like CRM and pipeline UI compared with the core operator control-plane loop the product docs describe.

Planning recommendation:

- keep the active CRM/pipeline work
- but rebalance upcoming issues toward dashboard, work definition, approvals, intervention, and budget/capacity loops
- treat those as the operating core customers will judge first

## 11. Recommended Linear Structure

Recommended epic labels for customer-facing product planning:

- `epic:onboarding`
- `epic:ux`
- `epic:crm`
- `epic:pipelines`
- `epic:agents`
- `epic:governance`
- `epic:dashboard`
- `epic:work-management`
- `epic:portability`

Recommended CUJ tags:

- `#bootstrap-company`
- `#morning-scan`
- `#define-work`
- `#spawn-team`
- `#delegate-work`
- `#review-approval`
- `#recover-work`
- `#monitor-burn`
- `#halt-agents`
- `#review-pipeline`
- `#improve-workforce`
- `#import-export-company`

Mapping note:

- The first six epic labels above already match what exists in Linear today.
- The last three are recommended additions because the current backlog underrepresents those parts of the product.

## 12. Definition Of Done For Future CUJ Changes

A new customer journey should only be added here if it is true that:

1. a real customer user will perform it directly in the product
2. it recurs or is strategically central
3. it maps to a clear success/failure state
4. it changes what the top-level product must optimize for

If not, it belongs in a feature spec, implementation plan, or internal workflow doc instead.
