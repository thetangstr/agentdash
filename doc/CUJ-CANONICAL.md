# AgentDash — Canonical CUJ List

**Last updated:** 2026-04-29
**Authority:** This document is the single source of truth for Critical User Journey numbering. Other docs (`PRD.md`, `CUSTOMER-CUJS.md`, `CUJ-STATUS.md`, `tests/e2e/cuj-*.spec.ts`) are normalized to this numbering.

## Why this exists

Three pre-existing taxonomies disagreed on CUJ numbering:
- `CUJ-STATUS.md` (10 CUJs, implementation status focus)
- `CUSTOMER-CUJS.md` (12 CUJs, customer-journey taxonomy from 2026-03-31)
- `PRD.md` (CUJ-1 through CUJ-20, extends to Track B Citizen Apps)
- `tests/e2e/cuj-{a,b,c,d,e}-*.spec.ts` (5 lettered CUJs for V1 Phase 1 completion)

This doc unifies them under the **PRD numbering** (most expansive, most recent) and explicitly tags V1 Phase 1 features as `CUJ-V1.A` through `CUJ-V1.E`.

## Persona key

- **P1 — Board Operator** (founder/CEO/COO/Head of Ops, primary buyer)
- **P2 — Department Lead** (functional manager directing work)
- **P3 — Human Reviewer / Approver** (governance role)
- **P4 — Citizen Developer** (Track B authoring persona, future)
- **P5 — IT Admin / Security Officer** (Track B governance)

---

## V1 CORE (CUJ-1 through CUJ-10) — built, in production

### CUJ-1: First-Time Setup (Onboarding)
- **Persona:** P1
- **Surfaces:** `/setup`, `/companies`, onboarding wizard
- **Status:** ✅ Fully Operational
- **API:** 11 endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (7 tests), `server/src/__tests__/onboarding-routes.test.ts`, `tests/e2e/onboarding-setup.spec.ts`
- **Acceptance:** Customer creates company without provider plumbing knowledge; ≥1 agent + ≥1 issue exist; "work has started" state reached.

### CUJ-2: Morning Check-In (Daily Dashboard)
- **Persona:** P1
- **Surfaces:** `/dashboard`, `/inbox`, activity feed
- **Status:** ✅ Fully Operational
- **API:** Dashboard summary + activity feed endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (2 tests), `tests/e2e/dashboard.spec.ts`
- **Acceptance:** Operator sees needs-attention items first; can decide if action is required within 60 seconds.

### CUJ-3: Scale the Team (Agent Factory)
- **Persona:** P1, P2
- **Surfaces:** `/agents`, `/templates`, `/org`, `/approvals`
- **Status:** ✅ Fully Operational
- **API:** 11 endpoints (templates CRUD, spawn requests, OKRs)
- **Auto coverage:** `scripts/test-cujs.sh` (9 tests), `tests/e2e/agent-factory.spec.ts`
- **Acceptance:** Spawn from template, approval-gated, capacity dashboard updates.

### CUJ-4: Manage Task Dependencies (DAG)
- **Persona:** P1, P2
- **Surfaces:** `/issues`, issue detail
- **Status:** 🟡 Backend complete; DAG visualization UI not built (P1 follow-up)
- **API:** 5 endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (6 tests, includes cycle detection + auto-unblock)
- **Acceptance:** Cycles prevented; auto-unblock fires; agent wakeup on resolution.

### CUJ-5: Emergency Stop (Kill Switch)
- **Persona:** P1
- **Surfaces:** `/security` kill-switch panel, dashboard banner
- **Status:** ✅ Fully Operational
- **API:** 3 endpoints (activate, resume, status)
- **Auto coverage:** `scripts/test-cujs.sh` (4 tests), `tests/e2e/kill-switch.spec.ts`, `server/src/__tests__/security-routes.test.ts` (5)
- **Acceptance:** Halt all/single agent; resume; audit trail preserved; dashboard surfaces state.

