# Agent Performance Management — gate 2 build spec ("people define it")

Status: authorized as part of Yang's October 29 build instruction. It follows gate 1
([gate 1 spec](2026-10-29-apm-gate1-build-spec.md)) in the same worktree and branch:
the build worktree, `claude/agent-performance-mgmt`.
Nothing is committed until Yang asks.

Design: overview LLD §3–5 and §7–9, access LLD §3–5 and §7–11, evaluation LLD §3, §5.2 and §13.

**Gate 2 exit conditions:**
- A person can draft, save, propose and approve a profile revision.
- Application is serialized, stale-checked and resumable, and every applied step is recorded.
- The agent's contract is declared for the evaluator.
- Work can be mapped to responsibilities.
- The AGENTS.md profile block is delivered, and its delivery is evidenced at run start.
- V2 access rules run in **shadow** mode at every access LLD §4 matrix row and refuse nothing.

`enforce` is not selectable in gate 2.

## Invariants (all packages)

The gate 1 invariants still apply (company scoping, no `productProfile` branches in `ui/src`,
`// AgentDash:` comments, reuse over rebuild, no git state changes, no installs). In addition:

1. **Gate 2 writes, always through the authorized path.** Draft saves write profile rows only.
   Only `applyProfileRevision` changes governance, config, skills, the AGENTS.md block or the
   contract.
2. **Never widen.** No change in this gate may give any agent access it lacks today. Shadow
   logs; it does not refuse and it does not allow more.
3. **MK is unchanged.** MK companies behave exactly as before in every mode. The legacy
   `resolveAgentPolicy` semantics stay as they are.
4. **Activity for every mutation,** as AGENTS.md §8 requires.
5. **Both prompt surfaces** when agent-facing behaviour changes (P2.4 owns this).

## Packages, in order

`P2.1 freeze` → (`P2.2 profiles and application` ∥ `P2.4 contract and mapping`) → `P2.3 shadow access`
→ `P2.5 UI`. Yang said on October 29 that no cross review is needed. Instead, the orchestrator
checks each package against this spec and the full verification before the next package starts
on its files.

### P2.1 — freeze: schema, shared contracts, interfaces (one author, one pass)

**Owns:**
- `packages/db/src/schema/agent_profiles.ts` (new), `packages/db/src/schema/issue_responsibilities.ts`
  (new), `packages/db/src/schema/companies.ts` (add `agentAccessEnforcement`, text, default
  `'off'`), `packages/db/src/schema/index.ts` exports, and the generated migration
  (`pnpm db:generate`).
- `packages/shared/src/validators/agent-profile.ts` (new): zod schemas for
  `AgentOperatingProfileV1` (overview LLD §3.1), `ResponsibilityContract` (evaluation LLD §3:
  criteria use the existing `evaluationAcceptanceCriterionSchema`, plus `coverage`, `deadline`,
  `outcomeLinks`, `expectedHumanSteps`, `judges`, `thresholds`), and the provenance map. Also
  `profileBodyHash()` (canonical JSON hash) and `diffProfiles(a, b)` (per-field JSON-pointer diff).
- `packages/shared/src/types/agent-governance.ts`: extend it with `AgentAccessPolicy` V2
  (access LLD §3.1) as optional fields.
- `packages/shared/src/agent-access-v2.ts` (new, pure):
  - `parseAccessPolicy(stored)`, which upgrades V1 on read;
  - `mergeAccessPolicyWrite(storedV2, incoming)`: V1-shaped writes keep the V2 fields, and
    clearing a V2 dimension needs it named explicitly;
  - `evaluateAccessV2(ceiling, request, target, context)` → `{ decision: "allow" } | { decision: "refuse", dimension, rule, allowedSummary }`.
    It uses predicate contact scopes evaluated at check time (`reportsChain` comes in through
    `context`), the `via` intersection, list intersection, the mode order, and the send
    precedence from access LLD §3.2. V2 can only refuse.
- `packages/shared/src/types/agent-profile.ts` (new) — DTOs:
  - `AgentProfileView`: active revision, latest draft, derived rev 0 when no revision exists.
  - `AgentProfileRevisionDto`.
  - `AgentProfileApplicationDto`, with step statuses.
  - `AgentProfileChangePayload`: the approval payload (overview LLD §4.1), including
    `fieldAuthority: Array<{ pointer, required: "steward_or_accountable" | "admin" | "admin_ceiling" }>`.
  - `IssueResponsibilityDto`.
  - `AgentAccessEnforcementMode = "off" | "shadow" | "enforce"`.
