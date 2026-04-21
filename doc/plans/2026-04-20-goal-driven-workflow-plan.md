# Goal-Driven Workflow — Product & Implementation Plan

Date: 2026-04-20
Status: Phase A shipped · Phase B+ design updated per ratified decisions (see §0)
Owner: @thetangstr
Related: `doc/GAPS.md`, `.omc/specs/deep-interview-agentdash-gtm-tech-deployment.md`, `doc/plans/2026-04-09-agentdash-gtm-plan.md`

---

## 0. Decisions ratified 2026-04-20

User corrections supersede anything below that contradicts them:

1. **Interview conductor: "Chief of Staff" agent — not CEO, not a fixed wizard.**
   - "Chief of Staff" is role-agnostic: can serve a CEO, product lead, head of marketing, etc. One agent pattern that adapts.
   - Replaces all "CEO agent" references in this plan. The existing `NewAgentDialog` "Ask CEO" path becomes "Ask Chief of Staff"; `role: "ceo"` plumbing → `role: "chief_of_staff"`.
   - Phase A default seed agent (if we seed one) is the Chief of Staff.

2. **Agent team proposals are bespoke per scenario — not templated.**
   - Drop the "hand-authored JSON archetype templates" plan. No fixed 4-agent rosters per archetype.
   - The Chief of Staff generates the AgentTeamPlan dynamically per user's situation. Strategy-doc quality is **A+ grade capability** — this is the product's core differentiator and must be evaluated accordingly.
   - `agent_plans.archetype` still categorizes the *goal shape* (revenue/acquisition/cost/support/content/custom) for filtering and telemetry, but does NOT select a static roster.