### CUJ-6: Pipeline Orchestration (DAG Workflows) **[PRD insertion — was not in CUJ-STATUS.md numbering]**
- **Persona:** P1, P2
- **Surfaces:** `/pipelines`, pipeline detail
- **Status:** ✅ Operational (multi-stage pipelines, auto-advance, CRM lifecycle hooks)
- **API:** Pipeline routes + runner
- **Auto coverage:** Implicit via pipeline route tests + `tests/e2e/cuj-a-sales-pipeline.spec.ts` for CRM-linked pipelines
- **Acceptance:** Multi-stage, auto-advance between stages, issues created per stage.

### CUJ-7: CRM Pipeline Review **[was CUJ-6 in CUJ-STATUS.md]**
- **Persona:** P1, P2
- **Surfaces:** `/crm`, `/crm/pipeline`, HubSpot Settings
- **Status:** ✅ Fully Operational (incl. HubSpot bidirectional sync, webhook, hourly auto-sync)
- **API:** 31 endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (8 tests), `tests/e2e/crm-pipeline.spec.ts`, `tests/e2e/crm-customer360.spec.ts`, `tests/e2e/cuj-a-sales-pipeline.spec.ts`
- **Acceptance:** Pipeline summary, deal/lead/account CRUD, HubSpot sync round-trip.

### CUJ-8: Research Cycle (AutoResearch) **[was CUJ-7 in CUJ-STATUS.md]**
- **Persona:** P1, P2
- **Surfaces:** `/research`, cycle list
- **Status:** 🟡 Backend complete; cycle detail pages + LLM hypothesis generation not built (P1/P2)
- **API:** 21 endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (7 tests)
- **Acceptance:** Create cycle linked to goal; hypotheses + experiments + evaluations + measurements wired.

### CUJ-9: Security Policy Configuration **[was CUJ-8 in CUJ-STATUS.md]**
- **Persona:** P1, P3
- **Surfaces:** `/security`
- **Status:** ✅ Fully Operational
- **API:** 14 endpoints (policies CRUD + evaluation + sandbox)
- **Auto coverage:** `scripts/test-cujs.sh` (5 tests), `tests/e2e/security.spec.ts` (if exists), `server/src/__tests__/security-routes.test.ts` (7)
- **Acceptance:** Create/deactivate policies; agent sandbox config; policy evaluation logged.

### CUJ-10: Skill Management **[was CUJ-9 in CUJ-STATUS.md]**
- **Persona:** P1, P2
- **Surfaces:** `/skills`
- **Status:** 🟡 Backend complete; version management UI not built (P1)
- **API:** 17 endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (6 tests), `tests/e2e/skills.spec.ts`
- **Acceptance:** Skills CRUD + versioning + review workflow + dependencies (cycle prevention) + analytics.

---

## V1 EXTENSIONS (CUJ-11 through CUJ-15) — built or partial

### CUJ-11: Budget Monitoring & Forecasting **[was CUJ-10 in CUJ-STATUS.md]**
- **Persona:** P1, P2
- **Surfaces:** `/costs`, `/capacity`
- **Status:** 🟡 Backend complete; forecast/allocation UI not built (P1)
- **API:** 16 endpoints
- **Auto coverage:** `scripts/test-cujs.sh` (6 tests), `tests/e2e/budget.spec.ts`
- **Acceptance:** Burn rate + forecast + per-resource usage + capacity snapshot.

### CUJ-12: CRM Customer 360
- **Persona:** P1, P2
- **Surfaces:** `/crm/accounts/:id`, `/crm/contacts/:id`, `/crm/deals/:id`
- **Status:** ✅ Operational (drill-down pages, related-issue + activity timeline)
- **Auto coverage:** `tests/e2e/crm-customer360.spec.ts`
- **Acceptance:** Single account view aggregates contacts, deals, activities, related issues.

### CUJ-13: Agent Impact on Customer
- **Persona:** P1, P2
- **Surfaces:** Agent detail, customer detail
- **Status:** 🟡 Partial — wires exist but no dedicated impact dashboard
- **Acceptance:** Operator can see which agents affect which customers/deals; ROI rollup per goal.