- `packages/shared/src/constants.ts`: add `"agent_profile_change"` to `APPROVAL_TYPES`, and add
  activity action names: `agent_profile.draft_saved`, `.proposed`, `.withdrawn`,
  `.application_started`, `.application_step`, `.applied`, `.application_failed`,
  `.application_refused_stale`, `issue.responsibility_mapped`, `access.would_refuse`,
  `access.policy_changed`, `company.agent_access_enforcement_changed`, `profile.block_drift`.
  Check that the activity catalogue in `ui/src/lib/activity-format.ts` has an entry for each
  new action, and add any that are missing.
- `packages/shared/src/evaluation.ts`: additive `EvaluationSubjectRef` and
  `evaluationContractV2Schema` (evaluation LLD §2–3). V1 parsing is unchanged.
- Gate 1 contract updates in `packages/shared/src/types/agent-performance.ts`:
  - `AgentAccessItem.requested` becomes `{ state: "not_defined" | "requested" | "not_requested"; revisionId?: string | null }`;
  - `AgentAccessInventory.profileDefined` becomes `boolean`;
  - `enforcementMode` becomes `AgentAccessEnforcementMode`;
  - `defined` gains `v2?: { allowed: boolean; rule?: string | null }`.

  Update the gate 1 server and ui code so they still compile with today's behaviour.
- **Interface stubs** that later packages implement. Exported signatures only, throwing
  `not implemented`:
  - `server/src/services/agent-profiles.ts`
  - `server/src/services/agent-profile-application.ts` (`applyProfileRevision(db, approvalId, actor)`,
    `resumeProfileApplication(db, applicationId, actor)`, `isProfileApplicationInProgress(db, companyId, agentId)`)
  - `server/src/services/agent-profile-block.ts` (`renderProfileBlock(revision)`,
    `profileBlockHash(text)`)
  - `server/src/services/evaluation/agent-contract.ts` (`declareAgentContract(db, input) → { eventId }`)
  - `server/src/services/issue-responsibilities.ts` (`mapIssueResponsibility(db, input, actor)`,
    `currentResponsibility(db, issueId)`)
  - `server/src/services/agent-access-check.ts` (`checkAgentAccess(db, { companyId, agentId, dimension, target, via? }) → Promise<"allow" | "would_refuse" | "refuse">`)

**Tests:**
- zod round trips and rejections;
- `parseAccessPolicy` / `mergeAccessPolicyWrite`;
- `evaluateAccessV2`, one case per dimension, plus the precedence table;
- `diffProfiles`;
- `profileBodyHash` stability.

Run `pnpm -r typecheck`.

### P2.2 — profiles, approval and serialized application (server)

**Owns:**
- `server/src/services/agent-profiles.ts`, `agent-profile-application.ts`, `agent-profile-block.ts`
- a new `server/src/services/agent-profile-authority.ts`
- a new `server/src/routes/agent-profiles.ts`, mounted in `app.ts` next to the gate 1 routes
- the `agent_profile_change` branches in `approval-decision-effects.ts` (`afterApprove` and the
  reject path), `approval-authority.ts` and the override route in `server/src/routes/approvals.ts`
