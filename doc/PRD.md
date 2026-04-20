# AgentDash — Product Requirements Document

**Version:** 3.0
**Date:** 2026-04-17
**Status:** Active

---

## 1. Product Overview

**AgentDash** is the **System of Action** for AI inside a company. It sits between the existing System of Record (HubSpot, Salesforce) and the runtime that actually does work, and ships two tightly coupled capabilities on the same governance substrate:

- **Track A — Agent Workforce:** deploy, manage, and scale AI agent teams that run multi-stage pipelines, own CRM entities, and hand work back to humans at policy-defined gates.
- **Track B — Employee-Built Internal Apps ("vibecoding"):** let non-engineers author sanctioned internal tools — CRM plug-ins, proposal generators, document cleaners, ad-hoc data filters — inside the organization's IT policy, instead of pasting company data into consumer ChatGPT.

Both tracks share one identity model, one entitlements tier, one audit trail, one security policy engine, one budget ledger, and one CRM data layer. The pitch to a customer is a single platform: "give your people AI that knows your data and stays inside your guardrails, whether that AI is a 24×7 agent or a coworker's weekend side-tool."

**Tagline:** Your AI workforce and your AI toolbox, on the same rails.

### Target Customers

| Segment | Company Size | Track A Angle | Track B Angle |
|---------|-------------|---------------|---------------|
| **SMB** (Free / Pro) | 10–50 people | Agents handle follow-ups, lead qualification, support tickets. BYOT tokens. | Ops person vibecodes a lead-import cleaner and a proposal drafter. |
| **Mid-market** (Pro) | 50–500 people | Agents run operational workflows, humans review escalations. HubSpot/Slack integration. | Department leads ship 5–20 internal tools per quarter; IT reviews before publish. |
| **Enterprise** (Enterprise) | 500+ people | Agents as workforce layer, full governance, multi-pipeline, Salesforce sync. | Citizen-dev program with org-wide app catalog, data-boundary policies, SSO, audit export. |

**First client:** SMB construction services company (MKthink) using HubSpot CRM — primary on Track A; Track B as the "give IT a safer alternative to ChatGPT" upsell.

### Core Value Proposition

- **One governance fabric:** same policy engine, kill switch, budget, and audit trail protect agents (Track A) and employee-built apps (Track B).
- **Your data, your perimeter:** deploy on your own infra (BYOT) or cloud — company data never leaves the tenant.
- **Pipelines with human-in-the-loop gates:** DAG orchestration, fan-out/fan-in, HITL approvals, self-healing retries.
- **Existing systems as first-class integrations:** HubSpot bidirectional sync today; Slack, GitHub, Linear manifests shipped.
- **Smart cost control:** tier gating, burn-rate forecasting, small-model routing for mechanical tasks.
- **CRM as System of Action:** both agents and vibecoded apps read from and write to customer data through one gated API layer.

---

## 2. User Personas

### Track A personas

**P1 — Board Operator (CEO / Founder / Ops Lead)**
- Oversees the AI workforce via daily dashboard (60-second morning scan).
- Approves spawn requests, reviews escalations, monitors spend and tier upgrades.
- Cares about: outcomes, cost, velocity, what needs attention.

**P2 — Department Lead (VP Eng / Growth Lead)**
- Manages agents within a function, creates projects, sets goals.
- Spawns additional agents when deadlines are tight.
- Cares about: delivery timelines, task dependencies, team capacity.

**P3 — External Stakeholder (Customer / Partner)**
- Interacts with agents indirectly through CRM, Slack, email.
- May not know they're talking to an agent.
- Cares about: responsiveness, quality, follow-through.

### Track B personas (new in v3.0)

**P4 — Citizen Developer (SDR, AE, Ops Analyst, Finance Partner, CS Manager)**
- Non-engineer. Today pastes CRM exports into ChatGPT because the "official" tool doesn't exist.
- Describes what they need in natural language; reviews the generated app; publishes to their team.
- Cares about: finishing the task today, not breaking anything, not getting in trouble with IT.

**P5 — IT Admin / Security Officer (CIO / Head of IT / Compliance)**
- Already lost the battle against shadow AI; wants a sanctioned lane that IT controls.
- Reviews citizen-built apps before publish, configures data boundaries, sees an audit of every app action.
- Cares about: least privilege, PII boundaries, vendor consolidation, audit defensibility.