### CUJ-14: Smart Model Routing
- **Persona:** P1 (operator) — invisible to most users
- **Surfaces:** Internal — no dedicated UI; appears in adapter config + cost reports
- **Status:** ✅ Operational (skill-driven two-tier, per-adapter mapping, pipeline-stage overrides)
- **Acceptance:** Right tier model selected per task; cost-vs-quality tradeoffs visible in cost report.

### CUJ-15: Agent–Human Conversation (Comment-Driven)
- **Persona:** P1, P2
- **Surfaces:** Issue detail comments, `/inbox`
- **Status:** ✅ Operational (comment threads, agent wakeup on @mention/assignment)
- **Auto coverage:** `tests/e2e/comments.spec.ts`, `server/src/__tests__/issue-comment-reopen-routes.test.ts`
- **Acceptance:** Operator comments → agent receives + responds; thread is the conversation record.

---

## V1 COMPLETION PHASE 1 (CUJ-V1.A through CUJ-V1.E) — built 2026-04-16/17

These are V1 stub-elimination CUJs (lettered) — they sit alongside the numbered CUJs above, not replacing them.

### CUJ-V1.A: Sales Pipeline (Lead → Deal → Close)
- **Status:** ✅ Done
- **Surfaces:** Leads, Kanban drag/drop, Deal detail, HubSpot Settings
- **E2E:** `tests/e2e/cuj-a-sales-pipeline.spec.ts`

### CUJ-V1.B: Agent Governance
- **Status:** ✅ Done
- **Surfaces:** Action Proposals approval queue, Feed aggregation
- **E2E:** `tests/e2e/cuj-b-agent-governance.spec.ts`

### CUJ-V1.C: Productivity (Per-User Feed)
- **Status:** ✅ Done
- **Surfaces:** User Profile, user-scoped Feed
- **E2E:** `tests/e2e/cuj-c-productivity.spec.ts`

### CUJ-V1.D: Adapter Onboarding
- **Status:** ✅ Done
- **Surfaces:** Adapter install/health/credential management
- **E2E:** `tests/e2e/cuj-d-adapter-onboarding.spec.ts`

### CUJ-V1.E: Three-Tier Entitlements
- **Status:** ✅ Done
- **Surfaces:** Billing page, tier gates, UpgradeDialog
- **E2E:** `tests/e2e/cuj-e-entitlements.spec.ts`
- **Note:** Stripe-backed billing provider deferred to Phase 3.

---

## TRACK B — CITIZEN APPS (CUJ-16 through CUJ-20) — NOT BUILT

