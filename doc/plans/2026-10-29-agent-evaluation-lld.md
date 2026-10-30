# Agent evaluation — low-level design

Status: **Design for Yang's review, revision 2 (after Codex review round 1). Not authorized
for implementation, tests, migrations or trials.**
Date: October 29, 2026. Base: `c625911` plus the uncommitted paired-harness slice.

Part of a three-document LLD:
- [overview and profile](2026-10-29-agent-performance-management-lld.md)
- this document
- [access](2026-10-29-agent-access-lld.md)

Review record: [Codex round 1](2026-10-29-agent-pm-lld-review-codex-r1.md).

Evidence: read-only code inspection on October 29.

## 1. Scope and decisions

The agent is the subject (D1). Project and goal results roll up into the evaluation of
the agents who led them or did the work. Humans author criteria, evidence and thresholds;
agents may draft them for human approval (D2). The output answers the six questions in
overview LLD §1.

This design reuses the Company Evaluator: the ledger (`server/src/services/evaluation/ledger.ts`),
the timeline fold, P-metric functions, `confidence.ts`, `independence.ts`, seq-cut replay
and versioned scorecards. It adds an agent subject. It does not build a second engine.
Where reusing an existing formula would contradict a confirmed decision (§6.3), the
formula changes and its version is bumped.

Four facts stay separate throughout, and none implies another:
- automated acceptance;
- human acceptance;
- use;
- business outcome.

## 2. Subject

- Add `EvaluationSubjectRef = { kind: "project" | "goal" | "agent"; id }`.
  `evaluationMilestoneRefSchema` stays for V1 contracts.
- Agent cards are stored in `evaluation_scorecards` with `milestone_kind = 'agent'` and
  `milestone_id = agentId`. The column is text with no CHECK constraint.
- Card version `agent-card/1`; formula version `agent-metrics/1`.

## 3. Agent contract: criteria a person writes

`evaluationContractV2` is stored as `contract.declared` with source id `agent:<id>` when a
profile revision is applied:

```ts
{ contractVersion: 2, companyId, subjectRef: { kind: "agent", id }, accountableUserId,
  profileRevisionId, independenceRule: "independence/v1",
  responsibilities: Array<{ key: string;
    criteria: EvaluationAcceptanceCriterion[];       // existing: id, text, check?, source
    coverage: CoverageClass[];                       // which evidence groups must be present (§4)
    deadline?: { kind: "after_trigger" | "after_assignment"; hours: number }
             | { kind: "by_date"; date: string };    // goals have no target date column; it lives here
    outcomeLinks: Array<{ goalId: string }>;
    expectedHumanSteps: Array<"approval" | "sign_off" | "answer">;   // not interventions (§6.3)
    judges: { automated: Array<"independent_agent" | "harness" | "evaluator">;
              human?: { userId: string; sampleRate: number; minPerWindow: number } };
    thresholds?: Record<string, number> | null;      // owner-agreed only; null = report only
  }> }
```

**Criterion identity.** A criterion is the tuple
`(contractEventId, responsibilityKey, criterionId, checkHash)`. Every judgment that claims
to evaluate a criterion names this tuple (§5.3). This tightens Rule 17
(`server/src/services/evaluation/scoring/contract.ts:157-159`, where identity is id plus
check) by adding the subject and the contract version. A same-named criterion on another
agent, or a changed check, is a different criterion.

An agent with no applied profile keeps today's derived-contract behaviour:
- no criteria, so acceptance can't be decided;
- the card says so.

## 4. Checks and coverage

**Today.** A `record` check resolves to an evidence class. For example, `pr.merged`
resolves to the generic `delivery_ref`
(`server/src/services/evaluation/scoring/evidence.ts:340`).

**Why that must change.** Broadening that class with business evidence would let a
shipped deliverable satisfy a PR-merge criterion.

**The change.** Each check gets its own **typed predicate**. **Coverage classes** become
only a grouping that says which kinds of evidence must exist.

