# PRD — Goal Creation, Onboarding, Chief of Staff, Chief Agent Officer

**Status:** Draft, 2026-04-22
**Owner:** Kailor Tang
**Scope:** AgentDash — the four user-visible surfaces that make the product feel like a company-shaped agent operating system: onboarding, goal creation, the Chief of Staff assistant, and the Chief Agent Officer.

---

## 1. Overview

AgentDash sells one promise: a single human operator (CEO / founder / department head) can set direction, and a fleet of AI agents does the work. Four surfaces carry that promise end-to-end:

- **Onboarding** — first-run setup that turns "an empty dashboard" into "a company shape with goals and agents".
- **Goal Creation** — how operators express what they want the company to achieve, and how those goals cascade into agent work.
- **Chief of Staff (CoS)** — the operator's conversational thinking partner. Right-side chat panel. Runs Socratic `/deep-interview` for goals, proposes plans, answers workspace questions.
- **Chief Agent Officer (CAO)** — a new dedicated role that owns the agent fleet: lifecycle, efficiency, wake cadences, priorities, budget consumption, incident response.

These four are not pipelines or templates in the old Paperclip sense — they are the load-bearing concepts of AgentDash. Every product decision in this PRD defers to them.

### Principles (non-negotiable)

- **No "Pipelines" top-level concept.** Work rolls up to **Goals**. Impact and ROI live on the goal page.
- **Agents are always autonomous.** No "mode toggle". They pause themselves when a human decision is required.
- **Agents are measured on job performance** (throughput, rework, $-per-task) — not on goal KPI attribution.
- **CoS handles humans. CAO handles agents.** Don't conflate.
- **Minimal abstractions.** Prefer wiring real things over vendored/curated layers.
- **Internal MAW stays internal.** The Multi-Agent Workflow is a dev tool for us, not a product surface.

---

## 2. Personas

| Persona | Who | Primary surface | Success feels like |
|---|---|---|---|
| **Operator** (CEO / founder / dept head) | The human paying for AgentDash | Goal page + CoS chat | "I told it what I wanted, and work got done." |
| **Board member** | Non-operator with read / approval rights | Dashboard + approvals | "I can see what the company is doing without asking." |
| **Admin** | Customer's IT / ops person | Onboarding + instance settings | "I got it deployed and connected, clean handoff." |
| **(Implicit) Chief of Staff agent** | Deployed agent, `role=chief_of_staff` | Runs under the hood | Operator rarely thinks about it as separate from AgentDash itself. |
| **(Implicit) Chief Agent Officer agent** | Deployed agent, `role=chief_agent_officer` (new) | Runs under the hood | Operator trusts the fleet to self-manage. |

Notes:
- Operator and Board member collapse to the same account type today (`board` role).
- Admin persona may be the same human as Operator in the small-team case.

---

## 3. Onboarding

### 3.1 Goals
- Take a human from "nothing" to "a company with goals and at least one CoS agent and one working agent" in **≤ 15 minutes**.
- Never force CLI / terminal commands for the Operator persona. Admin tasks (deploy, bootstrap) can still be CLI.
- Leave behind: company row, goals, CoS agent, ≥1 worker agent, connected adapter authentication for all of them.

### 3.2 Non-goals
- Full multi-department scaffolding. That's a later "grow your company" flow.
- Security policy setup in the first run. Defer to "before inviting others".

### 3.3 Flow

```
Admin path                       Operator path
-----------                      --------------
1. Install AgentDash             A. Log in, accept invite
2. Bootstrap first board user    B. "Set up your company" wizard opens
3. Share invite link             C. Answer 3-5 questions about the business
                                 D. Paste / link a description (website, Notion, deck)
                                 E. Review extracted context (industry, team, stack)
                                 F. Name 1-3 initial goals
                                 G. Pick CoS adapter (Claude Code / Codex / Gemini)
                                 H. Complete → dashboard with goals + CoS ready
```

