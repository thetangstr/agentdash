# Agent Performance Management — gate 3 build spec ("enforce and measure")

Status: authorized as part of Yang's October 29 build instruction. It follows gates 1 and 2 in
the same worktree and branch (the build worktree,
`claude/agent-performance-mgmt`). Nothing is committed until Yang asks. Per Yang, there's no
cross review; the orchestrator verifies each package against this spec and the full suite.

Design: evaluation LLD (all), access LLD §4–5 and §7–10, overview LLD §1 and §6.

**Exit conditions:**
1. Each company can choose `enforce`, and every access LLD §4 row refuses as its "On refusal"
   column says. Off and shadow behave exactly as in gate 2. MK is unchanged.
2. The self-widening gaps in access LLD §5 are closed.
3. An agent card can be snapshotted and verified (replay with `asOf`).
4. Owed work counts periods in which nothing ran.
5. Evidence access classes stop leaks through the events API, cards, cases and review items.
6. Milestone cards change only through a declared formula bump.
7. Calibration samples become review items.
8. **Open, needs Yang:** the card has been checked against one real responsibility (the paper
   walkthrough). The code can be complete without it; the gate is not passed until it's done.

**Out of scope on this branch:** bound harness judgments. The paired-harness slice only exists
uncommitted in `trevally`. Implement the predicate and ingest generically so receipts start
counting once that slice lands.

## Invariants

The gate 1 and gate 2 invariants still hold. In addition:
- **Enforcement is opt-in per company.** No company's behaviour changes unless an admin selects
  `enforce`, with one exception: the fixed rules in access LLD §3.1 and §5. `capabilities` leaves
  both patch lists in every mode, because the profile owns it. That narrows; it never widens.
- **The escalation path is always open.** In every mode, the accountable user, the steward and
  company admins stay reachable.
- **Scoring is pure and replayable.** No wall-clock "now" inside scoring. Stored cards are never
  served raw; each viewer gets a projection.

## Packages

`P3.1 freeze` → (`P3.2 ingest and access classes` ∥ `P3.4 enforce`) → `P3.3 agent scoring and cards`
→ `P3.5 UI` → `P3.6 walkthrough`.

### P3.1 — freeze (one author, one pass)

- **Migration:**
  - `evaluation_events`: `access_class` (text, not null, default `'company'`), `subject_agent_id`
    (uuid, null), and indexes `(company_id, subject_agent_id, seq)` and `(company_id, actor_id)`.
  - New side table `routine_run_occurrences` (`company_id`, `routine_run_id` unique, `trigger_id`,
    `scheduled_for`, `created_at`). It goes beside the table rather than changing upstream
    `routine_runs` (A5).
- **Shared:**
  - `EvaluationAccessClass`: `company | project:<id> | private_pairing:<id> | private_agent:<id>`,
    with a parser.
  - The typed predicates and coverage classes from evaluation LLD §4, as an additive list. The
    existing class semantics don't change: `pr.merged` → `delivery_ref` exactly as today.
  - Disposition kinds `use_confirmed` and `disagreement_noted`, plus the binding fields for
    `criterion_attest` (criterion tuple, subject and item).
  - `AgentObligationOccurrence` and its end states (evaluation LLD §7).
  - `AgentCardV1`, with the six sections, gaps and the stored replay inputs `throughSeq`, `asOf`,
    `window` and `dependencies[]`.
  - `AgentCaseRow` (drill-down), plus `AGENT_CARD_VERSION = "agent-card/1"` and
    `AGENT_METRICS_VERSION = "agent-metrics/1"`.
- **Interface stubs** under `server/src/services/evaluation/`:
  - `access-class.ts`: `classifyEvent(sourceRow) → class`, `viewerClassFilter(viewer) → predicate`
  - `agent-obligations.ts`: `generateOwedOccurrences(window, timeline, asOf)`, pure
  - `agent-scoring.ts`: `scoreAgent({ window, throughSeq, asOf, dependencies })`, pure
  - `agent-cards.ts`: `snapshotAgentCard`, `verifyAgentCard`, `getAgentCard(viewer)`,
    `listAgentCards(viewer)`, `agentCases(viewer, filter)`
  - `calibration.ts`: `selectCalibrationSample(card, contract)`, pure;
    `syncCalibrationReviewItems(db, …)`

### P3.2 — ingest, timeline fixes and access classes (server)

**Owns:** `server/src/services/evaluation/{sources,ingest,ledger}.ts`, `scoring/timeline.ts`
(fixes only), `access-class.ts`, the events API filter in `server/src/routes/evaluation.ts`, the
`routine_run_occurrences` write in `server/src/services/routines.ts` dispatch, and the
snapshot-payload additions.

**New sources** (evaluation LLD §9.2):
- `agent_corrections`: harness → `assessment.automated` with class `private_pairing:<receiptId>`;
  human → `correction.recorded` with class `private_agent:<agentId>`.
- Routine trigger snapshots with history: cron, timezone and enabled state, each with its event time.
- Routine runs plus their occurrences.
- Deliverable runs.
- `issue_responsibilities`.
- Profile revisions and applications.
- `access.policy_changed` and `access.would_refuse`.
- `issue_execution_decisions`.

**Fixes:**
- `issue.checked_out` → an assignment plus a transition.
- Keep runs and costs that have no issue.
- Keep project- and goal-level verdicts.
- Goal snapshots carry `currentValue`/`lastUpdatedAt`; agent snapshots carry `adapterType` and the model.

