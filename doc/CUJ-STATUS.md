# AgentDash — CUJ & Feature Status

**Last updated:** 2026-04-17
**Test results:** 60/60 CUJ tests pass, 1406/1410 Vitest unit/integration tests pass (3–4 pre-existing order-dependent server flakes), Phase 1 + Phase 2 E2E specs green

---

## Critical User Journeys

### CUJ-1: First-Time Setup (Onboarding)

**Status: Fully Operational**

| Step | Status | Notes |
|------|--------|-------|
| Deploy AgentDash (Docker/bare metal) | Done | Docker Compose, embedded PG, cloud VM supported |
| Onboarding wizard UI (`/setup`) | Done | 5-step flow: discovery, scope, goals, access, bootstrap |
| Ingest company sources (text, URLs) | Done | Multiple source types supported |
| Extract structured context from sources | Done | LLM-powered extraction (domain, products, team, tech stack, pain points). Falls back to truncation when `ANTHROPIC_API_KEY` not set |
| Suggest initial agent team from templates | Done | LLM-ranked template suggestions with relevance scores. Falls back to unranked when no API key |
| Apply team (create agents from templates) | Done | Bulk agent creation from approved suggestions |
| Complete onboarding session | Done | Session lifecycle fully tracked |

**API coverage:** 11 endpoints
**Test coverage:** 7 CUJ tests + 5 Vitest route tests

---

### CUJ-2: Morning Check-In (Daily Dashboard)

**Status: Fully Operational**

| Step | Status | Notes |
|------|--------|-------|
| Dashboard summary (agents, tasks, costs) | Done | Morning briefing layout |
| "Needs Attention" items | Done | Errors, blocked tasks, pending approvals, budget alerts |
| Team Pulse (agent status dots) | Done | Green/amber/red status |
| Activity feed | Done | Chronological company activity |

**API coverage:** Dashboard summary + activity feed endpoints
**Test coverage:** 2 CUJ tests + existing Paperclip dashboard tests

---

### CUJ-3: Scale the Team (Agent Factory)

**Status: Fully Operational**

| Step | Status | Notes |
|------|--------|-------|
| Browse agent templates | Done | Grid view with role, adapter, budget, skills, OKRs |
| Create template | Done | Dialog with name, slug, role, adapter, budget |
| Spawn agents from template | Done | Dialog with quantity, reason, project selection |
| Approval flow (request → approve → agents created) | Done | Auto-creates approval, linked to spawn request |
| Fulfill spawn (create N agents with template config) | Done | Copies role, adapter, skills, budget, permissions |
| Set agent OKRs | Done | Objectives + key results per agent |
| Capacity dashboard shows updated workforce | Done | Workforce snapshot, department breakdown |

**API coverage:** 11 endpoints (templates CRUD, spawn requests, OKRs)
**Test coverage:** 9 CUJ tests + 5 Vitest route tests

---

### CUJ-4: Manage Task Dependencies (DAG)

**Status: Backend Complete, UI Partial**

| Step | Status | Notes |
|------|--------|-------|
| Create issues with dependencies | Done | `addDependency` API |
| Circular dependency detection (BFS) | Done | Prevents invalid DAGs |
| View blockers for an issue | Done | List blocker issues |
| Auto-unblock when dependency completes | Done | Transitions blocked → todo automatically |
| Agent wakeup on dependency resolution | Done | Heartbeat triggered |
| Dependency graph endpoint | Done | Returns edges for a project |
| **Dependency graph visualization** | **Not built** | No UI for viewing the DAG — P1 |

**API coverage:** 5 endpoints
**Test coverage:** 6 CUJ tests (all pass including cycle detection and auto-unblock)

---

### CUJ-5: Emergency Stop (Kill Switch)

**Status: Fully Operational**

| Step | Status | Notes |
|------|--------|-------|
| Kill switch panel in Security page | Done | Prominent halt/resume buttons |
| Halt all agents (company scope) | Done | All agents paused with `kill_switch` reason |
| Halt single agent | Done | Per-agent scope supported |
| Resume all agents | Done | Agents return to `idle` |
| Audit trail of kill switch events | Done | Append-only log |
| Kill switch status on dashboard | Done | Halted state visible |

**API coverage:** 3 endpoints (activate, resume, status)
**Test coverage:** 4 CUJ tests + 5 Vitest route tests

---

### CUJ-6: CRM Pipeline Review

**Status: Fully Operational**