| Predicate (check) | Inspects | Coverage class |
| --- | --- | --- |
| `pr.merged` (existing, unchanged semantics) | Existing PR evidence | `delivery_ref` (unchanged) |
| `deliverable.shipped` | `deliverable_runs.shipped_at` for the occurrence's run | `deliverable_shipped` (new) |
| `deliverable.checks_passed` | `deliverable_runs.check_passed` with checks run by something other than the assembler | `independent_check` (new) |
| `deliverable.approved` | Both named approvals approved by real (non-synthetic) users | `human_acceptance` (new) |
| `harness.criterion_passed` | A bound harness check (§5.3) for this criterion and work version | `automated_acceptance` (new) |
| `obligation.on_time` | Delivery inside the contract `deadline` (§7) | — |
| `use.confirmed` | A `use_confirmed` disposition by a person, or a later connector record of downstream use | `use_recorded` (new) |
| `metric` on `goal:<goalId>` | Goal snapshot `currentValue` and `lastUpdatedAt` inside the window | — |

- **Goal snapshots don't carry the metric yet.** Today they omit `currentValue` and
  `lastUpdatedAt` (`server/src/services/evaluation/sources.ts:1117-1124`). Ingest adds
  them; earlier history stays unknown.
- **`human_attest`** may be recorded by the named attester (today it is admin-only,
  `server/src/routes/evaluation.ts:573`), and it binds to the criterion tuple, the subject
  and the item.
- **Weak delivery evidence is out of scope.** Today a reviewer hand-off that names a PR
  counts as delivery evidence. That weakness is noted here and not changed.

## 5. Who did what: roles and attribution over time

### 5.1 Roles

| Role | Meaning | Source |
| --- | --- | --- |
| Responsible | The agent whose profile owns the responsibility, during the interval it owned it | `issue_responsibilities` history (§5.2) + `profile.applied` |
| Producer | The agent that produced the assessed work version | Assignee at the transition into `in_review`/`done` for that version, plus the run that moved it |
| Contributor | An agent that did recorded work on the item | Runs, hand-offs and transitions on the item. **Not** comments or views; the current `contributors()` set (`independence.ts:56-103`) stays only for excluding self-review |
| Reviewer | An agent or person that judged it | Verdict, review hand-off, bound judgment |
| Requester | Who asked for the work | Issue creator / wakeup requester |
| Feedback recipient | Whose paired agent receives harness feedback | Harness receipt (`work-evaluations.ts:89`). **Not** a performance subject unless it is also the producer |

**Credit.**
- Delivery credit goes to the **producer at delivery**. Today's O1 rule credits the
  **last snapshot assignee** (`server/src/services/evaluation/scoring/card.ts:101-110`),
  so reassigning an item after delivery moves the credit. The agent card does not use
  that rule.
- Obligation credit goes to the **responsible** agent.
- When the producer and the responsible agent differ, the card shows both.

### 5.2 Responsibility mapping as history

`issue_responsibilities` is an append-only history:

```
id, company_id, issue_id, agent_id, responsibility_key, profile_revision_id,
valid_from, valid_to (null = current), mapped_by (routine | deliverable | planner | agent | human),
mapped_by_actor_id, reason
```

- An issue can map to more than one responsibility, or to several agents over time.
- A transfer closes the old row and opens a new one.
- Routine and deliverable dispatch write rows. An agent maps ad-hoc work when it starts.
  A person can correct a mapping. All of these are ingested.
- Unmapped work has its own bucket on the card.

**Leadership and ownership** are intervals derived from project and goal snapshots across
the window, not taken from the end of the window.

### 5.3 Binding judgments to subjects and criteria

A judgment counts toward a criterion only when it names the criterion tuple (§3), the
subject agent and the work version it assessed.

- **Harness assessments.**
  - `work_read` exposes the approved criteria with their ids.
  - `work_evaluate` checks carry an optional `criterionId`.
  - The server resolves and stores the producer of the reviewed version.
  - This is a later change to the uncommitted paired-harness slice
    (`packages/shared/src/validators/work-evaluation.ts`). It is not authorized now.
- **Unbound checks**, which include every legacy receipt, are kept as *unbound automated
  observations*. They are visible in the drill-down and never satisfy a criterion.
- **"Accepted" covers only what was assessed.** It applies to the criteria actually
  checked; any criterion not checked stays unknown.
- **References are claims, not verified evidence.** References a harness supplies stay
  labelled as such. The server does not verify them (paired-harness contract).

## 6. Scoring

### 6.1 Replay inputs

