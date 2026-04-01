# AgentDash Subscription Platform Plan

Date: 2026-03-31
Status: Proposed commercialization plan

## Goal

Package AgentDash into a paid platform that supports trials, subscriptions, and hosted operations without losing the core product promise:

- control plane for AI workforces
- human governance
- BYOT / customer-controlled execution paths where needed
- clear operator value at the board level

Related onboarding design:

- see `doc/plans/2026-03-31-cto-onboarding-and-provisioning.md` for the CTO-first onboarding and provisioning model that should wrap this commercialization work

## What “Paid Platform” Should Mean

There are really two monetization-ready products, not one:

### 1. Hosted Control Plane SaaS

We host AgentDash.
Customers pay for:

- hosted dashboard/control plane
- workflow integrations
- approvals/governance/history
- billing, support, backups, and upgrades

### 2. Managed Self-Hosted Enterprise

Customers run AgentDash in their environment.
They pay for:

- license/support contract
- enterprise features
- managed onboarding / migration / support

Recommendation:
- build the SaaS architecture first
- keep self-hosted enterprise as a packaging/deployment variant on the same core

## Product Packaging Recommendation

### Starter

Target:
- small teams evaluating the product

Likely limits:

- 1 company
- 1 board operator + small collaborator cap
- limited integrations
- limited agent count
- limited history retention

### Growth

Target:
- SMB operators running one real AI team

Includes:

- more agents
- core integrations
- approvals / governance
- better reporting
- support SLA

### Enterprise

Target:
- multi-department deployments

Includes:

- SSO / SCIM
- audit/compliance features
- advanced policy controls
- private networking / dedicated hosting / self-hosted option
- premium support

### Usage Metering

The clean commercial model is hybrid:

- platform subscription fee
- optional usage-based metering on hosted features

Do **not** lead with pure token markup as the only revenue model.
AgentDash’s value is orchestration, governance, integration, visibility, and operator leverage.

## Recommended Pricing Axis

Price primarily on control-plane value, not raw model usage.

Good billing axes:

- per company / workspace
- operator seats
- managed agent count bands
- premium integrations
- enterprise security/compliance tier

Secondary usage axes:

- hosted run volume
- storage / history retention
- premium research / analytics workload

Avoid:

- charging only “per API token”
- charging only “per agent” with no governance/integration differentiation

## Architecture Gaps Before SaaS

The current repo is still fundamentally closer to self-hosted V1 than true hosted SaaS.

### Gap 1. Multi-Tenant Isolation

Needed:

- real tenant model beyond “single-tenant deployment, multi-company data model”
- tenant-scoped auth, storage, secrets, and billing
- hard isolation at API, DB, job, file, and websocket layers

### Gap 2. Commercial Auth

Needed:

- customer signup
- team invites
- org admin model
- SSO for enterprise
- account recovery / email verification

### Gap 3. Billing System

Needed:

- Stripe or equivalent
- plans, trials, subscription state, invoices
- entitlement checks in product
- upgrade / downgrade behavior

### Gap 4. Hosted Secrets / Connector Model

Needed:

- hosted secret storage story
- encrypted per-tenant connector credentials
- rotation/audit flows
- clear separation between customer BYOT keys and platform-owned keys

### Gap 5. Hosted Agent Execution Strategy

Needed product decision:

1. control plane only, customer-hosted execution
2. hosted execution for some adapters
3. hybrid

Recommendation:
- Phase 1 SaaS should support:
  - hosted control plane
  - customer-managed keys
  - customer-hosted local execution where needed
  - hosted remote/gateway execution only where operationally clean

### Gap 6. Reliability / Operations

Needed:

- background worker model separate from web process
- queues and retries
- tenant-aware observability
- backups / restore
- rate limiting / abuse controls
- incident tooling

### Gap 7. Supportable Onboarding

Needed:

- trial onboarding flow
- sample company bootstrap
- integration setup wizard
- safer default budgets / kill-switch policies

## Canonical SaaS Build Phases

### Phase 0. Commercialization Baseline

Outcome:
- can legally and credibly package AgentDash

Includes:

- licensing cleanup
- package metadata rebrand
- customer-visible product rebrand
- third-party notices
- release packaging hygiene

Status:
- mostly done in this workspace, with remaining product-copy cleanup mapped in `doc/BRAND-REFERENCE-MAP.md`

### Phase 1. Paid Self-Serve Control Plane

Outcome:
- a customer can sign up, create an org, start a trial, connect one workflow, and run one company

Build:

- auth + org/account model
- Stripe subscriptions / trials / entitlements
- hosted dashboard deployment
- onboarding for first company
- support desk / error reporting basics

### Phase 2. Multi-User Governance

Outcome:
- a real customer team can operate together

Build:

- company/org memberships
- role model for board operator, lead, reviewer
- approval routing by role
- basic activity/audit review surfaces

### Phase 3. Integration-Led Monetization

Outcome:
- product becomes sticky because it is connected to real workflows

Build:

- HubSpot production connector
- Slack / email / GitHub / Linear production-grade integrations
- connector health and admin surfaces
- sync error handling

### Phase 4. Hosted Execution / Premium Automation

Outcome:
- premium tier with less setup and more autonomous value

Build:

- remote execution substrate for supported adapters
- quotas, scheduling, isolated workspaces
- hosted research loops / premium automation jobs

### Phase 5. Enterprise Package

Outcome:
- sell to larger customers

Build:

- SSO / SCIM
- private networking
- advanced audit exports
- stronger policy controls
- data residency / deployment options

## Recommended First Commercial Backlog

### Epic A. Account, Org, and Billing

- signup / login / invite flows
- Stripe customer + subscription + trial state
- plan entitlements middleware
- billing settings page

### Epic B. Hosted Tenant Foundations

- tenant table and tenant scoping
- tenant-aware secrets/storage
- tenant-aware background jobs
- tenant isolation tests

### Epic C. First-Run SaaS Onboarding

- landing page to app onboarding
- create org + create company
- sample company bootstrap
- first-integration flow

### Epic D. Commercial Admin Surfaces

- subscription status
- usage / limits
- upgrade prompts
- support / diagnostics

### Epic E. Premium Integrations

- HubSpot production hardening
- Slack notifications / approvals
- GitHub preview/PR linkage

## Hard Product Decisions To Make Early

### Decision 1. BYOT vs Platform Keys

Recommendation:
- default to BYOT
- allow platform-managed keys only as an optional premium convenience

### Decision 2. Execution Hosting

Recommendation:
- do not require hosted agent execution for initial paid launch
- sell the hosted control plane first

### Decision 3. Pricing Unit

Recommendation:
- price by workspace/company + plan tier + optional usage
- not by raw token resell alone

### Decision 4. Who Is The Wedge User

Recommendation:
- board operator / founder / ops lead running a small AI-native team
- not a broad “everyone in the company” collaboration tool at launch

## Minimum Launch Definition

AgentDash is ready for a paid hosted launch when all are true:

1. a customer can sign up without manual intervention
2. billing and trials work correctly
3. one org can create one company and reach first agent activity
4. at least one real integration works reliably
5. audit/governance/cost surfaces are good enough for daily use
6. support can diagnose tenant issues without direct DB surgery

## Recommended Next PM Step

Turn this into a Linear structure:

- one commercialization epic
- five implementation epics matching the phases above
- a launch checklist with explicit launch gates
