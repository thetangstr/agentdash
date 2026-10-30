# Agent Performance Management — gate 1 build spec ("see what's true today")

Status: **authorized for implementation by Yang on October 29, 2026** ("ok. create LLD and build it").
Yang accepted the recommendations on LLD open items 2–6. Item 1, the real responsibility for the
paper walkthrough, is still open. It is needed before gate 3, not gate 1.

Worktree: the build worktree. Branch: `claude/agent-performance-mgmt`,
from `origin/main` at `c625911`.

Design sources:
- `doc/plans/2026-10-29-agent-performance-management-lld.md`: §9 gate 1, and §0–3 for context.
- `doc/plans/2026-10-29-agent-access-lld.md`: §2 (today's mechanisms), §3.3 (states), §6 (host), §8–9.
- `doc/plans/2026-10-29-agent-evaluation-lld.md`: §1, §6.2, §11.
- `DESIGN.md`: UI rules.

The frozen contract types live in `packages/shared/src/types/agent-performance.ts`, already exported
from `@paperclipai/shared`. Do not change them without asking the orchestrator. If a field can't be
filled honestly, return null or `unknown` with a note rather than inventing a value.

## Invariants (every builder)

1. **Read-only.** No migrations, no new tables or columns, no writes of any kind on the new routes:
   no activity rows, no evaluator snapshots, findings or review items. A test proves this (§Tests).
2. **Company-scoped.** Every query filters by `companyId`. Cross-company reads return 404, matching
   `agentVisibilityParam`.
3. **No grants, no scores.** Nothing here changes access or produces a composite score. Unknown is
   null or `"unknown"`, never 0.
4. **One UX.** No `productProfile` or `agentdash_mk` checks in `ui/src`. Server-side profile facts
   (for example "governance runs only for MK") are reported as data.
5. **Reuse existing services and helpers.** Examples: `agentVisibilityParam`,
   `assertCompanyAccess`, the accountability and ownership helpers, `accessService`, the connector
   resolution logic, the routines cron utilities. If a helper writes or has side effects, don't
   call it; read the tables directly instead.
6. **Separate loaders from pure builders.** A loader `load…Input(db, …)` gathers rows; a pure
   function `build…(input)` produces the contract. Unit-test the pure builders with plain fixtures.
7. **Code style.** Match the surrounding code: comment density, naming, and the
   `// AgentDash:` comment convention.
8. **Git.** Don't commit, push, stash, switch branches or touch any other worktree, and especially
   not the `codex/acceptance-criteria-enforcement` checkout. No `pnpm install`; dependencies are
   already installed.

## Authorization for the new routes

| Route | Board actor | Agent actor |
| --- | --- | --- |
| `GET /api/companies/:companyId/agents/:agentId/access` | Company access, the agent visible to the viewer, **and** the viewer is a company admin/owner, an instance admin, the agent's `accountableUserId`, or its active steward. Otherwise 403. | 403 |
| `GET /api/agents/me/access` | 403 | The calling agent's own inventory |
| `GET /api/companies/:companyId/agents/:agentId/profile` | Company access and the agent visible to the viewer | 403 |
| `GET /api/agents/me/profile` | 403 | The calling agent's own derived profile |
| `GET /api/companies/:companyId/evaluation/agents/:agentId/projection?windowDays=N` | Same as `/access` | 403 |

- `windowDays`: integer 1–365, default 30. `asOf` is the request time. The window is `[asOf − N days, asOf]`.
- An evaluator principal is a read-only agent. It gets 403 on these routes in gate 1.

## Builder A — access inventory and prompt surfaces

**Owns:**
- `server/src/services/agent-access-inventory.ts` (loader and builder)
- `server/src/routes/agent-access.ts` (replace the stub)
- `server/src/__tests__/agent-access-inventory.test.ts`
- `server/src/__tests__/agent-access-routes.test.ts`
- `server/src/onboarding-assets/default/AGENTS.md`
- `server/src/services/agent-creator-from-proposal.ts`, the `renderAgents` prompt surface only

**Build `AgentAccessInventory`** from today's real mechanisms. Access LLD §2 is the map; verify each
item in code before reporting it.

- **See:**
  - The company boundary (enforced).
  - Non-restricted projects as one item with a count. Enforcement is `partial`, with the note "API
    reads only; run context and export are not checked", and gap `RUN_CONTEXT_UNCHECKED`.
  - Each restricted project the agent can or can't read through `project_access` or lead.
  - Each connection the agent can resolve (own, workspace-visible, and document providers through
    the steward). `working` comes from the connection's status; the provider and data-scope
    ceilings are `profile_only`.
  - Agent memory privacy.
  - If the agent's role can export the company (CEO), gap `EXPORT_UNSCOPED`.
- **Do:**
  - Granted permission keys, including the legacy `canCreateAgents` and the role default.
    `tasks:assign_scope` gets gap `UNREAD_PERMISSION_SCOPE` if granted.
  - Each connector's draft and send autonomy (workspace default → connection → agent override).
    HubSpot writes always file `connector_send`.
  - Skill self-add: unrestricted, `not_enforced`, gap `SELF_ADD_SKILLS`.
  - Runtime skill mentions: gap `RUNTIME_SKILL_MENTIONS`.
  - Capabilities self-edit: gap `SELF_EDIT_CAPABILITIES`.
  - The governance policy: if the company is on the MK profile, its effective fields; otherwise
    gap `GOVERNANCE_PROFILE_ONLY`.
  - Active mandates where this agent is the grantee: scope, cap and expiry, `partial`.
- **Talk:**
  - Assigning, mentioning and handing off to agents, each with a target count of all agents, plus
    gap `WAKE_ANY_AGENT` where unrestricted.
  - Questions to people, with gap `ASK_ANY_MEMBER`.
  - External sends: HubSpot through approval; Gmail and Slack are not available to agents.
  - Inbound: who can assign to this agent.
- **Spend:**
  - The monthly budget and hard stop; `working` shows spent versus budget.
  - The MK governance budget, where it applies.
- **Used:** counts from `activity_log` in the window where the actor is this agent, mapped to
  items where the mapping is clear. Refusals (`authz.refused` or the real action name) are grouped
  by code. If a use can't be mapped, don't count it as an item's use.
- **`alwaysReachable`:** the accountable user, the active steward and the company admins.
- **`hostEnvironment`:**
  - Local adapters (`*_local`, `process`) get `kind: "local_host"`.
  - `hostPermissionsRestricted: false` when prompts are skipped, which is the claude_local default
    `dangerouslySkipPermissions`; check `adapterConfig`.
  - `defaultEnvironmentId` set gives `managed_environment`.
  - Gap `HOST_UNRESTRICTED` when not restricted.
- **`gaps`:** always include `PROFILE_NOT_DEFINED`.

**Prompt surfaces** (AGENTS.md "Adding Agent-Facing Features"):
- In `onboarding-assets/default/AGENTS.md`, add a named block
  `<!-- AgentDash: access-self-view -->`. It tells agents they can read their own access at
  `GET /api/agents/me/access` and their derived profile at `GET /api/agents/me/profile`. Both are
  read-only, and neither grants anything.
- Correct the existing instruction near "governance" that sends agents to a route they can't read.
- Add one short matching line, or a comment, in `renderAgents`.
- Keep the wording adapter-neutral: HTTP endpoints and JSON field names.

## Builder B — derived profile and performance projection

**Owns:**
- `server/src/services/agent-profile-derived.ts`
- `server/src/services/agent-performance-projection.ts`
- `server/src/routes/agent-performance.ts` (replace the stub; it serves `/profile`, `/me/profile`
  and `/projection`)
- `server/src/__tests__/agent-profile-derived.test.ts`
- `server/src/__tests__/agent-performance-projection.test.ts`
- `server/src/__tests__/agent-performance-routes.test.ts`

**`AgentProfileDerived`** (overview LLD §3.3):
- Identity comes from the agent row.
- Responsibilities and KPIs come from the confirmed `agent_plan_proposal_v1` card whose
  `confirmedAgentIds` includes the agent. Find how plan entries map to confirmed ids; if the
  mapping is ambiguous, say so in `gaps`.
- The objective comes from the workforce enrollment.
- Routines and triggers come from routines assigned to the agent; the heartbeat from
  `runtimeConfig.heartbeat`.
- Also: skills, adapter and model, `reportsTo`, `accountableUserId`.
- Every field carries `provenance` (`proposed` or `missing`) and its `source`.
- Gaps always include `NO_STRUCTURED_OBLIGATIONS` (unless every responsibility maps to a routine),
  `NO_CRITERIA`, `NO_ACCESS_REQUEST` and `NO_STYLE`.

**`AgentPerformanceProjection`** (evaluation LLD §6.2; gate 1 reads live tables):

- **Q1, work owed:**
  - For each trigger of each routine assigned to the agent, count `owedInWindow` from the CURRENT
    cron and timezone using the existing cron utilities. Disabled triggers, and webhook or API
    triggers, get null with a note.
  - Count routine run statuses and linked-issue outcomes in the window.
  - Count issues currently assigned to the agent, by status.
- **Q2, quality:**
  - Count verdicts in the window on issues currently assigned to the agent, by outcome.
  - Judge type: a person (a real, non-synthetic user); an independent agent (a reviewer agent
    other than this agent); or not independent (the agent itself).
  - Add gap `ATTRIBUTION_CURRENT_ASSIGNEE`.
- **Q3, the four facts kept separate:**
  - `automated` = verdicts passed by an independent agent.
  - `human` = verdicts passed by a person.
  - `use` = null, note "No use records yet".
  - `outcome` = null, note "Goal metric history arrives in gate 3".
  - `accountable`: the projects whose `leadAgentId` is the agent and the goals it owns, with their
    status. Where an `evaluation_scorecards` row exists, cite the latest stored card's O1, O2, O3
    and O5 values with that card's version in `note`. Otherwise `outcome: null`, note "No
    evaluator card".
- **Q4, cost:**
  - `cost_events` spend for the agent in the window.
  - `heartbeat_runs` by status; `withoutIssue` = runs with no `contextSnapshot.issueId`.
  - People proxies: questions this agent asked people in the window (issue thread interactions),
    how many were answered, and the median minutes to answer.
  - `humanCorrections` = `agent_corrections` for the agent in the window that are not
    `harness_evaluation`.
- **Q5, bounds:** refused attempts in the window, grouped by code.
- **Q6, decisions:** pending approvals the agent requested, and open questions to people.
- **`withheld`:** always list `{ section: "paired-harness assessments", reason: "Shown once evidence access rules ship (gate 3)" }`.
- `throughSeq` = the highest `evaluation_events.seq` for the company, or null.

## Builder C — UI

**Owns:**
- `ui/src/api/agent-performance.ts`
- `ui/src/components/agent-performance/*`
- tests next to them
- the minimal edits to `ui/src/pages/AgentDetail.tsx` that add three top-level tabs, `Profile`,
  `Access` and `Performance`, to `AGENT_DETAIL_TOP_TABS`, plus the `AgentDetailView` union and the
  tab rendering.

Follow the existing API client, query and component patterns. Reuse the existing tokens and
primitives (Card, Badge, and so on); no hardcoded palette.

**Profile tab:**
- A read-only derived profile in the order: work it owns, how it works (rhythm, reports to,
  routines), what it knows, style, then runtime (advanced, collapsed).
- Each field shows a provenance label, "Proposed — from <source>" or "Missing", plus a gaps list.
- A banner: "This is a starting point built from today's records. Nothing here has been confirmed
  or applied."

**Access tab:**
- Groups See, Do, Talk and Spend. Each item shows its label, then Requested, Defined, Enforced,
  Working and Used as text badges (never color alone).
- Below the items: "What it used", "What was refused", the execution environment stated as a
  fact, "Always reachable", and Gaps.
- Banner: "Access not yet defined by a person. Showing what today's rules allow."

**Performance tab:**
- Six blocks titled with the six questions (overview LLD §1), each showing counts with their
  denominators.
- A null count shows "Unknown" plus its note, never 0.
- Show the window, as-of time, the "current definitions; history unknown" label and the withheld
  sections. No gauge, score or ranking.
- With no data: "No observed cases yet".

**States:**
- Loading.
- Error, with the server message.
- 403: "Only the agent's accountable person, its steward and company admins can see this."
- Empty.

**Accessibility:** semantic headings, text status, keyboard reachable, no hover-only content.

## Tests (each builder, for their area)

- Unit tests for the pure builders: every gap code that applies, null-not-zero, and the
  window/owed computation including a timezone case.
- Route tests with the embedded-postgres helper and supertest, following
  `server/src/__tests__/agent-config-read-steward-routes.test.ts` or a similar existing file:
  - admin, accountable user and steward allowed;
  - another member gets 403;
  - another company gets 404;
  - an agent on the `/me` routes gets its own data;
  - an agent on another agent's routes gets 403.
- A **no-write test**: snapshot row counts of `activity_log`, `evaluation_events`,
  `evaluation_scorecards`, `issues`, `approvals` and `agent_config_revisions` before and after
  calling the route; they must be equal.
- UI: component tests for each tab's states using the existing test setup.

Run only your own tests, plus `pnpm --filter <pkg> exec tsc --noEmit` for the packages you touched.
The orchestrator runs the full suite.

## Report back

Reply with `RESULT: DONE | PARTIAL | BLOCKED`, followed by:
- files changed;
- the test commands you ran and their pass counts;
- anything in the code that contradicts this spec or the LLD (with path:line);
- any decision you made that the orchestrator should check.