- `server/src/services/agent-instruction-refresh.ts` (the named block's source is the active revision)
- tests for all of the above

**Drafts:**
- The first draft is based on the active revision, or on derived rev 0 converted to V1 with
  `proposed` provenance.
- Saving checks `If-Match: body_hash`. A mismatch returns 409 with the current draft.
- Proposing freezes the draft and records `bases`:
  - `basedOnRevisionId`;
  - `governanceRevision`, taken from `agent_governance_policies.revision`;
  - `configRevisionId`, the latest `agent_config_revisions.id`.

  It then computes `diff` and `fieldAuthority`, and files the approval.
- Withdrawing is allowed while pending. A rejected approval marks the revision `rejected`.

**Authority** (overview LLD §4.1):
- Each changed pointer maps to the existing direct-edit authority: `assertStewardPatchScope`
  semantics in `server/src/routes/agents.ts` (around lines 1080–1135), governance ceiling and
  request rules, and the skill and routine rules.
- The decider must hold the highest authority any changed field needs.
- The proposing agent can never decide. A human author with the authority may decide their own
  draft; record `decisionActorRole` and a self-approval flag in the approval decision.
- Applies to all companies.

**Application** (overview LLD §4.2), steps 1–5 exactly:
1. Advisory lock on `(companyId, agentId)`.
2. Stale check against `bases`; a mismatch ends in `refused_stale`.
3. Re-check the approver's authority.
4. Run the idempotent steps, each keyed by `(applicationId, step)` and recorded in `steps`:
   - the governance request side, through `mergeAccessPolicyWrite`;
   - config, through `agentService.update(..., { recordRevision: { source: "profile_application" } })`;
   - the environment, through the governed path;
   - routine bindings: validate that each bound trigger exists, belongs to a routine assigned to
     this agent, and is in this company. Validation only; routines are never modified;
   - skills, to `skills ∩ access.do.skills`, through the existing skill sync service;
   - `declareAgentContract` (P2.4).
5. Activation in one transaction: `active_revision_id`, the `agent_profile.applied` activity,
   the AGENTS.md block render, and clearing in-progress.

Recovery and dispatch:
- A failure leaves status `failed` without switching the active revision.
- `POST .../profile/applications/:id/resume` re-runs steps 1–3, then continues from the first
  incomplete step.
- The heartbeat dispatch deferral and the run-start evidence are **P2.3's edits** in
  `heartbeat.ts`. P2.2 provides `isProfileApplicationInProgress`, plus
  `profileDeliveryEvidence(agent)` → `{ profileRevisionId, blockHashOnDisk, expectedHash }`.

**Routes:** overview LLD §5, all company-scoped, with activity on every mutation.

**Tests:**
- draft ≠ approval ≠ application;
- a 409 on a stale `If-Match`;
- `fieldAuthority` per field class (a steward trying runtime or adapter fields is refused);
- a self-approval is recorded;
- an agent can't decide its own proposal;
- concurrent applications serialize;
- a stale base gives `refused_stale`;
- an approver who lost authority is refused;
- failure at each step, then resume;
- the override route goes through the same function;
- a V1-shaped governance write after application keeps the V2 fields;
- MK regression on approvals.

### P2.4 — agent contract and responsibility mapping (server + prompt surfaces)

**Owns:**
- `server/src/services/evaluation/agent-contract.ts`
- `server/src/services/issue-responsibilities.ts`
- a new `server/src/routes/issue-responsibilities.ts` (mounted in `app.ts`)
- the dispatch hook in `server/src/services/routines.ts` (`dispatchRoutineRun` writes a mapping
  row when the routine's trigger is bound in the agent's active profile)
- both prompt surfaces
- tests

**Contract:** `declareAgentContract` appends `contract.declared` with an `evaluationContractV2`
for `subjectRef: { kind: "agent", id }`. It uses the same ledger append path, lock and dedupe as
`POST /contracts` (`server/src/routes/evaluation.ts` around 235–277), and it is idempotent per
profile revision. Milestone (V1) contracts and scoring are unchanged: gate 2 declares; scoring
the agent subject is gate 3.

**Mapping:**
- `POST /api/companies/:companyId/issues/:issueId/responsibility` takes
  `{ agentId, responsibilityKey, reason? }`. It closes the current row (`valid_to`) and opens a
  new one, and the key must exist in that agent's active profile.
- Who may map: the assignee agent, the planner (CoS role), the steward, the accountable user,
  or an admin.
- Activity: `issue.responsibility_mapped`.

**Prompt surfaces:** a named block `operating-profile` in the default AGENTS.md and a matching
line in `renderAgents`. Content as in overview LLD §7:
- the profile block is the authority;
- read `/api/agents/me/profile` and `/api/agents/me/access`;
- map unmapped work when you start it;
- on `ACCESS_POLICY_REFUSED`, don't route around it;
- don't edit the block on disk;
- feedback is not acceptance.

Use adapter-neutral HTTP and JSON wording.

**Tests:**
- the contract is idempotent, V2 parses, and V1 milestone scoring is unchanged (existing
  evaluator suites stay green);
- mapping history;
- an unknown key gives 422;
- authorization;
- the routine dispatch hook writes a row only for bound triggers;
- the prompt-surface tests in `agent-instruction-bundles.test.ts` stay green.

### P2.3 — V2 access checks in shadow mode (server)

**Owns:**
- `server/src/services/agent-access-check.ts`
- the company enforcement-mode admin route: `PATCH /api/companies/:companyId/agent-access-enforcement`
  with `{ mode: "off" | "shadow" }`. `enforce` returns 409 "available in gate 3". Admin only, with
  activity logged.
- the governance write-merge integration in `server/src/services/agent-governance.ts`:
  - V1-shaped writes go through `mergeAccessPolicyWrite`;
  - out-of-profile changes log `access.policy_changed` with their source.
- `heartbeat.ts` edits:
  - the run-claim and context-hydration check, which in shadow logs only;
  - the runtime skill-mentions check;
  - deferral while `isProfileApplicationInProgress`;
  - run-start profile delivery evidence written into `context_snapshot`;
  - `profile.block_drift` logging.
- one call to `checkAgentAccess` at every other access LLD §4 matrix row:
  - `visibility.ts`;
  - `connectors.ts` (`resolveActingAs`, after the legacy decision);
  - `connector_send` creation and execution;
  - skill writers in `agents.ts`;
  - the wake-dispatch boundary (one shared function where wakeups are enqueued);
  - assignment in `issues.ts` and import;
  - `agent-handoffs.ts`;
  - questions and approval routing;
  - bridge tasks;
  - agent-actor export.
- gate 1 inventory updates: Requested comes from the active profile; Defined includes V2; the
  mode comes from the company setting.

**Shadow:**
- In `shadow`, `checkAgentAccess` returns `would_refuse` and logs `access.would_refuse` with
  `{ dimension, rule, target }`, then the caller continues unchanged.
- In `off`, it returns `allow` without evaluating.
- Callers must not change behaviour on `would_refuse`.

**Tests:**
- one per matrix row: in shadow it logs and behaviour is identical; in off nothing is logged;
- MK companies are unchanged;
- the merge semantics hold;
- the enforcement-mode route accepts only `off` or `shadow`, admin only;
- dispatch defers during an application;
- run-start evidence is written;
- drift is logged.

### P2.5 — UI

**Owns:**
- `ui/src/components/agent-performance/*`: Profile tab editing, plus Access and Performance updates
- the `ui/src/components/ApprovalPayload.tsx` renderer for `agent_profile_change`
- the CompanySettings enforcement-mode control (admin only; `off`/`shadow`; `enforce` shown
  disabled with "Available after gate 3")
- the matching api clients and tests

**Profile tab:**
- A draft editor following DESIGN.md's four steps; for an existing agent the steps are sections.
- Actions: Save draft (`If-Match`, with a 409 conflict UI that shows a comparison), Request
  approval, Withdraw, Export Markdown, and revision history with a diff.
- Application status shows each step, and Resume when the viewer has the authority.
- Success copy is "Draft saved", never "Agent ready".
- Provenance labels on every field.

**Access tab:** Requested, Defined, Enforced, Working and Used. In shadow mode items read
"Defined, not enforced", and would-be refusals are listed.

**Approval renderer:**
- the diff;
- the per-field authority needed;
- access widening and clipping highlighted;
- evidence links;
- what applying will change.

**Tests:** component states, plus a draft save that triggers no application call.

## Orchestrator decisions after P2.1

- **Agent contracts in milestone scoring (P2.4).** `resolveContract` (`scoring/contract.ts`) skips
  `contract.declared` events that aren't V1, so milestone cards are unchanged.
- **Profile routes (P2.2).** P2.2 moves `GET …/agents/:agentId/profile` and
  `/agents/me/profile` into `routes/agent-profiles.ts`; they return `AgentProfileView` with the
  gate 1 derived profile embedded. P2.5 updates the UI.
- **AGENTS.md block slugs.** The per-agent rendered data block is `operating-profile` (P2.2);
  its source is the agent's active revision, never the default bundle. The static
  default-bundle rules block is `operating-profile-guidance` (P2.4).
- **Generic approval routes (P2.2).** `POST /approvals` and resubmit refuse
  `agent_profile_change`.
- **Interrupted applications (P2.2).** An `in_progress` application past its lease (refreshed
  on every step) counts as interrupted. It doesn't defer dispatch, and resume can take it over.
- **Governance editors (P2.3).** The existing ceiling and request editors keep working: the
  routes return the V1 projection to them, and V1-shaped writes merge.
- **Enforcement mode (P2.3).** P2.3 adds `GET /api/companies/:companyId/agent-access-enforcement`
  (admin and members can read it).
- **Activity feed (P2.5).** `access.would_refuse` and `agent_profile.application_step` are
  hidden from the default feed (they stay in the record and the ledger). The Access tab lists
  would-be refusals.

## Verification for the gate (orchestrator)

- `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, the drift checks (API reference, docs
  search index, profile UX), and the migration applied to a fresh embedded database.
- Gate exit: run the exit conditions as a scripted local walkthrough against a dev instance on
  an empty, isolated database. No customer data, and no real agent runs or paid model calls.