| Step | Status | Notes |
|------|--------|-------|
| Pipeline summary (deal count + value per stage) | Done | Aggregate endpoint |
| CRM accounts CRUD | Done | Name, domain, industry, stage, owner |
| CRM contacts CRUD | Done | Linked to accounts |
| CRM deals CRUD | Done | Stage pipeline, amount, probability |
| CRM leads CRUD + conversion | Done | Lead → account + contact conversion |
| CRM partners CRUD | Done | Type, tier, status |
| CRM activities (notes, calls, emails) | Done | Linked to accounts/deals |
| Pipeline page UI | Done | Summary cards, stage breakdown, deal/lead/partner tables |
| HubSpot bidirectional sync | Done | Contacts, companies, deals, activities |
| HubSpot Settings page | Done | Save/test connection, sync now, status polling |
| HubSpot webhook receiver (HMAC verified) | Done | Timing-safe signature verification |
| HubSpot hourly auto-sync scheduler | Done | Background sync with error handling |

**API coverage:** 31 endpoints (CRM CRUD + pipeline + HubSpot config/sync/webhook)
**Test coverage:** 8 CUJ tests + 8 Vitest route tests

---

### CUJ-7: Research Cycle (AutoResearch)

**Status: Backend Complete, UI Partial**

| Step | Status | Notes |
|------|--------|-------|
| Create research cycle linked to goal | Done | Title, max iterations, budget |
| Create hypotheses | Done | Title, rationale, source (human/agent) |
| Create experiments with budget caps | Done | Success criteria, time limits |
| Define metric definitions | Done | Key, unit, data source, collection method |
| Record measurements | Done | Value, timestamp, method |
| Create evaluations with verdicts | Done | Validated/invalidated/inconclusive + analysis |
| Research dashboard (cycle list) | Done | List view with status |
| **Cycle detail pages** | **Not built** | No drill-down into hypotheses/experiments/evaluations — P1 |
| **LLM hypothesis generation** | **Not built** | Hypotheses are human-created only — P2 |

**API coverage:** 21 endpoints
**Test coverage:** 7 CUJ tests + 6 Vitest route tests

---

### CUJ-8: Security Policy Configuration

**Status: Fully Operational**

| Step | Status | Notes |
|------|--------|-------|
| Create security policies | Done | 5 types: resource_access, action_limit, data_boundary, rate_limit, blast_radius |
| Policy targeting (company, role, agent) | Done | Flexible target scoping |
| Policy evaluation on hot path | Done | Audit log of all evaluations |
| Deactivate/reactivate policies | Done | Toggle without deleting |
| Agent sandbox configuration | Done | Isolation level, network policy, resource limits |
| Security page UI | Done | Policy list + add policy + kill switch panel |

**API coverage:** 14 endpoints (policies CRUD + evaluation + sandbox)
**Test coverage:** 5 CUJ tests + 7 Vitest route tests

---

### CUJ-9: Skill Management

**Status: Backend Complete, UI Partial**

| Step | Status | Notes |
|------|--------|-------|
| Create skills | Done | Key, name, markdown content |
| Version skills (sequential numbers) | Done | Draft → in_review → approved → published → deprecated |
| Skill review workflow (ties into approvals) | Done | Submit for review, approve, publish |
| Skill dependencies (with cycle prevention) | Done | Set/get/check dependents |
| Skill usage analytics | Done | Usage by skill, by agent |
| Version diff | Done | Line-level diff between versions |
| Skills page (list view) | Done | Basic skill listing |
| **Version management UI** | **Not built** | No UI for version list, diff view, approve/publish — P1 |

**API coverage:** 17 endpoints
**Test coverage:** 6 CUJ tests + 3 Vitest route tests

---

### CUJ-10: Budget Monitoring & Forecasting

**Status: Backend Complete, UI Partial**

| Step | Status | Notes |
|------|--------|-------|
| Department management | Done | Create, list, hierarchy |
| Workforce snapshot (agent count by status) | Done | Real-time count |
| Task pipeline (issue count by status) | Done | Pipeline metrics |
| Burn rate calculation | Done | Daily average, trend |
| Budget allocations | Done | Flexible parent-child scope |
| Budget forecasts | Done | Days-until-exhaustion projections |
| Resource usage tracking (beyond LLM tokens) | Done | Compute hours, SaaS APIs, custom |
| Resource usage summary | Done | Aggregated by type |
| Capacity dashboard UI (basic) | Done | Workforce + department view |
| **Forecast/allocation UI** | **Not built** | No display for burn rate, ROI, forecasts — P1 |

**API coverage:** 16 endpoints
**Test coverage:** 6 CUJ tests + 5 Vitest route tests

---

## Summary