`scoreAgent(input)` is a pure function of:
- `throughSeq`: the ledger cut;
- `asOf`: the observation time, which decides what is overdue. Obligations become overdue
  without new events, so wall-clock "now" is never used.
- `window`: `{ from, to }`, where `to ≤ asOf`;
- `dependencies`: milestone cards recomputed **from the same cut** (§8). Stored cards are
  never read.

The card stores all four. Verification re-runs with the same inputs. When the formula
version differs, verification reports `formula_changed`, as today
(`server/src/services/evaluation/scorecards.ts:80-93`). Old cards stay as immutable
records; re-verifying them under newer code is not supported, and the card says so.

### 6.2 Membership and sections

Membership:
- obligations of the responsibilities in force (§7);
- issues mapped to them during the window;
- items where the agent was producer, contributor or reviewer;
- projects and goals during the agent's lead/owner intervals.

Card sections, in the order of the overview LLD §1 questions:
1. **Obligations.** Per responsibility: counts by end state, with the denominator.
2. **Quality.** Per criterion: pass/fail/unknown for each judge type (person, independent
   agent, harness, the agent itself), counting bound judgments only.
3. **Acceptance, use and outcome.** The four facts as separate columns, plus the roll-up (§8).
4. **Cost and burden.**
   - agent spend and runs, including unattributed runs (no issue);
   - questions to people (count, median wait);
   - human review and correction actions;
   - optional self-reported minutes, labelled as self-reported.
5. **Bounds** (§6.3).
6. **Gaps.**
   - unmapped work;
   - criteria without checks;
   - coverage classes with no source in this company;
   - requested access that isn't working;
   - unbound judgments.

The agent's work *as a worker* and *as a reviewer* are separate sections. There is no
headline composite.

### 6.3 Semantics that change from the milestone formulas

| Existing | Problem for agents | Agent semantics |
| --- | --- | --- |
| P6 makes every agent `authz.refused` (except `EVALUATOR_READ_ONLY`) an E3 authority breach (`metrics.ts:986`, `:938-943`) | Contradicts "a refusal is an attempt" | Three counts: **refused attempt**; **repeated after refusal** (same dimension and target after a refusal; raises an exception for the owner); **unauthorized execution** (an action that ran outside the policy in force, found in audit records). Only unauthorized execution is E3. |
| P1 counts any human completion as intervention and raises E8 (`metrics.ts:637-665`) | Expected sign-off looks like a rescue | Steps listed in the contract's `expectedHumanSteps` are expected. Only unplanned human edits, corrections or completions count as interventions. |
| Confidence calls different source tiers "independent" (`confidence.ts:52`) | Tier diversity is not assessor independence | Track **judge independence** (who judged, related to the producer or not, through `independence.ts`) separately from **source diversity**. Both are shown. |
| P9 charges rework to reviewers inside milestone cards | Reviewers penalised for others' rework | Rework is charged to the producer, never to a reviewer of the item. |

The agent formulas get their own version. If the same changes are later adopted for
milestone cards, that is a separate formula bump with a change-log entry.

### 6.4 Fatal classes

Any of the following is shown first, whatever the averages, per the workforce protocol:
- fabricated facts, claims or prices;
- leakage across companies or into restricted data;
- unauthorized execution;
- false execution claims.

## 7. Work owed (the denominator)

Owed occurrences are generated from **versioned definitions**, not from execution records.
That way a period in which nothing ran still shows up.

| Kind | Definition (ingested with history) | Occurrence id | Matched to |
| --- | --- | --- | --- |
| Schedule trigger | `routine_triggers` cron, timezone and enabled/paused, from `routine.trigger_snapshot` events with event time | `(triggerId, scheduledFor)` | A routine run carrying `scheduledFor` (dispatch records it; today's run receipts don't identify the occurrence) → linked issue |
| Webhook/API trigger | Each received routine run | `(triggerId, runId)` | Linked issue |
| Deliverable | Runs opened. The cadence is free text (`deliverables.cadence`) | `(deliverableId, runKey)` | Run status |
| Assigned | Issue mapped to the responsibility | `(issueId, mappingId)` | Issue lifecycle |
| Goal | The contract `deadline` (goals have no target-date column, `packages/db/src/schema/goals.ts`) | `(goalId, deadline)` | Goal status and metric |