### 3.4 Requirements
- **F-On-1.** The wizard auto-creates a `chief_of_staff` agent at completion. Default adapter is whichever one the Operator authenticated.
- **F-On-2.** Operator authentication for adapters happens inside the wizard (AGE-54.1 style in-app OAuth for Claude Code, Codex, Gemini) — no terminal.
- **F-On-3.** Extracted context from pasted docs is editable before commit. Nothing is auto-saved until the Operator clicks "Looks right".
- **F-On-4.** Wizard is interruptible and resumable — close the tab and re-open without losing state.
- **F-On-5.** Empty-state hints show up on `/goals`, `/agents`, `/inbox` for 24h post-onboarding (covers AGE-40 polish).
- **F-On-6.** If the Admin deploys in "managed" mode, steps A–H above collapse to one URL the customer visits after we've already done 1–3.

### 3.5 Open questions
- Should the wizard create a **CAO** agent automatically, or only after the operator has ≥2 worker agents? (See §6.)
- Pricing trial starts at wizard-complete, or at first chat send? (Pricing memo is open — do not hardcode.)

---

## 4. Goal Creation

### 4.1 Concept
A **Goal** is the unit of operator intent. It owns:
- Title, description, archetype (revenue / acquisition / cost / support / content / custom)
- Target KPIs (`goal_kpis` table — manual values per AGE-45)
- A **proposed plan** (generated by CoS), which becomes an approved plan, which seeds issues / projects / agent assignments
- An impact & ROI summary (computed from linked issues' activity + cost data)

No "Pipelines" term, anywhere. Work linked to a goal is expressed as issues and the plan that generated them.

### 4.2 Goals (meta)
- Operator can create a goal in < 60 seconds, OR spend 10 minutes doing a deep-interview if they want help.
- Goals are always editable; approved plans are mutable until execution is in flight.

### 4.3 Flow

**Fast path (<60s)** — operator already knows what they want:

```
Click "New goal" → modal with {title, archetype, target KPI?} → Save
```

**Guided path (5-10 min)** — operator wants help shaping it:

```
Click "New goal" → "Not sure yet? Run a deep-interview" →
  Opens Chief of Staff chat with a seeded /deep-interview prompt →
  CoS asks 3-5 Socratic questions one at a time →
  CoS calls submit_goal_interview({goalId, payload}) →
  A proposed plan appears on the goal page for operator approval.
```

The guided path is what the right-side chat panel was always going to power. AGE-50 Phase 4b wired the seed-message plumbing; AGE-53/54 got the SSE stream working end-to-end.

### 4.4 Requirements
- **F-Goal-1.** Both paths land the same shape: `goals` row + optional `agent_plans` row with `status=proposed`.
- **F-Goal-2.** `submit_goal_interview` is idempotent — if a plan is already `expanded` or `approved`, the tool refuses rather than overwriting. (Already implemented AGE-50 Phase 4a.)
- **F-Goal-3.** Operator approval on a proposed plan cascades into issue creation and agent assignment. No orphan plans.
- **F-Goal-4.** Goal page shows: target KPI, current KPI, linked issues, linked plan, impact summary (see §7), and **which agents are working toward it**.
- **F-Goal-5.** Goal KPI attribution is **display-only**; it does not influence agent performance scores (§7.2).

### 4.5 Non-requirements
- Templated goals ("pick from a library"). Out of scope. Bespoke is the whole point of the CoS-driven guided path.
- Sub-goals with independent lifecycles. Keep parent/child relationships but do not model child goals as full standalone entities yet.

---

## 5. Chief of Staff Assistant

### 5.1 Concept
The Chief of Staff is:
- A deployed agent with `role=chief_of_staff` (one per company).
- The thing behind the right-side chat panel labeled "Chief of Staff".
- The human's thinking partner — not the agent fleet's manager (that's the CAO).

### 5.2 Goals
- Operator can have a useful conversation about goals, agents, pipelines-of-work, or workspace state without leaving the current page.
- CoS can invoke server tools (goal / agent / KPI / deep-interview) on the operator's behalf, surfaced as inline tool cards.

### 5.3 Surface
- Right-side slide-over, labeled "**Chief of Staff**" (renamed from "Assistant" in this PR).
- Header shows the CoS agent name if configured; empty-state invites the operator to talk.
- Conversation is **company-scoped**. Switching companies closes the panel and resets state (shipped in this PR).
- "New chat" button starts a fresh thread without closing the panel.

### 5.4 Requirements
- **F-CoS-1.** Chat streams via SSE; chunks are `text`, `tool_use`, `tool_result`, `error`, `done`.
- **F-CoS-2.** Tool calls render as collapsible inline cards, not as raw JSON dumps.
- **F-CoS-3.** CoS has these tools: `create_agent`, `list_agents`, `create_issue`, `list_issues`, `set_goal`, `get_dashboard_summary`, `update_kpi`, `submit_goal_interview`. (Current set, AGE-50/53.)
- **F-CoS-4.** CoS routes through the company's `chief_of_staff` agent's own adapter — no separate `ASSISTANT_API_KEY`. It inherits the operator's OAuth / subscription auth. (Shipped in AGE-53 PR #33.)
- **F-CoS-5.** Adapter failures surface as **actionable** error text, never raw stderr or CLI crash dumps. (Shipped in AGE-54 follow-up.)
- **F-CoS-6.** The panel is seeded by other UI components (e.g., `PlanApprovalCard` seeds `/deep-interview` on a goal). Seed is consumed once and cleared.
- **F-CoS-7.** Conversation history persists per `(user, company)` and is re-fed into the adapter on each turn so the CoS has continuity.

### 5.5 Non-requirements
- Multi-CoS per company. One `chief_of_staff` agent per company; additional advisors belong under different roles.
- Mode toggles (autonomous vs. conversational). See principles — agents are always autonomous.

### 5.6 Known limits to fix
- The CoS agent **must** have a working adapter configured. If adapter auth is missing, the Operator should see "Sign in to [adapter]" not a cryptic CLI stack trace. Partly addressed by AGE-54.1 in-app Codex login.
- Tool-call invocation via prose markers (`TOOL_CALL: … END_TOOL_CALL`) is a workaround. Longer-term, structured tool-use via adapter-native event types.

---

## 6. Chief Agent Officer (CAO)

### 6.1 Concept
A **new** top-level agent role: `chief_agent_officer`. Responsible for **the agent fleet**, not for the operator's goals. Where CoS is a thinking partner, CAO is an ops manager.

Why introduce it now: as soon as there are more than ~3 working agents per company, operators don't want to hand-tune heartbeat intervals, wake cadences, priorities, and budgets. The CAO owns that layer so the Operator doesn't have to.

### 6.2 Scope of ownership (what the CAO decides)

- **Lifecycle** — propose new hires, pause underperformers, retire idle agents, escalate terminations to Operator approval.
- **Priority** — which agent picks up which issue when multiple are unblocked. Current code has primitive round-robin; CAO replaces it with intent-weighted ranking.
- **Wake cadence / heartbeat** — tune `heartbeatIntervalSec` per agent based on recent activity and SLA.
- **Budget** — watches per-agent and per-company monthly spend; throttles or pauses before hard-stop limits.
- **Efficiency metrics** — surfaces throughput, rework rate, $/task per agent. **Not KPI attribution.** (See §7.2.)
- **Incident response** — reacts to adapter outages, stuck runs, and stale sessions by pausing or retrying.
- **Fleet composition reports** — weekly: who's overworked, who's idle, who's expensive, who's slow.

### 6.3 What the CAO does **not** do

- Decide what the company's goals are. (Operator + CoS.)
- Take credit for or be graded against Operator KPIs (revenue, MQL, CSAT). (See §7.2.)
- Directly execute domain work. CAO is an **orchestrator**, not a worker.

### 6.4 Surface

- **`/agents` page** gains a "Fleet" overview section owned by the CAO: heat map of agent status, recent throughput, cost trend, idle vs busy ratio.
- A **CAO card** on the dashboard that summarizes one actionable decision per day ("Hire a second QA?", "Pause Research Agent 2 — idle 10 days", "Budget trending 15% over on Acquisition").
- A **CAO tab** in the existing `ChatPanel`? — **deferred**. First release: CAO speaks via dashboard cards and approval items, not a second chat panel. Re-evaluate after usage data.

### 6.5 Agent-row data model changes

- Extend `AGENT_ROLES` with `chief_agent_officer`.
- Extend `AGENT_ROLE_LABELS` with `"Chief Agent Officer"`.
- Default instructions bundle (`SOUL.md` / `AGENTS.md` / `HEARTBEAT.md` / `TOOLS.md`) tailored to fleet-ops.
- **Permissions scaffolding** — CAO needs: `canCreateAgents`, `canPauseAgents`, `canAdjustBudgets`, `canAdjustHeartbeats`. Today only the first exists; the rest are new permission keys.

### 6.6 Requirements

- **F-CAO-1.** One and only one `chief_agent_officer` per company.
- **F-CAO-2.** Created automatically during onboarding **only if** the operator hired ≥ 2 worker agents. Otherwise offered as a first-class "Hire a CAO" prompt when the fleet reaches 3 agents.
- **F-CAO-3.** CAO actions that change fleet state (pause / retire / re-budget) must route through the existing **approval system** — no silent changes.
- **F-CAO-4.** CAO sees per-agent metrics via the same service layer the `/agents` page uses; no new privileged API.
- **F-CAO-5.** CAO instructions explicitly forbid claiming goal KPI attribution. Its scorecard is fleet health, not business outcomes.
- **F-CAO-6.** Operator can disable the CAO (revert to manual fleet ops). When disabled, the CAO card on the dashboard becomes "Enable CAO" with a one-liner value prop.

### 6.7 Open questions

- Does CAO have write access to agent `instructionsBundle` (prompt tuning)? Bias says **no** for v1 — that's operator territory.
- Should CAO manage *inter-agent* delegation (when Agent A should hand off to Agent B)? Interesting but probably v2.
- Do we name-swap: rename the existing `role=assistant` legacy slot to something else, so the terminology is fully consistent? (See §8 migration.)

---

## 7. Cross-cutting

### 7.1 Naming and terminology (binding)

| Term | Meaning | Do NOT confuse with |
|---|---|---|
| **Chief of Staff** | Operator's thinking partner, runs CoS chat | The right-side panel; they're the same thing |
| **CAO / Chief Agent Officer** | Agent-fleet ops manager | CoS, Operator, admin |
| **Assistant** | Reserved for the *identity mode* on `openclaw_gateway` agents ("agent inherits triggering user's OAuth"). **Not** a human-facing role or a chat panel. | CoS — rename has shipped; do not reintroduce "Assistant" as a CoS label. |
| **Goal** | Unit of operator intent | Pipeline, initiative — neither exist as top-level. |
| **Pipeline** | Internal term for orchestrator logic; **not a user-facing word**. | Goal, workflow. |

### 7.2 Measurement

- Agents are scored on **job performance**: throughput, rework rate, $/task, SLA adherence.
- Agents are **not** scored on goal KPI attribution (MRR, MQL, CSAT, …). Attribution is a display-only concept shown on the goal page.
- CAO's own scorecard is fleet health (see §6.5), not goal KPIs.

### 7.3 Permissions

- Operator: full write on goals, hires CoS and CAO.
- CoS agent: read on workspace state; write via its 8 defined tools only.
- CAO agent: read on agent metrics; write via approval-gated fleet actions.
- Board members: read on dashboard + approval participation, no adapter authentication required.

### 7.4 Observability

- Every CoS and CAO tool call logs to `activity_log` with `actor_kind=agent`.
- Every adapter failure that surfaces to the chat panel also logs to the server log with `errorMessage` and `stderrTail` (already implemented).

### 7.5 Internationalization / accessibility

Out of scope for this PRD. Track separately.

---

## 8. Migration & phasing

### Phase 0 — Already shipped (this PR #33)
- Right-side chat routes through CoS agent's adapter (AGE-53).
- SSE disconnect bug fixed; UI hardening; "Chief of Staff" rename.
- `submit_goal_interview` tool live.
- Identity Mode toggle on agent config now persists.
- In-app Codex OAuth login block (AGE-54.1).

### Phase 1 — Goal & onboarding polish (2-3 weeks)
- `F-On-5` empty-state hints on /goals, /agents, /inbox.
- `F-On-1` onboarding auto-creates CoS agent at wizard completion.
- `F-Goal-4` goal page shows "which agents are working on this".
- CAO role constant added (`chief_agent_officer`) but **no** CAO agent auto-created yet.

### Phase 2 — CAO v1 (4-6 weeks)
- Fleet overview on `/agents` (read-only for Operator, CAO agent sees same data).
- CAO dashboard card with "one actionable decision/day".
- New permissions: `canPauseAgents`, `canAdjustBudgets`, `canAdjustHeartbeats`.
- Approval-gated CAO actions for fleet changes.
- `F-CAO-2` hiring prompt at 3 agents.

### Phase 3 — CAO v2 (later)
- Inter-agent delegation rules.
- CAO-driven skill proposals.
- Revisit: CAO conversational surface (second tab in chat panel?).

### Legacy cleanup
- `role=assistant` — deprecated slot used for pre-CoS wiring. Migrate existing rows to `role=chief_of_staff` where applicable, or archive. (Work already landed in AGE-53 conversation-repointing logic; complete the cleanup here.)
- "Assistant" identity-mode label on `openclaw_gateway` stays — that's a real distinct concept (OAuth impersonation) that predates the chat panel.

---

## 9. Open questions (decisions needed before Phase 2)

1. **Pricing trigger** — does CAO count as a separate "agent" for usage-based billing, or is it bundled with the company plan? (Pricing memo still open.)
2. **Multi-operator companies** — if a company has two board-level humans, does each get their own CoS thread, or do they share one? Current: shared. Probably fine; revisit if complaints.
3. **CoS ↔ CAO interaction** — when operator asks CoS "my fleet looks slow, what do I do?", should CoS delegate to CAO, or answer directly from read-only data? Recommendation: **delegate** via a `consult_cao` tool. Needs design.
4. **CAO kill-switch** — should the Operator be able to revoke CAO entirely mid-session? (If yes, a pause is easier than a delete.)
5. **Audit** — do we need a dedicated "CAO decision log" surface, separate from activity log? Probably yes for enterprise sales, probably no for early users.

---

## 10. Out of scope

- Multi-Agent Workflow (MAW) — internal dev tool, not a customer surface.
- Plugin marketplace — different PRD.
- Instance-level admin (OAuth providers, SSO, audit exports) — Admin persona, different PRD.
- Goal dependency graph visualisation — defer.
- Real-time fleet visualization / "war room" view — defer to Phase 3.

---

## Appendix A — Relationship diagram

```
                        ┌────────────────────┐
                        │     Operator       │
                        │  (human, board)    │
                        └─────────┬──────────┘
              "what do I want?"   │   "is my fleet OK?"
                                  │
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
   ┌────────────────────┐                  ┌────────────────────┐
   │  Chief of Staff    │                  │Chief Agent Officer │
   │  (role: cos)       │  "fleet health?" │(role: cao)         │
   │  Right-side chat   │◀────────────────▶│Dashboard cards,    │
   │                    │  via consult_cao │approval items      │
   └─────────┬──────────┘                  └─────────┬──────────┘
             │ tools                                 │ approval-gated
             │ (set_goal, submit_goal_interview,     │ (pause, budget,
             │  update_kpi, create_agent, …)         │  heartbeat, hire)
             ▼                                       ▼
      ┌──────────────┐                       ┌──────────────┐
      │   Goals      │                       │ Agent fleet  │
      │  + proposed  │ ───── issues ────▶    │ (engineers,  │
      │   plans      │                       │  PMs, QA, …) │
      └──────────────┘                       └──────────────┘
```

## Appendix B — Where things live in code (today)

| Concept | Code |
|---|---|
| Onboarding wizard | `ui/src/components/OnboardingWizard.tsx`, `server/src/services/onboarding.ts` |
| Goal creation | `ui/src/components/NewGoalDialog.tsx`, `server/src/services/goals.ts` |
| Proposed plans | `server/src/services/agent-plans.ts`, `ui/src/.../PlanApprovalCard.tsx` |
| CoS chat panel | `ui/src/components/ChatPanel.tsx`, `server/src/routes/assistant.ts`, `server/src/services/assistant.ts`, `server/src/services/assistant-llm-adapter.ts` |
| CoS tools | `server/src/services/assistant-tools.ts` |
| Agent roles (add CAO here) | `packages/shared/src/constants.ts` (`AGENT_ROLES`, `AGENT_ROLE_LABELS`) |
| Default instructions bundles (add CAO bundle here) | `server/src/services/default-agent-instructions.ts` |

---

_This PRD is intentionally trimmed — it names the load-bearing decisions and defers implementation detail. Follow-up issues per §8 phase list._