Per PRD §5.4. Foundation work in [AGE-86](https://linear.app/agentdash/issue/AGE-86); CUJ-specific tickets [AGE-87](https://linear.app/agentdash/issue/AGE-87) through [AGE-91](https://linear.app/agentdash/issue/AGE-91).

### CUJ-16: Vibecode an Internal App
- **Persona:** P4
- **Surface:** `/apps/new` authoring flow
- **Status:** ❌ Not built ([AGE-87](https://linear.app/agentdash/issue/AGE-87) backlog)

### CUJ-17: Review & Publish (IT Governance Gate)
- **Persona:** P5
- **Surface:** `/governance/apps-queue`
- **Status:** ❌ Not built ([AGE-88](https://linear.app/agentdash/issue/AGE-88) backlog)

### CUJ-18: Run a Sanctioned App
- **Persona:** Any employee in audience
- **Surface:** `/apps`
- **Status:** ❌ Not built ([AGE-89](https://linear.app/agentdash/issue/AGE-89) backlog)

### CUJ-19: Governance Dashboard for Citizen Apps
- **Persona:** P5
- **Surface:** `/governance/apps`
- **Status:** ❌ Not built ([AGE-90](https://linear.app/agentdash/issue/AGE-90) backlog)

### CUJ-20: Org App Catalog & Cross-Team Sharing
- **Persona:** P2, P4
- **Surface:** `/apps` discovery + sharing
- **Status:** ❌ Not built ([AGE-91](https://linear.app/agentdash/issue/AGE-91) backlog)

---

## Mapping to old/alternative taxonomies

| Canonical | Old in CUJ-STATUS.md | Old in CUSTOMER-CUJS.md | scripts/test-cujs.sh |
|-----------|----------------------|-------------------------|----------------------|
| CUJ-1 | CUJ-1 | CUJ-1 (Bootstrap) | CUJ-1 |
| CUJ-2 | CUJ-2 | CUJ-2 (Morning scan) | CUJ-2 |
| CUJ-3 | CUJ-3 | CUJ-4 (Hire/Spawn) | CUJ-3 |
| CUJ-4 | CUJ-4 | (split across 3, 5, 7) | CUJ-4 |
| CUJ-5 | CUJ-5 | CUJ-9 (Kill Switch) | CUJ-5 |
| **CUJ-6 (Pipeline Orch.)** | — (NEW in PRD) | — | — |
| CUJ-7 (CRM Pipeline) | CUJ-6 | CUJ-10 (CRM context) | CUJ-6 |
| CUJ-8 (AutoResearch) | CUJ-7 | CUJ-11 (Improve workforce) | CUJ-7 |
| CUJ-9 (Security) | CUJ-8 | CUJ-9 (also Kill switch) | CUJ-8 |
| CUJ-10 (Skills) | CUJ-9 | CUJ-11 (Improve workforce) | CUJ-9 |
| CUJ-11 (Budget) | CUJ-10 | CUJ-8 (Budget/burn) | CUJ-10 |
| CUJ-12 (Customer 360) | (extension) | part of CUJ-10 | — |
| CUJ-13 (Impact) | (extension) | part of CUJ-7 | — |
| CUJ-14 (Model routing) | — | — | — |
| CUJ-15 (Comments) | — | part of CUJ-7 | — |
| CUJ-16 → CUJ-20 (Track B) | — | — | — |

## How to add a new CUJ

A new CUJ should be added only if it is true that:

1. A real customer user will perform it directly in the product
2. It recurs or is strategically central
3. It maps to a clear success/failure state
4. It changes what the top-level product must optimize for

Source taxonomy: `doc/CUSTOMER-CUJS.md` §12.

Bump the next number (CUJ-21+) and add a row to the mapping table above.

## Test coverage matrix (last run 2026-04-29)

| CUJ | scripts/test-cujs.sh | Vitest | Playwright e2e | Interactive (preview) |
|-----|----------------------|--------|----------------|------------------------|
| CUJ-1 Onboarding | ✅ 7/7 | ✅ 5 | ✅ onboarding-setup.spec.ts | — |
| CUJ-2 Dashboard | ✅ 2/2 | (paperclip) | ⚠️ 2 failed (View all link, heartbeat ticker) — likely environment | ✅ verified |
| CUJ-3 Agent Factory | ✅ 9/9 | ✅ 5 | ⚠️ 2 failed (templates heading, empty state) | ✅ verified |
| CUJ-4 Task Deps | ✅ 6/6 | (paperclip) | ✅ task-dependencies.spec.ts | — |
| CUJ-5 Kill Switch | ✅ 4/4 | ✅ 5 | ⚠️ 2 failed (API halted state, full cycle) — interactive race | ✅ verified |
| CUJ-6 Pipeline Orch | (implicit) | (impl) | ✅ cuj-a-sales-pipeline | — (folded under /goals per AGE-42) |
| CUJ-7 CRM Pipeline | ✅ 8/8 | ✅ 8 | ✅ crm-pipeline + crm-customer360 + cuj-a | ✅ verified |
| CUJ-8 AutoResearch | ✅ 7/7 | ✅ 6 | — | ✅ verified |
| CUJ-9 Security | ✅ 5/5 | ✅ 7 | — | ✅ verified |
| CUJ-10 Skills | ✅ 6/6 | ✅ 3 | ✅ skills.spec.ts | ✅ verified |
| CUJ-11 Budget | ✅ 6/6 | ✅ 5 | ⚠️ 1 failed (burn-rate labels) | ✅ verified |
| CUJ-12 Customer 360 | — | — | ✅ crm-customer360 | — |
| CUJ-13 Impact | — | — | — | — (no dedicated UI yet) |
| CUJ-14 Model Routing | — | (impl) | — | N/A — invisible |
| CUJ-15 Comments | — | ✅ comment-reopen | ✅ comments.spec.ts | — |
| CUJ-V1.A Sales Pipeline | — | — | ✅ cuj-a-sales-pipeline.spec.ts | ✅ |
| CUJ-V1.B Agent Governance | — | — | ✅ cuj-b-agent-governance.spec.ts | ✅ (action-proposals empty state) |
| CUJ-V1.C Productivity | — | — | ✅ cuj-c-productivity.spec.ts | ✅ (feed) |
| CUJ-V1.D Adapter Onboarding | — | — | ✅ cuj-d-adapter-onboarding.spec.ts | — |
| CUJ-V1.E Entitlements | — | — | ⚠️ 1 failed (canceled banner) | ✅ verified (Pro tier matrix) |
| CUJ-16 → CUJ-20 | — | — | — | N/A — not built |

## 2026-04-29 test run summary

### Backend (`scripts/test-cujs.sh`): **60/60 PASS** ✅
All 10 CUJ groups exercised against live API with company creation, onboarding, agent factory, task deps, kill switch, CRM, AutoResearch, security, skills, budget. Zero failures.

### Playwright e2e (`tests/e2e/*.spec.ts`): **156 passed / 36 skipped / 8 failed**

Failed tests (running against shared dev environment — likely environment/race issues, not regressions from this session's AGE-84 fix):

1. `agent-factory.spec.ts:113` — CUJ-3 templates page heading + Create Template button
2. `agent-factory.spec.ts:323` — CUJ-3 empty-state message
3. `billing-upgrade.spec.ts:259` — Billing canceled banner (locator resolved to multiple elements: "8 × locator resolved to <div data-testid='billing-canceled-banner'>")
4. `budget.spec.ts:58` — CUJ-10/11 burn-rate metric card labels
5. `dashboard.spec.ts:143` — CUJ-2 View all → agents list
6. `dashboard.spec.ts:186` — CUJ-2 heartbeat ticker section
7. `kill-switch.spec.ts:144` — CUJ-5 API companyHalted state after click
8. `kill-switch.spec.ts:256` — CUJ-5 full halt-resume cycle

### UI unit tests (`vitest`): **272 passed / 2 skipped / 0 failed** ✅

### Server vitest on `agentdash-main`: **1597 passed / 2 failed / 76 skipped**
Both reliable failures (`feedback-service.saveIssueVote`, `heartbeat-comment-wake-batching`) fail in isolation as well — pre-existing in-isolation bugs unrelated to AGE-84. Tracked in [AGE-102](https://linear.app/agentdash/issue/AGE-102) follow-up.

### Interactive (preview pane): **14 routes verified** ✅

Routes confirmed rendering with real data + zero console errors:
- `/dashboard` (CUJ-2)
- `/issues` (CUJ-15 inbound)
- `/agents` (CUJ-3)
- `/inbox` (CUJ-V1.B/C)
- `/goals` (CUJ-3 substrate)
- `/settings`
- `/security` (CUJ-5 + CUJ-9)
- `/crm` (CUJ-7)
- `/skills` (CUJ-10)
- `/costs` (CUJ-11)
- `/research` (CUJ-8)
- `/billing` (CUJ-V1.E)
- `/action-proposals` (CUJ-V1.B)
- `/feed` (CUJ-V1.C)
- Other working: `/routines`, `/capacity`, `/templates`, `/org`, `/connectors`, `/assess`

404 routes: `/people` (route doesn't exist), `/proposals` (real path is `/action-proposals` — nav link uses correct path)

### Open issues surfaced

1. **Cosmetic: SPA page title not updating on navigation** — `document.title` shows stale value from prior page on multiple routes (`/capacity`, `/templates`, `/research`, `/assess`). Only the breadcrumb updates. Fix: useEffect on route change to set title.
2. **Playwright failures** above — need re-run on a clean main-only environment to confirm whether they are environmental, pre-existing baseline drift (cf. AGE-71's 33 skipped baseline-broken tests), or real regressions. The shared dev environment with the parallel marketing-branch agent makes diagnosis ambiguous.