Personas P4 and P5 operate inside the same company tenant as P1/P2 — no separate product, no separate login.

---

## 3. Critical User Journeys

CUJs 1–15 cover Track A (agent workforce). CUJs 16–19 cover Track B (citizen-developed internal apps). Every status below is validated by `doc/CUJ-STATUS.md` (60/60 API tests, 1,410/1,415 unit tests, Phase-1 E2E 14/14).

### CUJ-1 — First-Time Setup (Onboarding)
**Persona:** P1 | **Goal:** Zero to working agent team in under 30 minutes.

1. Deploy AgentDash (Docker, bare metal, or Railway).
2. Open dashboard → onboarding wizard (discovery → scope → goals → access → bootstrap).
3. System suggests initial agent team from LLM-ranked templates → approve.
4. First heartbeat fires → agent picks up a task → work begins.

**Status:** Fully Operational (11 endpoints, 7 CUJ tests).

### CUJ-2 — Morning Check-In (Daily Dashboard)
**Persona:** P1 | **Goal:** Company health in 60 seconds.

1. Dashboard → greeting + date + company name.
2. Scan "Needs Attention" (errors, blocked tasks, pending approvals, budget alerts).
3. Team Pulse (agent status dots), progress, activity feed.

**Status:** Fully Operational (2 CUJ tests).

### CUJ-3 — Scale the Team (Agent Factory)
**Persona:** P1/P2 | **Goal:** Spawn agents quickly from templates.

1. Browse templates → select → spawn with quantity, reason, project.
2. If approval required: request → P1 reviews → agents created.
3. New agents appear idle → assigned tasks → work begins.

**Status:** Fully Operational (11 endpoints, 9 CUJ tests).

### CUJ-4 — Task Dependencies (DAG)
**Persona:** P2 | **Goal:** Define task execution order.

1. Create issues with dependencies → BFS cycle-detection.
2. Complete task → auto-unblock downstream → agents wake via heartbeat.

**Status:** Fully Operational (5 endpoints, 6 CUJ tests). DAG visualization UI shipped.

### CUJ-5 — Emergency Stop (Kill Switch)
**Persona:** P1 | **Goal:** Instantly halt all agent activity.

1. Security page → "HALT ALL AGENTS" → confirm.
2. All agents paused, heartbeats cancelled, audit trail logged.
3. Investigate → "Resume All Agents" when resolved.

**Status:** Fully Operational (3 endpoints, 4 CUJ tests). **Kill switch covers Track B apps as well** — sanctioned employee apps go to the same halted state.

### CUJ-6 — Pipeline Orchestration (DAG Workflows)
**Persona:** P1/P2 | **Goal:** Multi-stage workflows with automated routing.

1. Create pipeline (agent stages, HITL gates, conditions, edges).
2. Trigger run → entry stages launch → agents execute → stages auto-advance.
3. Fan-out (parallel), fan-in (wait-all / first-wins), conditional routing.
4. HITL gates pause for human approval → approve/reject → continue/stop.
5. Self-healing retries on failed stages; budget tracking per stage; CRM lifecycle hooks on completion.

**Status:** Fully Operational (10 endpoints). Wizard and run-detail UI complete.

### CUJ-7 — CRM Pipeline Review
**Persona:** P1 | **Goal:** See customer pipeline, deals, leads, partners.

1. `/crm` summary (value, accounts, leads, deals, partners).
2. Pipeline-by-stage; leads → account+contact conversion; deal detail.
3. HubSpot bidirectional sync (contacts, companies, deals, activities).

**Status:** Fully Operational (31 endpoints, 8 CUJ tests, Phase-1 E2E green).

### CUJ-8 — Research Cycle (AutoResearch)
**Persona:** P1/P2 | **Goal:** Hypothesis-driven experiment loops.

1. Cycle linked to goal → agent generates hypotheses (gated behind Pro tier).
2. Human approves → experiment with budget/time limits.
3. Execute → measurements → evaluation verdict.
4. Loop until goal met or budget exhausted.

**Status:** Fully Operational (21 endpoints, 7 CUJ tests). Detail pages shipped. Feature is `autoResearch`-gated (Pro+).

