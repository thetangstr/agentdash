# Agent Performance Management — gates 4 and 5 build spec

Status: authorized as part of Yang's October 29 build instruction. Same worktree and branch;
nothing committed until Yang asks; no cross review (Yang). Design: overview LLD §4.3, §5, §6, §9
(M4, M5); discovery draft §4, §7.

## Gate 4 — "manager proposes"

Exit conditions:
1. A company has a designated performance manager, defaulting to its Chief of Staff.
2. The manager reads agent cards (a per-viewer projection for an agent principal) and files
   profile-change proposals with evidence, plus advisory recommendations.
3. The manager can never approve, apply, change access or edit an active profile.
4. The manager's own record (the outcomes of its proposals) is visible.

### P4.1 — server and prompt surfaces

- **Designation.**
  - `companies.performance_manager_agent_id` (nullable FK to agents), via a generated migration.
  - Effective manager = the column, else the company's non-terminated `chief_of_staff`.
  - `GET` / `PATCH /api/companies/:companyId/performance-manager` (PATCH is admin only, with activity).
  - Add `performanceManager: boolean` to `GET /api/agents/me/profile` (and to `/me/access` if cheap).
- **Card access for the manager.**
  - The effective manager, as an agent principal, may `GET evaluation/agents`,
    `GET evaluation/agents/:agentId`, `GET .../cases` and `GET .../compute` for agents in its
    company.
  - Its projection follows the access-class rules for agent principals: no private classes, and
    project classes only where its own project access allows.
  - Every other agent principal stays at 403.
- **Proposals.** The manager may create drafts and propose for any agent in its company. This
  reuses the gate 2 draft and propose path; align that path's "planner/performance manager" rule
  with the designation.
  - The `proposedBy` payload marks it `performance_manager`.
  - Field authority, and "the proposer never decides", are unchanged.
- **Recommendations.**
  - `POST /api/companies/:companyId/evaluation/agents/:agentId/recommendations` (manager only)
    with `{ kind: "continue" | "narrow" | "repair" | "pause" | "gather_evidence", reason,
    evidence: [{ kind: "card" | "event" | "case", ref }], proposalApprovalId? }`.
  - Appended to the ledger as `evaluation.agent_recommendation`, with activity, and listed by
    `GET .../recommendations` (anyone who can read the card).
  - **Pause is advisory:** it never pauses. The owner uses the existing pause action.
  - The owner may record `{ decision: "accepted" | "declined", note }` through
    `POST .../recommendations/:id/decision` (accountable user or admin).
- **The manager's own record.** `GET /api/companies/:companyId/evaluation/performance-manager/record`:
  - proposals filed, approved, rejected, withdrawn, edited by the owner before deciding, and
    applied;
  - recommendations by kind and their decisions;
  - for each applied proposal, the affected responsibilities' card sections from the last
    snapshot before application and the first after it, shown descriptively. No causal claim
    and no score.
- **Prompt surfaces.** A named block `performance-manager-guidance` in the default AGENTS.md
  (it applies only when `performanceManager` is true; written adapter-neutral) and the matching
  line in `renderAgents`. It tells the manager:
  - read the cards;
  - propose only with cited evidence;
  - never act on recommendations itself;
  - never approve;
  - "pause" means recommend.
- **Tests:**
  - designation default and override;
  - manager read access with class limits;
  - another agent gets 403;
  - the manager's proposal goes through field authority, and the manager can't decide it;
  - recommendations are stored and decided, and pause doesn't pause;
  - the record is correct;
  - the prompt-surface tests.

### P4.2 — UI

- A CompanySettings control for the performance manager (admin; members read-only).
- On the Performance tab:
  - a "Recommendations" list, with an owner decision action where allowed;
  - proposals filed by the manager, marked as such.
- A manager record view, linked from the manager's agent page.

## Gate 5 — "start from a brief"

Exit conditions:
1. An owner can paste a Markdown brief.
2. It becomes a planning issue with the brief as a revisioned issue document, assigned to the
   planner (the performance manager) only when the owner submits it.
3. The planner writes a validated scenario manifest and unbound draft profiles.
4. An unbound draft can be proposed as a hire with its profile; the approved hire creates the
   agent and applies the profile through the gate 2 path.
5. Previewing or saving never hires an agent or starts a heartbeat.

### P5.1 — server

- **Brief.**
  - `POST /api/companies/:companyId/agent-briefs` `{ title, markdown }` creates a planning issue
    (backlog, unassigned) with issue document key `agent-work-brief`.
  - `POST .../agent-briefs/:issueId/submit` assigns it to the effective performance manager
    (an ordinary assignment, so it wakes the planner the normal way).
  - Editing reuses the issue-document revision API.
- **Scenario manifest.** A shared zod `AgentScenarioManifestV1`. Each scenario carries:
  - key, title;
  - stakeholders, current process;
  - removed or new work;
  - trigger/cadence, inputs/sources;
  - deliverable, acceptance notes, authority needs, escalation, baseline/measure;
  - unknowns;
  - `recommendation: "reuse" | "bounded_change" | "new_role" | "deterministic_workflow" |
    "human_owned"`, plus `targetAgentId?` / `unboundProfileId?` and the reason.

  Stored as issue document key `scenario-manifest` (JSON). The server validates it on write
  through the document route for that key (422 on invalid). The planner writes it with the
  existing document API.
- **Unbound drafts.**
  - `POST /api/companies/:companyId/agent-profiles` creates an unbound draft (`agentId` null),
    written by board users with `agents:create` or by the performance manager.
  - List, get, save and diff work as for bound drafts.
  - Proposing an unbound draft files `hire_agent` with `profileRevisionId`, and the needed new
    agent fields (role, name, adapterType from `runtime`) derived and validated by the existing
    hire validator.
- **Hire with profile.** When `hire_agent` is approved and the agent created or activated:
  - bind the profile (`agent_profiles.agent_id`);
  - run `applyProfileRevision` for that revision through the same serialized path and receipt;
  - field authority for an unbound first application = the hire approval's authority
    (`agents:create`).
- **Tests:**
  - a brief saved doesn't wake anyone; submitting assigns the planner;
  - manifest validation;
  - an unbound draft's lifecycle;
  - the hire approval binds and applies;
  - preview and save never hire or heartbeat;
  - rejecting a hire leaves the unbound draft rejected.

### P5.2 — UI

- The new-agent flow gains "Start from a brief": paste or import Markdown, save, submit to the
  planner.
- A brief page shows the scenario manifest: each scenario with its recommendation, reason and
  unknowns, linking to the target agent or unbound draft.
- An unbound draft editor using DESIGN.md's four steps (Work to own → Operating profile →
  Boundaries and checks → Review plan), then Request hire.
- Success copy is "Draft saved"; the hire request is described as needing approval.

## Walkthrough and verification

- `server/src/__tests__/apm-gate4-5-walkthrough.test.ts`, over HTTP:
  1. Designate the manager.
  2. The manager reads a card, files a proposal and a pause recommendation; the owner decides;
     the agent is not paused.
  3. The record shows the outcome.
  4. A brief is saved (no wake), then submitted (assigned).
  5. The planner writes the manifest and an unbound draft.
  6. A hire is proposed and approved: the agent is created with the profile applied, and the
     receipt is recorded.
- Then the full verification: typecheck, `pnpm test:run`, build, every `scripts/ci` check, docs
  regenerated.