**Classes and versioning:**
- Restricted-project events get `project:<id>`.
- The events list and detail filter by class **before** returning anything.
- Milestone inputs change, so bump the milestone formula version, add the change-log note, and
  prove existing milestone tests are green with only the declared differences.
- `subject_agent_id` is set as a lookup hint (evaluation LLD §9.2).

### P3.4 — enforce (server and prompt surfaces), parallel with P3.2

**Owns:**
- `server/src/services/agent-access-check.ts`
- the mode route (accepts `enforce`, admin only, with activity)
- every access LLD §4 call site added in gate 2: refusal handling per the matrix
- the self-widening closures in access LLD §5
- both prompt surfaces: the refusal wording already exists; verify it and extend it where needed

**Refusal behaviour, per matrix row:**
- 403 `ACCESS_POLICY_REFUSED` with body `{ dimension, rule, requested, allowedSummary, howToRequest }`.
- **Lists:** filter.
- **Run claim:** the run doesn't start; a blocker note goes on the issue; the owner is notified
  through the existing path.
- **Mention or comment wake:** the comment is kept and the wake withheld.
- **Export:** out-of-scope projects are omitted and listed as withheld.
- **Runtime skills:** dropped and logged.

**Fixed rules:**
- A V2 refusal overrides the CEO and `reportsTo` fallbacks, in enforce mode.
- `capabilities` leaves both patch lists, in every mode.
- `tasks:assign_scope` is documented as inert and hidden from any UI that offers it. Existing
  grant rows are not deleted.

**Tests:** every matrix row in enforce; refusal bodies; escalation contacts always reachable;
board actors with authority unaffected; MK regression in all three modes.

### P3.3 — agent scoring and cards (server)

**Owns:** `agent-obligations.ts`, `agent-scoring.ts`, `agent-cards.ts`, `calibration.ts`, and
the agent routes in a new `server/src/routes/evaluation-agents.ts` (mounted in `app.ts`). The
gate 1 projection route stays. Snapshots happen on demand and on the existing snapshot cadence
for agents with an applied profile.

**Build** evaluation LLD §5–8 and §10–12:
- **Roles:** producer, responsible, contributor, reviewer, requester, feedback recipient.
- **Mapping:** history and lead/owner intervals.
- **Obligations:** generated from versioned trigger snapshots and matched through
  `routine_run_occurrences`.
- **End states:** blocks recorded only with evidence; otherwise `cause_unknown`.
- **Sections:** the six questions; worker and reviewer kept separate.
- **Agent formulas** (evaluation LLD §6.3):
  - P6 split into refused, repeated and unauthorized execution;
  - P1 respects the contract's expected human steps;
  - judge independence tracked separately from source diversity;
  - rework charged to the producer.
- **Fatal classes** shown first.
- **Roll-up:** milestone cards recomputed with `scoreMilestone` from the same cut and cited with
  their hash.
- **Replay inputs** stored on the card. Verify reproduces the card exactly.
- **Per-viewer projection:** a section built only from classes the viewer can't read shows
  "Not visible to you" with no counts.
- **Cases** drill-down filtered by class.
- **Calibration:** a deterministic sample, plus disagreements, plus fatal flags, routed as review
  items to the named human.
- **Disagreement** exceptions.
- **Dispositions:** `use_confirmed`, `disagreement_noted`, and `criterion_attest` by the named
  attester, bound to its tuple.

**Routes** (evaluation LLD §12):
- `GET evaluation/agents`, `GET evaluation/agents/:agentId[?version=]` and
  `GET evaluation/agents/:agentId/cases`.
- `POST evaluation/agents/:agentId/snapshot`, `GET evaluation/agents/:agentId/verify`.
- The dispositions extension.

**Tests:** evaluation LLD §14 in full:
- determinism with `asOf`; DST; pause and re-enable; catch-up;
- the attribution cases;
- bound vs unbound judgments;
- typed predicates (a shipped deliverable cannot satisfy `pr.merged`);
- no leak through counts;
- projections have no side effects;
- fatal classes come first.

### P3.5 — UI

The Performance tab gets:
- the latest stored card with a "Compute now" projection;
- the six sections from the card;
- every number opening its cases;
- "Not visible to you" sections;
- calibration and disagreement items;
- `use_confirmed` and `criterion_attest` actions where the viewer is the named person.

The Access tab gets enforce states ("Enforced"; refused items). The enforcement card allows
`enforce`, with a confirmation that states what changes. The evaluation overview gains an Agents
list. Same states, accessibility and One UX rules as before.

### P3.6 — gate 3 walkthrough

`server/src/__tests__/apm-gate3-walkthrough.test.ts` covers, over HTTP on embedded Postgres:
- refusals in enforce at representative rows, plus the escalation path;
- a profile with one scheduled responsibility for 3 days, one of which never ran → owed 3,
  delivered 2, the third `cause_unknown`;
- a verdict by a person and one by an independent agent → separate facts;
- a steward without access to a restricted project → no leak in events, card or cases;
- snapshot → verify passes; a second snapshot with no new events reuses the version;
- a calibration review item is created;
- a milestone card differs only by the declared formula bump.

## Verification (orchestrator)

- `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, and all `scripts/ci` checks.
- Regenerate the route index, OpenAPI, MCP reference and search index.
- The P3.6 walkthrough.
- Report exit condition 8 as open until Yang supplies the real responsibility.