### CUJ-9 — Security Policy Configuration
**Persona:** P1/P5 | **Goal:** Define what agents *and apps* can and cannot do.

1. Security page → add policy (5 types: resource_access, action_limit, data_boundary, rate_limit, blast_radius).
2. Target: all agents, role, single agent, or **Track B app** (new in v3.0).
3. Policy evaluates on hot path → action denied/escalated → audit trail.

**Status:** Fully Operational for agents (14 endpoints, 5 CUJ tests). Policy target expansion for Track B apps is tracked in Open Items (P1).

### CUJ-10 — Skill Management
**Persona:** P2 | **Goal:** Author, review, and deploy agent skills.

1. Create skill → new version (draft → in_review → approved → published → deprecated).
2. Review workflow ties into the approval system.
3. Usage analytics by skill and agent.

**Status:** Fully Operational (17 endpoints, 6 CUJ tests). **Reused as the authoring substrate for Track B apps (CUJ-16).**

### CUJ-11 — Budget Monitoring & Forecasting
**Persona:** P1 | **Goal:** Spend visibility, forecasts, ROI.

1. Costs page → spend by agent / project / **Track B app**.
2. Capacity dashboard → burn rate, trend, days-until-exhaustion.
3. Multi-resource tracking (LLM tokens, compute, SaaS APIs).

**Status:** Fully Operational (16 endpoints, 6 CUJ tests). Forecast UI shipped. Cost attribution per vibecoded app is a Track B open item (P1).

### CUJ-12 — CRM Customer 360
**Persona:** P1 | **Goal:** Everything about a customer in one place.

1. Accounts list → click account.
2. Header, metrics strip, contacts, deals, activity timeline, agent history.
3. Timeline intermixes HubSpot-synced data, agent actions, **and Track B app actions** (after CUJ-19 lands).

**Status:** Fully Operational (APIs + UI). Timeline enrichment for Track B events is P1.

### CUJ-13 — Agent Impact on Customer
**Persona:** P1 | **Goal:** Trust the system by seeing what agents did.

1. Account detail timeline → pipeline stages, action proposals, CRM updates.
2. Totals: tickets resolved, escalated, cost saved.
3. Deal stages auto-advance when agents complete linked work.

**Status:** Fully Operational. OKR tab on Agent Detail shipped.

### CUJ-14 — Smart Model Routing
**Persona:** P1/P2 | **Goal:** Cut LLM costs by routing mechanical tasks to small models.

Routing rule: **does this task require thinking, or just executing?** Thinking → agent's default (large) model. Pure execution (deterministic, verifiable, ≤3 tool calls) → small model (Haiku, GPT-4o-mini, Gemini Flash).

1. Skill author publishes a skill with `modelTier: "small"` + `maxToolCalls` via Skills Registry.
2. Heartbeat matches task → router checks skill's `modelTier`.
3. If small, override agent's model for this dispatch only.
4. No skill match → agent default.
5. Post-exec verification (schema or exit-code). No auto-escalation — these are deterministic tasks.
6. Pipeline stages and **Track B app steps** may also declare `modelTier: "small"`.

**Priority:** Pipeline stage > Skill > Agent default.

**Status:** Fully Operational (17 tests passing). Track B reuse of this router is the default path.

### CUJ-15 — Agent–Human Conversation (Comment-Driven)
**Persona:** P2 | **Goal:** Answer agent questions via issue comments, not a chat mode.

Agents are always autonomous. When they need input they post a question as an issue comment and pause; a reply wakes them.

1. Heartbeat posts summary/question as issue comment.
2. Agent needing input → no further auto-heartbeat.
3. Human replies → wakeup with comment body in prompt context.
4. Repeat until resolved.

**Status:** Fully Operational. Chat-style rendering, waiting indicator, PATCH-route wake alignment all shipped.

---

### Track B CUJs (new in v3.0)

These are the citizen-developer journeys. Execution substrate reuses Plugins (`packages/plugins/`), Skills Registry review workflow (CUJ-10), Security Policies (CUJ-9), Budget (CUJ-11), and Kill Switch (CUJ-5).

### CUJ-16 — Vibecode an Internal App
**Persona:** P4 | **Goal:** Non-engineer ships a working internal tool in <20 minutes.

