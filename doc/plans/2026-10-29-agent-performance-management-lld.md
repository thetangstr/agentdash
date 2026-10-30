# Agent Performance Management — low-level design: overview and operating profile

Status: **Revision 2, approved for build by Yang on October 29, 2026** ("ok. create LLD and
build it"). The recommendations on open items 2–6 are accepted (§12). Gate 1 build spec:
[2026-10-29-apm-gate1-build-spec.md](2026-10-29-apm-gate1-build-spec.md). Trials and customer work
are still not authorized.
Date: October 29, 2026. Base: `c625911` plus the uncommitted paired-harness slice on
`codex/acceptance-criteria-enforcement`.

Three documents make up this LLD:
- **this one:** decisions, what the human needs to know, operating profile, approval
  and application, API, UI, prompts, milestones;
- **[agent evaluation](2026-10-29-agent-evaluation-lld.md):** agents as the evaluated
  subject, criteria, attribution, work owed, roll-up, evidence access;
- **[agent access](2026-10-29-agent-access-lld.md):** what an agent can see, do and talk
  to, and where each rule is enforced.

Builds on:
- [discovery draft](2026-10-28-agent-performance-management-discovery.md)
- [DESIGN.md](../../DESIGN.md)
- the paired-harness contract (not on `main` yet: uncommitted on branch `codex/acceptance-criteria-enforcement`)
- [workforce outcome protocol](2026-09-29-workforce-outcome-evaluation.md)

Review record: [Codex round 1](2026-10-29-agent-pm-lld-review-codex-r1.md); dispositions
are in §11.

Evidence: read-only code inspection on October 29. File references describe this
checkout, not any tenant's configuration or deployment.

## 0. Decisions this design rests on

**Confirmed October 28** (handoff §3; not reopened):
- Setup and continued trust are both in scope.
- The persona is the full operating profile, including communication style.
- The performance manager is advisory only. Owner approval and application are separate
  records.
- AgentDash workers are the managed product; a person's paired harness gives feedback.
- Agents learn from each other, with no human rating ceremony on every deliverable.
- Automated acceptance, human acceptance, use and outcome are four different facts.
- No invented readiness percentage and no universal score.
- No fixed pilot length.
- No customer-environment work.

**Confirmed October 29 by Yang:**
- **D1.** The agent is the subject of evaluation. Project and goal results roll up into
  the evaluation of the agents who led them or did the work.
- **D2.** Humans define what good looks like: criteria, evidence and thresholds. Agents may
  draft criteria for a human to approve.
- **D3.** Results first. Show what the human needs to know (§1).
- **D4.** Humans define access — see, do, talk. It is one of the most important things
  they set.

**Architecture choices:**
- **A1.** The profile is structured JSON (shared zod schemas) with a Markdown export.
- **A2.** Access extends `agent_governance_policies` through a separate, narrow-only V2
  evaluator.
- **A3.** Evaluation reuses the evaluator and adds an agent subject.
- **A4.** New approval type `agent_profile_change`, plus an application receipt.
- **A5.** Side tables, not changes to upstream `issues`/`agents`.
- **A6.** Applying a profile changes only what the approving human could change directly
  today (§4.1).

## 1. What the human needs to know

The agent's Performance tab answers six questions, in this order. Each answer comes with
its denominator, coverage and dates. Unknown is shown as unknown.

| # | Question | Where it is specified |
| --- | --- | --- |
| 1 | **Is the work it owes getting done?** Owed, delivered, on time, late, missed, not started; blocked on a person, access or the platform, but only with evidence | Evaluation LLD §7 |
| 2 | **Is the work good?** Per criterion, split by who judged it | Evaluation LLD §3–5 |
| 3 | **Is it accepted, used, and moving the result?** The four facts kept separate, plus projects it leads and goals it owns | Evaluation LLD §4, §8 |
| 4 | **What does it cost?** Agent spend and people's effort (proxies, labelled) | Evaluation LLD §6.2 |
| 5 | **Is it staying inside its boundaries?** Use, refused attempts, repeats, unauthorized execution | Access LLD §10, evaluation LLD §6.3 |
| 6 | **What needs my decision?** Proposals, disagreements, exceptions, gaps, unowned work | §4, evaluation LLD §10 |

There is no headline score.

## 2. Component flow

```
Profile draft ─► agent_profile_change approval ─► Application (serialized per agent)
     ▲                                              ├─ access request (governance V2)
     │                                              ├─ config fields (with the approver's authority)
     │                                              ├─ routine bindings (existing routines only)
     │                                              ├─ skills, AGENTS.md profile block
     │                                              └─ contract.declared, profile.applied
Performance manager ◄─ agent card (scoreAgent) ◄─ ledger (access-classed evidence)
 (advisory: drafts and proposals only)
```

## 3. Operating profile

### 3.1 Shape

`AgentOperatingProfileV1` lives in `packages/shared/src/validators/agent-profile.ts`.
Each responsibility has a stable `key`.

```ts
interface AgentOperatingProfileV1 {
  profileVersion: 1;
  identity: { name: string; title: string; summary: string; audience: string;
              style: { tone: string; uncertaintyRule: string; example?: string } };
  responsibilities: Array<{
    key: string; title: string; outcome: string; notOwned?: string[];
    stakeholders: Array<{ userId?: string; agentId?: string; need: string }>;
    obligation: { kind: "routine" | "deliverable" | "assigned" | "goal";
                  routineTriggerId?: string; deliverableId?: string; goalId?: string };  // binds EXISTING records
    deliverable: { what: string; destination: string };
    escalation: { toUserId?: string; toAgentId?: string; when: string };
    performance: ResponsibilityContract;   // evaluation LLD §3 — authored by a person
  }>;
  knowledge: Array<{ source: string; kind: "company_fact" | "document" | "connection" | "other";
                     ref?: string; freshness?: string }>;
  skills: string[];
  access: AgentAccessPolicy;               // requested access — access LLD §3
  rhythm: { timezone: string; quietHours?: string;
            reportTo: { userId?: string; agentId?: string }; reportCadence?: string };
  runtime?: { adapterType?: string; model?: string; environmentId?: string;
              heartbeat?: { intervalSec?: number; wakeOnDemand?: boolean } };   // admin-authority fields (§4.1)
}
```

- `knowledge` is what the agent should use; `access.see` is what it may read. A knowledge
  source without matching access is a readiness gap.
- `skills` is what it knows how to do; `access.do` is what it may do.
- **Provenance.** `provenance: Record<JsonPointer, { state, sourceRef?, by?, at? }>` with
  states:
  - `from_brief`
  - `proposed`
  - `owner_confirmed`
  - `setup_verified` (computed on read, never stored as truth)
  - `missing`
- **Schedules are bound, not created.** Version 1 binds existing routine triggers and
  deliverables. People create and edit schedules in Routines (evaluation LLD §7).

### 3.2 Storage

```
agent_profiles             id, company_id, agent_id (nullable = unbound draft; unique when set),
                           active_revision_id, created_at, updated_at
agent_profile_revisions    id, company_id, profile_id, revision_number (unique per profile),
                           based_on_revision_id, state, body jsonb, body_hash, provenance jsonb,
                           source_refs jsonb, bases jsonb ({ governanceRevision, configRevisionId }),
                           created_by_agent_id | created_by_user_id, created_by_run_id,
                           approval_id, created_at
agent_profile_applications id, company_id, agent_id, revision_id, approval_id,
                           status (pending | in_progress | applied | failed | refused_stale),
                           steps jsonb ([{ step, status, targetId, beforeHash, afterHash, error }]),
                           approver_user_id, approver_authority jsonb, created_at, updated_at
```

- **Revision states:** `draft → proposed → approved | rejected | withdrawn`, then
  `approved → applied | application_failed | refused_stale`, then `applied → superseded`.
- **Editing drafts.** Only drafts can be edited, and each edit must give the base hash
  (`If-Match`).
- **Freezing.** Proposing freezes the body and records `bases`.
- **History is kept.** Profiles are never reset: each change is a new revision based on
  the active one, and evidence stays attached to the revision it was observed under.

### 3.3 Derived revision 0 for existing agents

On first read the server builds an unconfirmed revision 0. Its provenance is labelled
`proposed`, and it is never applied automatically. It is built from:

- **The confirmed plan card.** Responsibilities and KPIs are structured string arrays in
  `AgentPlanProposalV1Payload` (`packages/shared/src/cards.ts:46-67`), persisted on the
  card row by confirm-plan (`server/src/routes/onboarding-v2.ts:231-251`).
- **Hiring context in AGENTS.md:** name, title, capabilities.
- **The workforce enrollment:** objective, metrics, template.
- **Current state:** routines assigned to the agent, effective governance, skills and
  adapter.

The gap it exposes: the plan has duty strings, but no executable obligations, no criteria
with checks and no access request.

### 3.4 Delivery to the runtime

Applying a profile renders a named block in the managed AGENTS.md:
`<!-- AgentDash: operating-profile rev=<n> hash=<h> -->`, covering duties, what's not
owned, deliverables, escalation, style and a plain summary of access.
`refreshIfStale` treats the active revision as the source.

Refresh is best-effort:
- it honours suppressed blocks;
- it may skip unsupported or external bundles;
- the heartbeat continues if refresh fails (`server/src/services/heartbeat.ts:6585-6600`).

So delivery is **evidenced at run start**. The run records, in `context_snapshot`, the
active revision id and the hash of the block it actually read from disk. A mismatch is
logged as `profile.block_drift`. Agents read the structured form through
`GET /api/agents/me/profile`.

## 4. Proposal, approval, application

### 4.1 Approval type `agent_profile_change` and who may decide

**Payload:**
- `{ agentId, profileId, revisionId, basedOnRevisionId, bases, diff }`, with the diff
  computed server-side;
- `fieldAuthority` (§4.1 table);
- `affectedResponsibilities`;
- `accessChanges`, which flags any widening and any clipping by the ceiling;
- `evidence` (card id, version, ledger event ids);
- `reason`, `expectedBenefit`, `risks`;
- `proposedBy`.

For new agents, `hire_agent` carries `profileRevisionId`, and the revision is applied
through the same path after hire.

**Field-by-field authority.** Each changed field requires the authority that changing it
directly requires today. The guard reuses the existing functions (`assertStewardPatchScope`,
`server/src/routes/agents.ts:1085-1132`; governance ceiling/request rules; routine and
skill authority).

| Changed fields | Authority required |
| --- | --- |
| Identity, style, responsibilities, criteria, knowledge, rhythm text | Steward or accountable user, or admin |
| `access` within the admin ceiling (request side) | Steward or accountable user, or admin |
| `access` beyond the ceiling | Admin, who raises the ceiling as a separate recorded step |
| `runtime.adapterType`, `adapterConfig`, `runtimeConfig` (including heartbeat), `runtime.environmentId` | Admin with `agents:create` — stewards can't patch these today because they carry host-executed settings |
| Skills | The authority skill installation requires today, limited by `access.do.skills` |
| Routine bindings | The authority to edit that routine today |

**Who decides:**
- The decider must hold the maximum authority across all changed fields.
- An **agent-authored** proposal (including the performance manager's) always needs a
  human decider, and the proposing agent can never decide.
- A **human author** with the required authority may approve their own draft. This is
  recorded as a self-approval. There is no two-person rule, because direct editing
  doesn't require one today. Open item §12.5.

### 4.2 Application: serialized, stale-checked, recoverable

`applyProfileRevision(approvalId)` is called from the shared `afterApprove` effect and from
the emergency-override route, which today repeats some effects inline
(`server/src/routes/approvals.ts:594-603`).

1. **Serialize per agent.** Take an advisory lock on `(companyId, agentId)` and mark the
   application `in_progress`. `claimQueuedRun` defers new runs for this agent while an
   application is in progress, so no run starts with a mixed configuration.
2. **Stale check.** Compare against the current state:
   - the active revision against `basedOnRevisionId`;
   - the governance revision and the latest config revision against `bases`.

   On any mismatch, the application ends as `refused_stale` and the owner re-bases into a
   new draft. This also stops an old approval from restoring access someone removed since
   (access LLD §3.4).
3. **Re-check authority.** The approver must still hold the authority in §4.1 at
   application time. If not, the application is refused.
4. **Apply the steps,** each idempotent by `(applicationId, step)`, with durable step
   status:
   - (a) governance request side;
   - (b) config fields through `agentService.update(..., { recordRevision: { source: "profile_application" } })`;
   - (c) environment selection through the governed environment path;
   - (d) routine bindings;
   - (e) skills;
   - (f) `contract.declared`.
5. **Activate in one transaction:**
   - set `active_revision_id`;
   - append `profile.applied`;
   - render the AGENTS.md block;
   - clear the in-progress mark, so dispatch resumes.

**If something fails:**
- **Partial failure** leaves status `failed` with per-step results, and the active revision
  is not switched.
- **Approval replay doesn't help.** Replaying an approval returns `applied: false` and
  skips effects (`server/src/services/approvals.ts:136`), so recovery is a separate route:
  `POST .../profile/applications/:id/resume` (admin or approver). It resumes from the first
  incomplete step after re-running steps 1–3.
- **Rollback** is a new revision based on an earlier one, through the same approval. The
  existing raw config Restore button stays, and warns that it doesn't revert access,
  routine bindings or criteria.

### 4.3 The performance manager

The Chief of Staff by default, or a dedicated role.

- **Reads:** agent cards (per-viewer projection; it sees only what its access allows),
  gaps and exceptions.
- **Writes:** profile drafts and `agent_profile_change` proposals with evidence.
- **Recommends:** continue, narrow, repair, pause or gather more evidence.
- **Cannot:** approve, apply, change access or edit an active profile.
- **Its own evaluation:** the outcomes of its proposals — accepted, rejected, edited by
  the owner — and the evidence after application compared with before.

## 5. API (company-scoped; board vs agent rules per AGENTS.md §8)

| Route | Purpose | Who |
| --- | --- | --- |
| `GET agents/:agentId/profile` | Active revision, latest draft, states, derived rev 0 | Board with agent visibility; the agent via `/api/agents/me/profile` |
| `GET agents/:agentId/profile/revisions[/:revisionId]` | History and body | Same |
| `POST agents/:agentId/profile/revisions` | Create a draft | Steward, accountable user, admin; the performance manager; the agent for itself |
| `PATCH .../revisions/:revisionId` | Edit a draft (`If-Match: body_hash`) | Creator, steward, accountable user, admin |
| `POST .../revisions/:revisionId/propose` | Freeze, record bases, file `agent_profile_change` | As above |
| `GET .../revisions/:revisionId/diff?against=active` · `/export.md` | Diff, Markdown export | Read access |
| `POST agent-profiles` | Unbound draft for a new role | Board with `agents:create`; planner agent |
| `GET agents/:agentId/profile/applications` · `POST .../applications/:id/resume` | Receipts · resume a failed application | Read access · admin or approver |
| Evaluation routes | Evaluation LLD §12 | |
| Access routes | Access LLD §8–9 | |

Every mutation writes an activity entry. Errors use the standard codes.

## 6. UI

The agent page gets three tabs beside Overview, Runs and Settings
(`ui/src/pages/AgentDetail.tsx:238-287`):

- **Profile.**
  - Sections in this order: work it owns; how it works; what it knows; style; runtime
    (advanced, admin-only fields marked).
  - Provenance labels, and revision history with diffs.
  - Actions: Draft changes → Save draft → Export Markdown → Request approval. Success
    says "Draft saved".
  - New agents use the four steps in DESIGN.md, starting from an unbound draft.
- **Access.** Access LLD §8, with the Defined / Enforced distinction.
- **Performance.** The six questions; every number opens its cases. "No observed cases
  yet". No gauge, leaderboard or ranking. Sections the viewer can't read say
  "Not visible to you".

Elsewhere:
- **Overview:** "Needs your decision" and "Results this window".
- **Approvals:** the `agent_profile_change` renderer shows the diff, the authority each
  field needs, access widening and clipping, evidence, affected responsibilities and what
  applying will change. Failed applications show their failed step and a Resume action.
- **Evaluation overview:** an Agents list.
- **Design rules:** existing tokens and components, WCAG 2.2 AA target, one company UX.

## 7. Agent-facing prompt surfaces

Both surfaces change together:
- `server/src/onboarding-assets/default/AGENTS.md` (new named block `operating-profile`);
- `renderAgents` in `server/src/services/agent-creator-from-proposal.ts`.

Agents are told:
- **The profile block is the authority** for duties, what's not yours, and style. Read
  `/api/agents/me/profile` and `/api/agents/me/access`.
- **Map unmapped work** when you start it (`POST .../issues/:issueId/responsibility`). If
  nothing fits, say so on the issue.
- **On `ACCESS_POLICY_REFUSED`,** don't route around it. Record the blocker; ask your
  accountable owner or file an `agent_profile_change` request.
- **Don't edit your profile block on disk.**
- **Feedback is not acceptance.** Harness assessments and automated verdicts are feedback,
  not human acceptance.

## 8. Migrations (all three documents)

| # | Change | Document |
| --- | --- | --- |
| 1 | `agent_profiles`, `agent_profile_revisions`, `agent_profile_applications` | This one, §3.2 |
| 2 | `issue_responsibilities` (history) | Evaluation §5.2 |
| 3 | `evaluation_events.access_class`, `subject_agent_id`, indexes | Evaluation §9 |
| 4 | Routine run `scheduledFor` (payload or nullable column) | Evaluation §13 |
| 5 | `companies.agent_access_enforcement` | Access §11 |
| 6 | No schema change for `approvals` (its type is text); add the type to `APPROVAL_TYPES` | — |

All tables are company-scoped and exported from `packages/db/src/schema/index.ts`, with
contracts synced across db, shared, server and ui.

## 9. Order of work (recommended) and verification

Each step needs Yang's go-ahead. Nothing below has been run.

| Step | Scope | Verification to write |
| --- | --- | --- |
| **0. Paper walkthrough** (before any implementation) | One real responsibility, the existing agent that does it, and its accountable person, walked through the profile, access and evaluation design on paper (discovery draft stage A). This fixes the criteria, obligations and access rules the code has to support. | The owner confirms the output is useful and states what's missing |
| **M1. See what's true today** (side-effect-free) | Derived rev 0; Access tab inventory from current mechanisms and the host fact; agent card through the read-only projection, reading current routine/trigger/run tables directly and labelled "current definitions; history unknown". No snapshot, finding, review item or ingest change. | Projection has no writes; no grant changes; isolation; access-class filtering of drill-downs |
| **M2. People define it** | Profile edit, propose, field-authority guard, serialized application with resume; agent contract; responsibility mapping; profile block; access V2 in **shadow** | Draft ≠ approval ≠ application; stale refusal; authority re-check; dispatch deferral; resume; prompt surfaces |
| **M3. Enforce and measure** | Enforce mode; every access LLD §4 row; new ingest sources and access classes; obligations; bound judgments; calibration; Performance tab | Every matrix row in all three modes; MK regression; replay with `asOf`; attribution cases |
| **M4. Manager proposes** | Performance manager prompt, proposals, its own evaluation | Can't approve or apply; evidence cited |
| **M5. Start from a brief** | Brief import as an issue document, scenario extraction, unbound drafts, hire with profile | Edits survive extraction; no hire or heartbeat on preview |

**Order change, needs Yang's approval.** The discovery draft proposed brief → profile as
the first slice. This design moves brief intake to M5 and puts *seeing current access and
results* first, because of D3 and D4. If Yang prefers the original order, M5 can come
after M2.

## 10. What this design does not claim

- The access policy doesn't restrict a local agent's host (access LLD §6).
- History before the new ingest sources stays unknown. Reassignment history is incomplete
  until the checkout fix lands.
- People's effort is measured by proxies, not minutes saved.
- No baseline or threshold exists yet.
- A shipped, accepted deliverable doesn't prove use or business effect.

## 11. Codex review round 1: dispositions

All 16 findings were accepted. The three blockers and the most consequential high finding
were re-checked in code before they were accepted.

| # | Finding (severity) | Disposition |
| --- | --- | --- |
| 1 | Project restrictions miss runtime context and exports (BLOCKER) | Run-claim, context-hydration and export rows added (access §4) |
| 2 | Ledger ingest would expose private feedback (BLOCKER) | `access_class` on events, filtering before aggregation, per-viewer projections (evaluation §9.1) |
| 3 | Profile approval exceeded existing config authority (BLOCKER) | Field-by-field authority, re-checked at application (§4.1–4.2) |
| 4 | Application not serialized or recoverable (HIGH) | Per-agent lock, stale check, dispatch deferral, one-transaction activation, resume route (§4.2) |
| 5 | Assignment and contact had alternative paths (HIGH) | One wake-dispatch check; V2 refusal overrides CEO/`reportsTo`; import and bridge rows (access §4) |
| 6 | Runtime skills bypassed skill limits (HIGH) | `do.skills` on all writers and runtime; `capabilities` off the peer list (access §4–5) |
| 7 | Generalizing MK governance could widen access (HIGH) | Separate narrow-only V2 evaluator; send precedence table (access §3.2) |
| 8 | Legacy writers could erase V2 limits (HIGH) | Merge semantics, out-of-profile changes recorded, stale refusal (access §3.4) |
| 9 | P-metric semantics contradicted the design (HIGH) | Agent formulas: refusals split, expected human steps, judge independence (evaluation §6.3) |
| 10 | Denominator omitted work never issued (HIGH) | Occurrences from versioned definitions; `cause_unknown`; bind existing routines (evaluation §7) |
| 11 | Attribution mixed up roles (HIGH) | Role model, producer credit, mapping history, ownership intervals (evaluation §5) |
| 12 | Judgments not bound to criteria (HIGH) | Criterion tuple; bound vs unbound judgments (evaluation §3, §5.3) |
| 13 | A broadened class could satisfy `pr.merged` (HIGH) | Typed predicates separate from coverage classes (evaluation §4) |
| 14 | Replay under-specified (MEDIUM) | `asOf`, window, cut, dependencies recomputed from the same cut (evaluation §6.1, §8) |
| 15 | Some controls had no enforcement (MEDIUM) | Matrix covers every field; dropped fields with no enforcement; predicate contact rules; shadow labels (access §3–4) |
| 16 | M1 not behaviour-free; walkthrough too late (MEDIUM) | Paper walkthrough first; M1 uses the side-effect-free projection; order change flagged (§9) |

All eight factual corrections were applied: plan arrays, goal target date, snapshot
fields, goal cadence, refresh, document connectors, the hand-off cap and `api_request`
scope.

## 12. Open items for Yang

On October 29, Yang accepted the recommendations on items 1–3, 5 and 6 below (the deck's
decisions 2–6). Item 4 (the deck's decision 1) is still open. Building started at gate 1, which
doesn't depend on it, so the paper walkthrough moves to before gate 3.

1. **Existing agents when enforcement turns on.** Recommended: keep today's access,
   labelled "not yet defined", shadow first, with an optional review reminder after N days.
2. **Who sees agent performance.** Recommended: admins, the accountable user and the
   steward, plus members with agent visibility for the parts they can read.
3. **People's time.** Recommended: proxies only, plus an optional minutes field when
   someone closes a review.
4. **The real responsibility for step 0.** One existing agent and its accountable person.
   This is now needed before any implementation.
5. **Self-approval.** Recommended: a person with the required authority may approve their
   own draft, recorded as self-approval. Agent proposals always need a human.
6. **Order.** Current access and results first (M1), brief intake last (M5), or the
   discovery draft's brief-first order.