| CUJ | Status | CUJ Tests | Vitest Tests |
|-----|--------|-----------|-------------|
| CUJ-1: Onboarding | Fully Operational | 7/7 | 5 |
| CUJ-2: Dashboard | Fully Operational | 2/2 | (Paperclip) |
| CUJ-3: Agent Factory | Fully Operational | 9/9 | 5 |
| CUJ-4: Task Dependencies | Backend complete | 6/6 | (Paperclip) |
| CUJ-5: Kill Switch | Fully Operational | 4/4 | 5 |
| CUJ-6: CRM Pipeline | Fully Operational | 8/8 | 8 |
| CUJ-7: AutoResearch | Backend complete | 7/7 | 6 |
| CUJ-8: Security Policies | Fully Operational | 5/5 | 7 |
| CUJ-9: Skill Management | Backend complete | 6/6 | 3 |
| CUJ-10: Budget & Capacity | Backend complete | 6/6 | 5 |
| **Total** | | **60/60** | **37 + 738 inherited = 775** |

### New Features (Post-V1)

#### Pipeline Orchestrator

**Status: Operational**

| Step | Status | Notes |
|------|--------|-------|
| Create multi-stage pipelines | Done | Linked to agents |
| Pipeline runs with auto-advance | Done | Stage-by-stage execution |
| Stage issue creation | Done | Issues created per stage |
| CRM lifecycle hooks on completion | Done | Fire-and-forget CRM updates |
| Pipeline UI page | Done | Stage progress visualization |

#### Action Proposals

**Status: Operational**

| Step | Status | Notes |
|------|--------|-------|
| Generate action proposals | Done | Agent-originated proposals |
| Policy engine evaluation | Done | Auto-approve/escalate/deny decisions |
| Evidence display | Done | Supporting data rendered in UI |
| CRM link integration | Done | Links to relevant CRM entities |

#### Operator Feed

**Status: Operational**

| Step | Status | Notes |
|------|--------|-------|
| Personalized feed aggregation | Done | Issues, approvals, agent activity |
| Priority ranking | Done | Attention items surfaced first |
| Feed page UI | Done | Chronological + priority views |

#### Execution Workspaces

**Status: Operational**

| Step | Status | Notes |
|------|--------|-------|
| Workspace lifecycle management | Done | Create, provision, close |
| Runtime service supervision | Done | Heartbeat sessions |
| Workspace close dialog | Done | Graceful shutdown UI |

---

### V1 Completion — Phase 1 (UI Stub Elimination)

Completed 2026-04-16 on `feat/v1-completion-phase-1`. 12 UI stubs closed across 4 CUJs; every page now wired to a real backend surface.

| CUJ | Surface | Status | E2E Spec |
|-----|---------|--------|----------|
| CUJ-D: Adapter Onboarding | Adapter install/health/credential management | Done | `tests/e2e/cuj-d-adapter-onboarding.spec.ts` |
| CUJ-B: Agent Governance | Action Proposals approval queue, Feed aggregation | Done | `tests/e2e/cuj-b-agent-governance.spec.ts` |
| CUJ-A: Sales Pipeline | Leads, Kanban drag/drop, Deal detail, HubSpot settings | Done | `tests/e2e/cuj-a-sales-pipeline.spec.ts` |
| CUJ-C: Productivity | User Profile, user-scoped Feed | Done | `tests/e2e/cuj-c-productivity.spec.ts` |

### V1 Completion — Phase 2 (Three-Tier Entitlements)

Completed 2026-04-17 on `feat/v1-completion-phase-1`. `plans` + `company_plan` tables, pure `entitlements.ts` policy module, `requireTier()` middleware, `/api/companies/:id/entitlements` read endpoint, `useEntitlements()` hook, Billing page (tier + limits + feature matrix), UpgradeDialog, and inline gates on HubSpot/AutoResearch/Dashboard. `BillingProvider` interface stubs Stripe for Phase 3.

| CUJ | Surface | Status | E2E Spec |
|-----|---------|--------|----------|
| CUJ-E: Entitlements | Billing page + tier gates + upgrade CTA | Done | `tests/e2e/cuj-e-entitlements.spec.ts` |

Phase 3 (deferred): swap `StubBillingProvider` for Stripe-backed impl, add `/api/billing/webhook`, wire UpgradeDialog CTA to checkout session.

### Remaining P1 Work (post Phase 1)

- Task dependency DAG visualization
- AutoResearch cycle detail pages (hypotheses, experiments, evaluations)
- Skill version management UI (list, diff, approve/publish)
- Budget forecast and allocation display in Capacity page
- Agent OKR display on Agent Detail page

### Integration Status

| Integration | Status |
|-------------|--------|
| HubSpot | Fully operational (bidirectional sync, webhooks, UI) |
| Slack | Manifest only (P2) |
| GitHub | Manifest only (P2) |
| Linear | Manifest only (P2) |