1. Citizen dev opens `/apps/new` → describes the tool in natural language ("take a CSV of leads, dedupe by email, enrich from HubSpot, drop anyone marked `churned`, export the rest").
2. Authoring agent generates app spec: inputs, data sources, transforms, outputs, required entitlements.
3. Preview sandbox runs the spec on a 10-row sample from the user's own data with policy engine in dry-run mode.
4. User reviews output, iterates in chat ("also strip emails under 3 chars"), saves as draft.
5. Draft enters review queue (see CUJ-17).

**Status:** Not built — P0 for Track B MVP. Reuses `skill_versions` draft→in_review pipeline and plugin runtime.

### CUJ-17 — Review & Publish (IT Governance Gate)
**Persona:** P5 (reviewer) and P4 (author) | **Goal:** Ship sanctioned apps; reject or constrain risky ones.

1. Author submits for review → "in_review" status.
2. IT Admin sees the app in `/governance/apps-queue`: plain-language intent, data sources touched, policy requirements, sandbox test output, diff vs. prior versions.
3. IT can: approve, approve-with-constraints (attach a data_boundary or rate_limit policy), reject with note, or request changes.
4. On approve → app moves to `published`, appears in org catalog.
5. Every change requires a new version; approved versions are immutable.

**Status:** Not built — P0 for Track B MVP. Reuses Skills Registry review workflow (CUJ-10).