3. **Retire "Pipelines" as a top-level concept.**
   - No sidebar "Pipelines" tab, no "Playbooks" rename — the whole concept folds under Goals.
   - The **Business Goal page is the hub**: shows the agents assigned to that goal + **impact + ROI rollup** + the plan that spawned them.
   - DB `agent_pipelines` table stays (schema churn isn't worth it), but UI/nav/product copy never says "pipeline" except for the CRM sales pipeline.

These resolve Section 10 questions 1–4. Remaining sections kept for history; Phase B+ implementation should follow §0 when it contradicts later sections.

---

## 1. The problem in one paragraph

AgentDash has accumulated **13 discrete creation workflows** (Agent, Project, Pipeline, Goal, Routine, Issue, Action Proposal, Deal, Account, Contact, Lead, Connector, Onboarding). None of them starts from a business outcome; most create bottom-up primitives that never roll up to revenue, cost, or acquisition. A new user hitting the app has no obvious first move — "New Agent" opens an Issue dialog assigned to a CEO agent (`NewAgentDialog.tsx:83-90`), "New Pipeline" drops them into a 5-step technical wizard, "Goals" is buried at position #6 in the sidebar. The GTM plan says we sell "one operator running 2–5 agents on a real workflow with visibility" (`doc/plans/2026-04-09-agentdash-gtm-plan.md:18`). The product doesn't currently frame itself that way.

The fix is a single top-level narrative: **Goal → Plan → Agent Team → Work → Results.** Every creation flow below the Goal level becomes either an expert escape hatch or a sub-step of the plan generator.

---

## 2. Current-state workflow inventory (the "before")

### 2.1 Sidebar IA today (`ui/src/components/Sidebar.tsx`)

| # | Section | Label | Route | Purpose |
|---|---|---|---|---|
| — | top | New Issue | dialog | Opens generic issue dialog |
| — | top | Dashboard | `/dashboard` | Live run monitor |
| — | top | My Feed | `/feed` | Activity stream |
| — | top | Inbox | `/inbox` | Approvals + failed runs |
| 1 | Work | Issues | `/issues` | Issue list |
| 2 | Work | Routines (Beta) | `/routines` | Scheduled tasks |
| 3 | Work | Goals | `/goals` | OKR tree |
| 4 | Work | Pipelines | `/pipelines` | Multi-stage workflows |
| 5 | Work | Proposals | `/action-proposals` | Governance queue |
| — | Projects | (dynamic) | `/projects/:id` | Custom project containers |
| — | Agents | (dynamic) | `/agents/:id` | Agent roster |
| 6 | CRM | Deals, Kanban, Accounts, Contacts, Leads, HubSpot | `/crm/*` | Sales system |
| 7 | Governance | Budget, Capacity, Security, Research, Assess | `/*` | Controls + discovery |
| 8 | Company | Org, Templates, Connectors, Skills, Costs, Activity, Onboarding, Billing, Settings | `/*` | Admin |

### 2.2 Creation flows today (13 entry points)

| # | Flow | Trigger | Goal-anchored? | Notes |
|---|---|---|---|---|
| 1 | **New Agent** | Sidebar → `NewAgentDialog` → "Ask CEO" OR adapter picker → `/agents/new` | ❌ No | "Ask CEO" path reuses generic Issue dialog — UX leak |
| 2 | **New Project** | `SidebarProjects` → `NewProjectDialog` | ✅ Yes | Multi-select `project_goals` junction |
| 3 | **New Goal** | `Goals.tsx` → `NewGoalDialog` | ✅ Self | Hierarchical (parentId) |
| 4 | **New Issue** | Global New Issue button → `NewIssueDialog` | ⚠️ Partial | `issues.goalId` FK exists but rarely set |
| 5 | **New Pipeline** | `/pipelines/new` → `PipelineWizard` (5 steps) | ❌ No | No goalId column on `agent_pipelines` |
| 6 | **New Routine** | `/routines` → create dialog | ⚠️ Partial | `routines.goalId` FK exists, UI not surfacing it |
| 7 | **Onboarding** | `/setup` or `OnboardingWizard` | ✅ Partial | Step 1 asks "companyGoal" (single string) → creates 1 CEO agent + 1 seed issue. Doesn't produce a team. |
| 8 | **Assess / Research** | `/assess` → `AssessPage` | ✅ Yes | Collects pain/goals/systems; `research_cycles.goalId` required |
| 9 | **Welcome** | `/welcome` → `WelcomePage` | — | Marketing landing; no creation |
| 10 | **CRM: New Deal / Account / Contact / Lead** | `CrmPipeline.tsx`, `CrmLeads.tsx` | ❌ No | No goal linkage |
| 11 | **Action Proposal** | Agent-initiated (not human) | ❌ No | Approvals row; payload is JSONB |
| 12 | **Connector** | `/connectors` → provider OAuth | — | OAuth credential; no goal |
| 13 | **Execution Workspace** | `ExecutionWorkspaceDetail` | — | Infra; no goal |

### 2.3 Goal rollup plumbing that already exists

Good news — most of the FK wiring is already there:

| Entity | `goalId` FK? | Where |
|---|---|---|
| `issues` | ✅ nullable | `packages/db/src/schema/issues.ts:28` |
| `projects` | ✅ nullable | `packages/db/src/schema/projects.ts:12` |
| `routines` | ✅ nullable | `packages/db/src/schema/routines.ts:26` |
| `cost_events` | ✅ nullable | `packages/db/src/schema/cost_events.ts:17` |
| `finance_events` | ✅ nullable | `packages/db/src/schema/finance_events.ts:18` |
| `research_cycles` | ✅ required | `packages/db/src/schema/research_cycles.ts:12` |
| `agent_okrs` | ✅ nullable | `packages/db/src/schema/agent_okrs.ts` |
| `project_goals` | ✅ junction | many-to-many |
| `agent_pipelines` | ❌ **missing** | needs migration |
| `approvals` | ❌ **missing** | needs migration |
| `agents` | ❌ n/a | agents serve many goals |
| `heartbeat_runs` | ❌ n/a | derived via issue.goalId |
| CRM deals/accounts/leads | ❌ n/a | separate commercial domain |

### 2.4 What the OnboardingWizard does today (`ui/src/components/OnboardingWizard.tsx`)

Four steps that get us *partway* to goal-driven:
1. Company name + **single `companyGoal` free-text string**
2. CEO agent name + adapter picker
3. Seed task (hardcoded default: "Hire your first engineer and create a hiring plan")
4. Launch

The wizard creates: 1 company, 1 goal (companyGoal → root goal), 1 CEO agent, 1 project, 1 seed issue. It does **not** produce a team of agents, does not decompose the goal, and uses hardcoded copy regardless of what the user types as their goal.

---

## 3. The new top-level model

```
Company
  └─ Goal (business outcome: revenue↑, acquisition↑, cost↓, NPS↑, …)
      └─ Plan (agent team proposal, approved by human)
          ├─ Agents (hired to serve the goal)
          ├─ Playbooks (renamed Pipelines — multi-stage workflows)
          ├─ Routines (recurring cadences)
          └─ Issues (one-off work)
              └─ Runs (heartbeats, costs, outputs)
```

**Invariants we want to enforce:**
- Every **Issue / Pipeline / Routine / Cost Event** rolls up to exactly one Goal (or the system "Unassigned" pseudo-goal for expert-mode creations).
- Every **Agent** is hired *in service of* one or more Goals (many-to-many via a new `agent_goals` junction) — not bound to one, but its existence is justified by goals.
- Every **Goal** can show: (a) current progress vs target, (b) agent roster, (c) playbooks/routines assigned, (d) spend vs budget, (e) open issues.

---

## 4. The new goal-driven flow (the "after")

### 4.1 Signup → first value (interleaved with distribution Phase 1)

```
agentdash.com  →  Stripe Checkout  →  Workspace provisioned
                          ↓
             "Welcome — what outcome do you want to drive?"
                          ↓
          Goal Archetype picker (Revenue ↑ | Acquisition ↑ | Cost ↓ | Custom)
                          ↓
          Structured interview (5–7 questions per archetype)
                          ↓
          Agent Team Proposal generated (goal + 2–5 agents + 1–3 playbooks + budget)
                          ↓
                  [ Approve | Edit | Reject ]
                          ↓
               Agents, playbooks, first issues created
                          ↓
              Dashboard shows Goal at top with rollups
```

### 4.2 Ongoing usage

**Primary path** ("what 95% of users do"):
- Left nav top item: **Goals** (was position 3, now position 1 in Work).
- From a Goal → "+ Propose another team" → runs the same proposal flow for an adjacent workflow under the same outcome.
- From a Goal → "Edit team" → add/remove agents, playbooks, routines.
- Goal detail page shows live rollup: progress, agent count, open issues, budget burn, KR deltas.

**Expert escape hatches** (demoted but kept):
- `/agents/new` — direct adapter picker + config form. Still exists; removed from primary affordance.
- `/pipelines/new` → renamed **`/playbooks/new`** — direct 5-step wizard. Still there for users who know what they want.
- `+ New Issue` (global) — still there, but issue dialog now **requires** a goal picker (defaults to the company root goal).

### 4.3 Agent Team Proposal — the new artifact

A Proposal is a JSON bundle that, on approval, expands into a transaction across many tables:

```typescript
// packages/shared/src/agent-plan.ts (new)
interface AgentTeamPlan {
  goalId: string;                    // the business outcome this serves
  archetype: "revenue" | "acquisition" | "cost" | "support" | "content" | "custom";
  rationale: string;                 // why this team, in plain English
  proposedAgents: Array<{
    role: string;                    // e.g. "sdr", "researcher", "copywriter"
    name: string;
    adapterType: string;
    systemPrompt: string;
    skills: string[];
    estimatedMonthlyCost: number;    // for budget preview
  }>;
  proposedPlaybooks: Array<{         // multi-stage workflows (formerly "pipelines")
    name: string;
    stages: Array<{ role: string; instructions: string }>;
    triggerRoutine?: { schedule: string };
  }>;
  budget: {
    monthlyCapUsd: number;
    killSwitchAtPct: number;         // e.g. 100 = hard stop
  };
  kpis: Array<{                      // become KeyResult rows on approval
    metric: string;
    baseline: number;
    target: number;
    unit: string;
    horizonDays: number;
  }>;
}
```

On **Approve**, one transaction:
1. Insert agents (`agents` table)
2. Insert agent→goal links (`agent_goals` — new junction)
3. Insert playbooks (`agent_pipelines` with new `goalId`)
4. Insert routines (`routines.goalId` set)
5. Insert key results (`agent_key_results` via a new `agent_okrs` row keyed to this goal)
6. Insert budget policy rows scoped to this goal (existing `budget_policies` gains `goalId`)
7. Insert first set of seed issues
8. Log to `activity_log` with proposal ID for audit

### 4.4 Who runs the interview?

Two-tier approach (from the brainstorm):
- **Deterministic wizard** for the top 4 archetypes (Revenue / Acquisition / Cost / Support). Fixed 5–7 questions, fixed agent team templates. Ships first. Predictable. Demoable in 2 weeks.
- **CEO-agent-driven** for "Custom". Falls back to an interactive chat with the CEO agent that produces the same JSON at the end. Ships in Phase C once deterministic path is stable.

---

## 5. Schema changes

### 5.1 New tables

```typescript
// packages/db/src/schema/agent_plans.ts  (migration 0060)
export const agentPlans = pgTable("agent_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  goalId: uuid("goal_id").notNull().references(() => goals.id),
  status: text("status").notNull(), // "draft" | "proposed" | "approved" | "rejected" | "superseded"
  archetype: text("archetype").notNull(),
  rationale: text("rationale"),
  proposalPayload: jsonb("proposal_payload").notNull(), // AgentTeamPlan JSON
  proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id),
  proposedByUserId: uuid("proposed_by_user_id").references(() => users.id),
  approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("agent_plans_company_idx").on(table.companyId),
  index("agent_plans_goal_idx").on(table.goalId),
]);

// packages/db/src/schema/agent_goals.ts  (migration 0060)
export const agentGoals = pgTable("agent_goals", {
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.goalId] }),
  index("agent_goals_goal_idx").on(table.goalId),
]);
```

### 5.2 Column additions

```sql
-- migration 0061
ALTER TABLE agent_pipelines ADD COLUMN goal_id UUID REFERENCES goals(id);
ALTER TABLE approvals        ADD COLUMN goal_id UUID REFERENCES goals(id);
ALTER TABLE budget_policies  ADD COLUMN goal_id UUID REFERENCES goals(id);
CREATE INDEX agent_pipelines_goal_idx ON agent_pipelines(goal_id);
CREATE INDEX approvals_goal_idx       ON approvals(goal_id);
CREATE INDEX budget_policies_goal_idx ON budget_policies(goal_id);
```

All nullable for backfill compatibility (existing rows stay valid; new rows written with goalId).

### 5.3 Seed rows per company

- On company create, insert a system goal `company.default_goal_id = "Unassigned"` (level=company, status=active) so legacy/expert-mode creations can still land somewhere.

---

## 6. What we rip out or demote

| Surface | Action | Reason |
|---|---|---|
| `NewAgentDialog` "Ask the CEO" button | **Remove** | Reuses Issue dialog → UX leak. Goal-driven flow replaces it. |
| `NewAgentDialog` as primary entry point | **Demote** | Still available at `/agents/new` for experts; not in primary affordance. |
| Current 4-step `OnboardingWizard` | **Replace** | New flow = archetype picker → interview → proposal. |
| Hardcoded "Hire your first engineer" seed task | **Delete** | Irrelevant once proposal is tailored to goal. |
| Default CEO agent spawn | **Keep but gate** | Still created on company bootstrap; just not the entrypoint for "new agent." |
| `/pipelines/new` wizard (for everyone) | **Demote + rename** | Rename to `/playbooks/new`; primary path is "approve a plan", wizard is expert mode. |
| `NewPipelineWizard` stage editor | **Keep** | Still needed for custom workflows. |
| `ActionProposals` page | **Keep, extend** | Add support for `agent_team_plan` proposal type with richer preview card. |
| Generic "+ New Issue" without goal | **Tighten** | New Issue dialog defaults to current goal context; required field (defaulting to root "Unassigned"). |
| Sidebar "Pipelines" label | **Rename** to "Playbooks" | Frees "Pipeline" for CRM sales pipeline only. |
| `comingSoon` scaffolding on adapter registry | **Audit** | Most is already unset; remove the disabled-label branch if nothing uses it (separate cleanup). |
| `/assess` | **Fold into proposal flow** | AssessPage collects pain/goals/systems — becomes the "Custom archetype" interview surface. Standalone route stays for now. |
| `InviteLanding` adapter gating | **Already neutral** | Tests confirm no "coming soon" gating; leave alone. |

**Not removing:**
- Goals, Routines, Issues, Projects as entities — all stay; they're just reached through plans now.
- CRM entirely — it's a separate commercial domain; out of scope for goal rollup in this plan.
- Connectors, Skills, Secrets, Execution Workspaces — infra surfaces, unchanged.

---

## 7. Renames and terminology

| Old | New | Why |
|---|---|---|
| Pipelines (sidebar "Work" item) | **Playbooks** | "Pipeline" is overloaded: we have CRM Pipeline (Kanban) + Agent Pipelines (workflows). Rename the latter. |
| Pipeline Orchestrator (service name) | Playbook Orchestrator | Match product nomenclature. |
| `agent_pipelines` (table) | Keep table name | Rename UI-only to minimize migration churn; doc comment added. |
| Action Proposal | Action Proposal (kept) + **Agent Team Plan** (new sub-type) | "Proposal" becomes the umbrella; new type for team plans. |
| New Agent (primary CTA) | **Propose a Team** (from a Goal) | Reframes creation around outcome. |

---

## 8. Interaction with the distribution / Stripe / signup work (GAPS.md Phase 1)

The distribution spec (`.omc/specs/deep-interview-agentdash-gtm-tech-deployment.md`) slates **weeks 1–6** for Stripe + marketing + self-serve signup. Goal-driven onboarding must slot **after** Stripe Checkout and **before** the dashboard:

```
Marketing site (Next.js, weeks 3-5)
    ↓ "Start free"
Email + password + company name
    ↓
Stripe Checkout (wks 1-2 spec work)
    ↓ webhook: subscription.created
Workspace provisioned (hosted lane, Phase 2) OR local install (today)
    ↓
>>> Goal-Driven Onboarding (THIS PLAN) <<<
    ↓
Dashboard with Goal at top
```

**Dependencies this plan creates on distribution work:**
- Goal-driven onboarding must run in all three lanes (hosted / runner / BYOC) identically. Since it's just a React flow + server endpoints, this is free.
- API-key vault (Phase 2) must be ready **before** we recommend agent templates that burn tokens. If vault isn't ready, the plan proposal's budget preview needs a "bring your API key" gate.
- Usage metering (Phase 1/2 GAPS item) slots in as the backing for Goal-level spend rollup.

**Dependencies distribution work has on this plan:**
- The marketing site's pricing page should explain tiers in terms of **goals/agents/playbooks**, not "actions" or "compute". Coordinate copy with positioning doc.
- Stripe tier entitlements (`packages/shared/src/entitlements.ts`) should include `maxGoals` / `maxAgentsPerGoal` / `maxPlaybooksPerGoal` caps. Current entitlements are per-company only.

**Timeline compatibility check:**
- Distribution Phase 1 (wks 1–6) = Stripe + marketing + signup. Goal-driven work can land in **parallel** (different files mostly) targeting the same week-6 milestone: "anyone can sign up and produce value."
- Distribution Phase 2 (wks 7–18) = Hosted lane. Goal-driven flow benefits from having a workspace to provision agents into, but works without it (adapters still run on user's machine in local mode).

---

## 9. Phased delivery

### Phase A — Foundations (1 week)
- Migration 0060: `agent_plans`, `agent_goals`
- Migration 0061: `goalId` columns on `agent_pipelines`, `approvals`, `budget_policies`
- Seed "Unassigned" system goal on every existing + new company
- Service: `agentPlansService` (CRUD + approve transaction)
- Route: `POST /companies/:id/agent-plans`, `POST /agent-plans/:id/approve`
- Zod validators for `AgentTeamPlan` payload
- Tests: service unit, route integration, approval-expands-into-entities test

### Phase B — Goal-first onboarding (2 weeks)
- New `GoalOnboardingWizard` component (replaces `OnboardingWizard`)
  - Step 1: company name
  - Step 2: goal archetype picker (4 tiles + custom)
  - Step 3: structured interview (archetype-driven question set)
  - Step 4: generated proposal preview (editable)
  - Step 5: approve → launch
- Archetype templates in `packages/shared/src/goal-archetypes/` — hand-authored JSON for top 4 archetypes
- Keep old wizard accessible at `?legacy=1` query param for 1 release cycle
- E2E test: full signup → goal → approve → agents exist

### Phase C — Primary IA shift + Agent Team Proposal UI (2 weeks)
- Sidebar reorder: Goals moves to position 1 in "Work" section
- New `/goals/:id/propose-team` route with wizard
- Extend `ActionProposals` page: new proposal card variant for `agent_team_plan` showing agents + playbooks + cost preview
- Goal detail page: add "Team" tab (agents + playbooks + routines for this goal)
- Goal detail page: add "Spend" rollup (sum of cost_events where goalId=this)
- Demote/hide `NewAgentDialog` "Ask CEO" path; keep advanced picker

### Phase D — Renames + cleanups (1 week)
- Rename sidebar "Pipelines" → "Playbooks" (and route alias `/playbooks` → `/pipelines`)
- Rename "Pipeline Orchestrator" → "Playbook Orchestrator" in all user-facing copy (service names keep table names)
- Remove hardcoded seed task copy
- Update marketing copy refs
- Update `ARCHITECTURE.md` and `doc/PRD.md` to reflect goal-primary model

### Phase E — Rollups + observability (1 week)
- `GET /companies/:id/goals/:goalId/rollup` endpoint returning `{ spend, agentCount, openIssues, keyResults, budgetBurn }`
- Dashboard widget: top 3 goals by progress
- Goal detail page: progress chart (from key_results over time)
- Alert rule: Goal at 90% budget burn → inbox notification

**Total: ~7 weeks of engineering.** Can run in parallel with distribution Phase 1 (also 6 weeks). Phase B lands with the marketing-site launch so the "Tuesday signup, Wednesday value" narrative is real.

---

## 10. Decisions required from @thetangstr before Phase A starts

These are blocking — I need your calls:

1. **Goal archetypes — which 4 ship first?** My proposal: *Revenue growth / Customer acquisition / Cost reduction / Support ops*. Alternate: swap Support for Content ops, or for CRM Hygiene (which you mentioned as a beachhead in the GTM plan). Pick 4.

2. **Agent team templates — fixed or dynamic?** Recommend fixed hand-authored JSON per archetype for Phase B (ships in 2 weeks, predictable demo). Dynamic LLM-generated plans in Phase C+ via the CEO agent. OK?

3. **Rename Pipelines → Playbooks?** Yes/no. If yes, it's a one-day rename job in Phase D and I want it to happen before the marketing site launches. If no, we live with the "which pipeline?" confusion forever.

4. **Kill "Ask the CEO" path in NewAgentDialog?** Yes/no. Recommend yes — it's the #1 source of the UX inconsistency you flagged.

5. **Multi-goal per issue?** Today `issues.goalId` is singular. Some work serves multiple goals. Options: (a) keep singular, use parent goals to aggregate; (b) add `issue_goals` junction like projects have. Recommend (a) for simplicity — we can upgrade later.

6. **When do we onboard existing companies?** After Phase B lands, existing companies haven't been through the goal-first wizard. Options: (a) backfill prompt on first login; (b) leave legacy alone, new flow for new companies only. Recommend (a) — one-time modal, skippable.

7. **CRM scope.** Out of scope for rollup in this plan. Confirm you're OK with CRM deals *not* rolling up to Goals for now (separate commercial domain). We can revisit when a customer asks for "agent work → deal progression" attribution.

---

## 11. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Users reject the archetype picker ("my business doesn't fit any of these") | 4th option is "Custom" → CEO-agent interview. Plus archetypes are additive — user can run the wizard multiple times for multiple goals. |
| 2 | Agent team templates feel canned / generic | Templates are hand-authored for the top 4 archetypes by @thetangstr + one seed customer. We refine from actual pilot feedback. |
| 3 | Existing users confused by sidebar reorder | Show a one-time "What's new" tooltip on Goals nav item for first 2 weeks post-launch. |
| 4 | `agent_pipelines.goalId` backfill for existing rows | Nullable column, default null, legacy rows unaffected. `Unassigned` goal catches new creations that bypass plan flow. |
| 5 | Scope creep: "can goals also roll up to CRM revenue?" | Explicit out-of-scope in this plan. Revisit post-first-customer. |
| 6 | Renaming Pipelines breaks existing URLs / bookmarks | Keep `/pipelines` as a permanent redirect to `/playbooks`. Server route names unchanged. |
| 7 | Collision with Phase 1 Stripe work on `companies` + `entitlements` | Low — goal-driven work touches goals/plans/agents tables; Stripe work touches companyPlan + webhook routes. Coordinate at week-3 checkpoint. |
| 8 | CEO agent quality for Custom archetype is bad | Phase C ships *after* deterministic archetypes are proven. If CEO quality is poor, we ship Phase B only and park Custom until agent quality improves. |
| 9 | Budget preview in proposal is inaccurate | Phase 2 distribution work adds real usage metering; until then, preview uses adapter-reported token counts × published provider rates. Mark as estimate. |

---

## 12. Success criteria (how we know this shipped)

- [ ] A new signup on agentdash.com reaches a **working agent team** in ≤ 10 minutes without a sales call.
- [ ] The Goals page is the primary landing surface post-onboarding.
- [ ] 100% of new issues / playbooks / routines created post-launch have a non-null `goalId`.
- [ ] Goal detail page shows live rollup: spend, agent count, open issues, KR progress.
- [ ] `NewAgentDialog` "Ask CEO → Issue dialog" path is removed from primary affordance.
- [ ] Marketing site pricing page explains tiers in goal/agent/playbook units, not "actions."
- [ ] First pilot customer describes their work to a colleague as "I set a goal and AgentDash ran the team" — not "I configured agents."
- [ ] No regression in existing MAW: `/workon AD-123` still works; issues still route to assignees.

---

## 13. Open questions / deferred decisions

- How does the Goal-driven model interact with **CUJ-B governance** (action proposals for individual actions)? Same table or different? Recommend same (`approvals` + `type` discriminator), already wired.
- Do we expose goal archetypes as a **plugin** surface so enterprises can define their own? Deferred — post first 5 customers.
- **Multi-tenant safety:** goal archetype templates might reference specific adapters / skills — do they fall back gracefully if a customer's tier doesn't include that adapter? Needs a tier-aware template resolver in Phase B.
- **Billing rollup by goal** (so a customer can see "Goal X burned $240 this month"): columns exist (`cost_events.goalId`), reporting views don't. Defer to Phase E.
- **Localization of archetype interview questions:** deferred.

---

## Appendix A — Mapping old workflows to new

| Old workflow | New home |
|---|---|
| Sidebar "New Issue" | Still exists; dialog gains required goal field |
| `NewAgentDialog` "Ask CEO" | **Removed** |
| `NewAgentDialog` adapter picker | Moved behind Goal → "Edit team" → "+ Add agent" (expert) |
| `/agents/new` direct form | **Kept** as escape hatch |
| `/pipelines/new` wizard | Renamed `/playbooks/new`; demoted from primary |
| `/goals` list | **Promoted** to sidebar position 1 in Work |
| `/goals/:id` detail | **Expanded** with Team + Spend + KR tabs |
| `OnboardingWizard` | **Replaced** by `GoalOnboardingWizard` |
| `AssessPage` | Kept; becomes data source for Custom archetype interview |
| `ActionProposals` page | **Extended** with `agent_team_plan` card type |
| CRM creation flows | Unchanged |
| Connectors / Skills / Secrets | Unchanged |

---

## Appendix B — File-level change preview (not exhaustive)

**New files:**
- `packages/db/src/schema/agent_plans.ts`
- `packages/db/src/schema/agent_goals.ts`
- `packages/db/migrations/0060_agent_plans.sql`
- `packages/db/migrations/0061_goal_id_columns.sql`
- `packages/shared/src/agent-plan.ts` (types + zod validators)
- `packages/shared/src/goal-archetypes/revenue.ts` etc.
- `server/src/services/agent-plans.ts`
- `server/src/routes/agent-plans.ts`
- `ui/src/pages/GoalOnboardingWizard.tsx`
- `ui/src/pages/ProposeTeam.tsx` (goal detail → propose more team)

**Modified files (high-impact):**
- `ui/src/components/Sidebar.tsx` — reorder Work section, rename Pipelines → Playbooks
- `ui/src/components/NewAgentDialog.tsx` — remove "Ask CEO" branch; simplify to adapter picker
- `ui/src/components/OnboardingWizard.tsx` — deprecate, keep under `?legacy=1`
- `ui/src/pages/GoalDetail.tsx` — add Team, Spend, KR tabs
- `ui/src/pages/ActionProposals.tsx` — add `agent_team_plan` card variant
- `server/src/app.ts` — wire new routes
- `packages/db/src/schema/index.ts` — export new tables
- `packages/shared/src/entitlements.ts` — add goal/agent-per-goal caps
- `ARCHITECTURE.md`, `doc/PRD.md` — reflect goal-primary model

---

*End of plan. Please respond to Section 10 decisions before Phase A kicks off.*