- **Deliverable periods with no run are "owed periods unknown"**, unless the profile gives
  a structured cadence, which version 1 doesn't require.
- **Catch-up and coalescing** follow the routine's `catchUpPolicy` and `concurrencyPolicy`
  in force at that time. Cancellations are recorded as cancellations.

End states:
- `delivered_on_time`, `delivered_late`;
- `in_progress`, `not_started`, `missed`;
- `blocked_on_person`, `blocked_on_access`, `blocked_on_platform`;
- `skipped_by_policy`, `cancelled`;
- `cause_unknown`.

**A block needs evidence.** It is assigned only with evidence: a pending question or
approval, a refusal on the issue, a scheduler/budget/quota/adapter failure record.
Otherwise the occurrence is `not_started` or `cause_unknown`. Missing runs are not
assumed to be platform faults.

**Version 1 binds existing routines and deliverables.** Applying a profile never creates
or edits triggers. People keep doing that in Routines, so scheduling semantics stay
where they're tested.

## 8. Project and goal roll-up (D1)

The card shows two lists:

- **Accountable results.** Projects and goals during the agent's lead/owner intervals,
  each with its milestone O-metrics (acceptance, on time, rework, goal status, evidence).
  These are recomputed with `scoreMilestone` from the agent card's ledger cut, so replay
  is self-contained. Each one is cited as `(kind, id, throughSeq, formulaVersion, hash)`.
  The scheduled snapshot cadence covers open projects only, not goals
  (`server/src/services/evaluation/schedule.ts:78`), so goal results are always computed
  this way.
- **Delivered work.** Item outcomes where the agent was the producer.

No causal share is claimed. A goal metric moving is an outcome for the owner during the
interval and context for contributors. The two lists are never merged into one number.

## 9. Ledger, ingest and who may read evidence

### 9.1 Access classes on evidence

Today the ledger's list and detail routes check only company access
(`server/src/routes/evaluation.ts:68`, `:94-100`). The harness slice deliberately publishes
only receipt metadata to company activity (`work-evaluations.ts:96-100`). Ingesting its
contents without protection would make private feedback readable by the whole company.

Add `evaluation_events.access_class`:

| Class | Who may read the event and drill into it |
| --- | --- |
| `company` | Members with company access (today's behaviour) |
| `project:<id>` | Principals who may read that project (restricted-project rules) |
| `private_pairing:<receiptId>` | The represented person, the paired agent's steward and accountable user, and admins. Matches the receipt history check (`work-evaluations.ts:113-120`) |
| `private_agent:<agentId>` | The agent's steward, accountable user and admins (memory-like content, human corrections) |

- **Assignment.** Ingest sets the class from the source row. Events for restricted-project
  issues get `project:<id>`. That also fixes a leak that exists in today's ledger.
- **Who sees what.** The events API, case drill-down, exports and generated review items
  filter by class **before** aggregating.
- **Viewer projections.** Cards are computed with full data and stored with their hash,
  but never served raw. The API serves a per-viewer projection. A section built only from
  classes the viewer can't read is shown as "Not visible to you", with no counts.

### 9.2 New sources and fixes

New sources:
- `agent_corrections`:
  - `harness_evaluation` becomes `assessment.automated`, with bound criterion results,
    class `private_pairing`;
  - human corrections become `correction.recorded`, class `private_agent`.
- Routine trigger snapshots, with history, and routine runs.
- Deliverable runs.
- `issue_responsibilities`.
- Profile revisions and applications.
- `access.policy_changed`, `access.would_refuse`.
- `issue_execution_decisions`.

Fixes:
- `issue.checked_out` becomes an assignment plus transition event. Today it lands as
  `activity.other`.
- Runs and costs without an issue are kept as unattributed cost.
  `buildTimeline` currently drops events without `issueId`
  (`server/src/services/evaluation/scoring/timeline.ts:314-430`).
- Project- and goal-level verdicts are kept.

Snapshot payloads gain:
- goal `currentValue` and `lastUpdatedAt`;
- agent `adapterType` and model.

Today's agent snapshots omit both (`sources.ts:998-1019`), so "which runtime" is known
only from the change forward.

**Lookup hint.** `evaluation_events.subject_agent_id` is a nullable uuid with an index
`(company_id, subject_agent_id, seq)`, plus an `actor_id` index. Scoring re-derives roles
from the timeline (§5).

Changes that alter milestone inputs (checkout events, kept costs and verdicts) bump the
milestone formula version and get a change-log entry.

## 10. Human judgment

- **Calibration sample.** For each responsibility with `judges.human`, a deterministic
  sample is routed to that person through the existing review-items path:
  - `hash(issueId, window.from) < sampleRate`, at least `minPerWindow` items;
  - plus every criterion-level disagreement;
  - plus every potentially fatal flag.

  The person closes each item with a bound verdict or `criterion_attest`. Agreement per
  judge is reported with denominators, and only for bound judgments.
- **Disagreement.** Both records stay. The disagreement is routed to the accountable user
  as an exception, not settled by vote.
- **Profile revisions.** Results are grouped by the profile revision in force. A changed
  criterion (a new tuple) starts fresh.

## 11. Snapshots, side effects, visibility

- **Snapshots.** Agents with an applied profile, in companies that have the evaluator's
  snapshot flag on; or on demand by an admin or the accountable user. A snapshot appends
  findings and creates review items, as milestone snapshots do (`scorecards.ts:51-77`).
- **Read-only projection.** `GET .../evaluation/agents/:agentId/projection` computes a
  card from the current ledger cut without storing anything, appending findings or
  creating review items. M1 uses this.
- **Who can see a card.** Admins, the accountable user and the steward, plus members with
  agent visibility for the parts they can read (§9.1). Burden details that name people
  are visible to admins and the accountable user only.

## 12. API (company-scoped)

| Route | Purpose | Who |
| --- | --- | --- |
| `GET evaluation/agents` | Latest card summaries (per-viewer projection) | §11 |
| `GET evaluation/agents/:agentId[?version=]` | Stored card, projected | §11 |
| `GET evaluation/agents/:agentId/projection` | Side-effect-free projection at the current cut | §11 |
| `GET evaluation/agents/:agentId/cases?responsibility=&state=` | Drill-down, filtered by access class | §11 |
| `POST evaluation/agents/:agentId/snapshot` · `GET .../verify?version=` | Snapshot (has side effects) · replay check | Admin, accountable user |
| `POST evaluation/dispositions` | Adds `use_confirmed` and `disagreement_noted`; `criterion_attest` by the named attester, bound to the tuple | As listed |
| `POST issues/:issueId/responsibility` | Append a mapping row | Assignee agent, planner, steward, admin |
| `GET evaluation/events` | Existing route, now filtered by `access_class` | Company access + class rule |

## 13. Migrations (proposed)

1. `evaluation_events`: add `access_class` (text, default `company`), `subject_agent_id`,
   and indexes `(company_id, subject_agent_id, seq)` and `(company_id, actor_id)`.
2. `issue_responsibilities`: history table (§5.2).
3. Routine run occurrence time (`scheduledFor`) recorded at dispatch. It goes in the run's
   trigger payload if that is enough; otherwise a nullable column. Decide at
   implementation by reading `routine_runs`.
4. No change to `evaluation_scorecards`.

## 14. Verification to write later (not run)

- **Replay determinism** with `asOf`. DST and timezone occurrence generation. Paused or
  re-enabled triggers. Catch-up and coalescing.
- **Attribution:** reassignment after delivery; several agents on one issue; reviewer vs
  producer; harness feedback to a non-producer.
- **Bound vs unbound judgments:** a legacy receipt never satisfies a criterion; a changed
  check starts fresh; attestations don't cross subjects.
- **Typed predicates:** a shipped deliverable cannot satisfy `pr.merged`.
- **Access classes:** private receipts and restricted-project evidence never reach an
  unauthorized viewer, including through counts.
- **Projections** have no side effects.
- **Fatal classes** surface first.

## 15. What this does not claim

- Human-burden counts are proxies, not minutes saved.
- No baseline or threshold exists until an owner agrees one from measured cases. New
  work may have no prior baseline at all.
- An accepted, shipped deliverable doesn't prove use or business effect.
- History before the new ingest sources and snapshot fields stays unknown, and is
  reported as unknown.