### CUJ-18 — Run a Sanctioned App
**Persona:** P4 (or any employee in the org catalog's audience) | **Goal:** Actually get the business task done.

1. User opens `/apps` (org catalog) → finds "Lead CSV Dedupe v3" → opens it.
2. Runs it with their data (file upload, parameter form, or CRM selection).
3. App executes inside the plugin sandbox; policy engine enforces on the hot path (can't access accounts outside the user's assigned companies; can't write to closed_won deals; can't egress data outside tenant).
4. Budget ledger records tokens/compute; activity timeline records the run, inputs, outputs, and which account(s) it touched.
5. Kill switch and tier gates apply identically to Track A agents.

**Status:** Not built — P0 for Track B MVP.

### CUJ-19 — Governance Dashboard for Citizen Apps
**Persona:** P5 | **Goal:** See and defend the entire citizen-dev program.

1. `/governance/apps` → every published app, author, last run, policy attachments, budget month-to-date, last review date.
2. Filters: "touches PII," "reads CRM," "writes CRM," "external egress," "failed reviews."
3. Revoke, re-review, throttle, or retire any app with one action. Revoke is instant and appears in the user-facing catalog as "Deprecated — contact IT."
4. Export audit log (CSV/JSON) for SOC2 / ISO / customer audit requests.

**Status:** Not built — P1 for Track B (follows MVP).

### CUJ-20 — Org App Catalog & Cross-Team Sharing
**Persona:** P2 / P4 | **Goal:** Discover what coworkers already built; don't reinvent.

1. `/apps` lists all published apps the user's audience is allowed to see.
2. Author-scoped visibility (team, department, whole company).
3. Usage counts, star ratings, "used by" list, fork-to-customize.
4. Enterprise-tier: cross-tenant marketplace (opt-in) to share approved app specs between customers.

**Status:** Not built — P2 for Track B.

---

## 4. CRM Architecture (unchanged thesis)

AgentDash CRM is **not** a System of Record. HubSpot/Salesforce owns master data. AgentDash is the **System of Action** — the layer where AI decisions (from agents *and* from vibecoded apps) actually execute against customer data.

| Layer | Purpose | Owner |
|-------|---------|-------|
| System of Record | Master customer data | HubSpot, Salesforce |
| System of Engagement | Where interactions happen | Zendesk, Intercom, email |
| **System of Action** | Where AI decisions execute | **AgentDash** |

### Lifecycle stages
- **Accounts:** prospect → active → customer → champion → churned (auto-advances via lifecycle hooks).
- **Deals:** lead → qualification → proposal → negotiation → closed_won / closed_lost.
- **Leads:** new → contacted → qualified → converted / lost (conversion creates account + contact).

### What we do NOT build
Email/communication channels (HubSpot owns), marketing automation, revenue forecasting engine, custom-object builder.

---

## 5. Technical Deployment Strategy

### 5.1 Deployment modes (unchanged)

| Mode | Runtime | Data | Best for |
|------|---------|------|----------|
| **Local (Mac Mini / Bare Metal)** | `pnpm dev` or `./scripts/demo.sh` | Embedded PG | Development, demos, single-company |
| **Docker (Self-Hosted)** | `docker compose up` | Volume-persisted PG | Small teams, on-prem |
| **Cloud (Railway / Hosted)** | Railway deploy | External PG | SaaS, multi-tenant |
| **Hybrid** | UI+API in cloud, agent runtime on customer hardware | Customer-side | Data residency, air-gapped |

### 5.2 Entitlements & monetization (shipped 2026-04-17)

Three tiers (`plans` table + `company_plan` FK); `requireTier()` middleware; `/api/companies/:id/entitlements` endpoint; `useEntitlements()` hook; Billing page; UpgradeDialog; inline gates.

| Tier | Agents | Monthly actions | Pipelines | Key gates |
|------|--------|-----------------|-----------|-----------|
| Free | 3 | 500 | 1 | HubSpot sync ❌, AutoResearch ❌, Assess mode ❌, Track B publish ❌ |
| Pro | 25 | 25,000 | 10 | HubSpot sync ✅, AutoResearch ✅, Track B (team-scoped) ✅ |
| Enterprise | ∞ | ∞ | ∞ | All features, priority support, Track B with cross-team catalog + SSO |

`BillingProvider` interface stubs Stripe for Phase 3 (checkout session, webhook). Migration `0072_seed_plans.sql` seeds the three rows on fresh envs.

### 5.3 Security, isolation, and IT guardrails

Applies to **both** tracks — this is the shared substrate that makes Track B defensible.

- **Company scoping:** every table carries `company_id`; `assertCompanyAccess()` enforced in routes and services.
- **Actor model:** `req.actor` (board / agent / none) set by middleware; `local_implicit` for local_trusted deployments.
- **Policy engine:** 5 policy types (resource_access, action_limit, data_boundary, rate_limit, blast_radius) evaluate on the hot path; deny/escalate/allow decisions logged.
- **Kill switch:** one-click halt propagates to all agents and all running Track B apps.
- **Audit trail:** append-only; every CRM read/write, tool call, and policy decision stamped with actor and run-id.
- **Secrets:** never in URL params, never logged; per-connector credential store (`connectors_credential_mode`).
- **Track B sandbox:** citizen-authored apps execute inside the existing JSON-RPC plugin worker isolate — no direct DB, no filesystem outside workspace, egress only to allow-listed integrations; reads/writes pass through the same CRM service layer as Track A.
- **Review gate:** `published` state is the only state that appears in the org catalog; drafts and in_review apps are invisible to consumers.

### 5.4 Track B technical architecture (new in v3.0)

```
┌────────────────────────────────────────────────────────────────┐
│  Citizen Dev Authoring (P4)                                     │
│  /apps/new  ──►  Authoring LLM  ──►  App Spec (YAML)            │
│                                      + generated plugin code    │
└────────────────────────────────────────────────────────────────┘
                                 │
                    draft → in_review (reuses skill_versions)
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│  IT Review (P5)                                                 │
│  /governance/apps-queue  ──►  approve / constrain / reject      │
│                              attach policies (CUJ-9)            │
└────────────────────────────────────────────────────────────────┘
                                 │
                           published
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────┐
│  Org Catalog (CUJ-20)                                           │
│  /apps  ──►  employee runs  ──►  plugin sandbox worker          │
│                                  │                              │
│                                  ├─ reads via CRM service layer │
│                                  │   (policy engine enforces)   │
│                                  ├─ LLM calls through model     │
│                                  │   router (CUJ-14)            │
│                                  ├─ budget ledger update        │
│                                  └─ activity log + audit        │
└────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                       Governance Dashboard (CUJ-19)
                       Kill Switch (CUJ-5)
```

**Key reuse decisions (deliberate, not incidental):**
- App storage → `skill_versions` columns + a new `app_catalog` view; no new lifecycle machinery.
- Sandboxing → existing `packages/plugins/sdk` worker runtime.
- Review → existing approval system; IT reviewers are just board users with an `it_reviewer` role.
- Policy → existing `security_policies` table gains an optional `appId` target.
- Cost attribution → existing `resource_usage` gets an `appId` column.
- Audit → existing activity feed and CRM activity tables.

**Why this architecture:** every piece already has tests, E2E coverage, and production usage for Track A. Track B is a thin authoring + catalog layer on top — not a second product.

---

## 6. Technical Summary

- **86 schema tables** across **72 migrations** (0072 = plan-seed fix, landed 2026-04-17).
- **83 services**, **39 route modules**, **200+ API endpoints**.
- **62 UI pages** including Billing, PluginManager, Approvals, ActionProposals, Feed, CRM surfaces, Capacity, Templates, Skills, and more.
- **11 agent adapters**: Claude (local + API), Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw, Hermes, Process, HTTP.
- **Smart model routing** (CUJ-14): skill-driven two-tier, per-adapter model mapping, pipeline-stage overrides.
- **4 integration manifests**: HubSpot (operational bidirectional sync + webhooks + UI), Slack / GitHub / Linear (manifest-only, P2).
- **Three-tier entitlements** (CUJ-E): `plans` + `company_plan` + `requireTier()` + Billing page. Stripe provider stubbed for Phase 3.
- **Test coverage:** 1,410/1,415 unit/integration pass (3–4 pre-existing order-dependent server flakes), 60/60 API CUJ tests, 14/14 Phase-1 Playwright E2E specs (`scripts/qa/run-phase1-cujs.sh` orchestrator landed 2026-04-17).

---

## 7. Open Items (tasks)

### P0 — First client & Track B MVP

Track A (first client):
- HubSpot deeper automation triggers beyond bidirectional sync.
- Cloud deployment hardening (external PG, health monitoring, backups).
- Onboarding LLM polish (context extraction, team suggestion ranking).

Track B (VC demo + first client upsell):
- CUJ-16: `/apps/new` authoring flow (NL → app spec → preview sandbox → draft save).
- CUJ-17: `/governance/apps-queue` review UI; approve / approve-with-constraints / reject / request-changes actions.
- CUJ-18: `/apps` org catalog + run UI; plugin sandbox execution path with policy engine + budget ledger wiring.
- Seed 3 demo apps for the VC walkthrough: **Lead CSV Dedupe+Enrich**, **Proposal Draft from Brief**, **CRM Stale-Deal Filter**.

### P1 — Important

Track A:
- AutoResearch cycle detail pages (hypotheses, experiments, evaluations).
- Skill version management UI (list, diff, approve/publish).
- Budget forecast + allocation display on Capacity page.

Track B:
- CUJ-19 governance dashboard (inventory, filters, revoke/re-review/throttle, audit export).
- Track B cost attribution: `appId` on `resource_usage`, Costs page tab.
- Policy-engine support for `target.appId`.
- CRM activity timeline enrichment: include Track B app runs beside agent actions.
- Stripe integration (Phase 3): swap `StubBillingProvider`, add `/api/billing/webhook`, wire UpgradeDialog CTA.

### P2 — Nice to have

- CUJ-20 cross-team / cross-tenant app marketplace.
- Slack / GitHub / Linear plugin implementations.
- Multi-tenant SaaS mode with tenant isolation.
- Helm chart for Kubernetes deployment.
- White-labeling.
- Distributed execution (web + worker split, Redis pub/sub, job queue).

---

## 8. What ships for the VC conversation

One demo, two tracks, one platform:

1. **Track A live** (2 minutes): open Yarda AI company → Morning Dashboard → show agents, pipeline, CRM pipeline review, kill switch.
2. **Track B live** (3 minutes): switch to a different login → `/apps/new` → "clean this CSV of leads against our HubSpot and drop churned accounts" → preview → publish-to-review → IT login → approve → employee login → run it → timeline shows the run, policy engine shows the denied write attempts, governance dashboard shows the new app with its attached data_boundary policy.
3. **Governance proof** (1 minute): flip the kill switch → both the agent pipeline and the running Track B app halt; resume → both come back; audit export shows the last 30 minutes end-to-end.

The point is that **one fabric governs both**, and a customer doesn't have to choose between "give my people AI" and "stay compliant."
