# Company Evaluator — authority calibration and milestone contracts (working plan)

Status: **preparation, nothing merged, nothing enforced.** Branch `evaluator/m5-calibration`
(cut from `main` at f24a8980b on 2026-09-07). Company **Agent Runner** on the local instance
execos-local; milestone cards v1 (`m2-score/7`) stored 2026-09-06; four immediate E3 items
AGE-106–AGE-110 **open, pending the founder's disposition** — this plan does not close them.

## 0. Direction (founder, 2026-09-07) and what this plan does with it

The founder's written direction of 2026-09-07 replaced an earlier truncated instruction. In
substance: clarify evaluator role authority first, then define milestone criteria; check the
existing mandates before asking the founder to resolve any ambiguity; persist the direction in
the durable working plan; gather evidence and prepare concrete proposals. Five items:

1. A compact **authority matrix** from founder-approved mandates — role, allowed transitions,
   scope, required approval or verdict evidence, source — covering Maya's review-queue/merge
   authority and Priya's initial triage. Task assignment alone does not establish a breach; role
   titles do not confer blanket permission. → §1.
2. **Reassess the four flagged moves** against the matrix, preserving ledger and verdict
   history; distinguish authorized, unauthorized and insufficient evidence. AGE-20 is an
   ambiguity, not an established dispute; check whether Maya's coordination mandate covers
   moving Theo's task into review. Check AGE-14's closure evidence despite its absent verdict
   record. → §2.
3. A **narrow rule-change proposal with regression cases** for authorized cross-assignee
   review/triage, unauthorized or out-of-scope transitions, and missing authority evidence;
   preserve the second-milestone-evidence gate before changing the active rule; report what
   clears that gate. → §3.
4. **Draft evaluation contracts** for the MVL 1.0 Launch and the Company Evaluator build:
   scope, accountable owner, measurable acceptance criteria, evidence sources, scoring
   prerequisites, target dates, cost measurement and budget boundaries — facts marked as
   facts, proposed and undecided values marked as such; no invented dates, caps or
   thresholds; milestone confirmation stays the founder's. → §4.
5. A **bounded evaluator-agent wake policy**, distinct from the five-minute ingest and the
   daily card schedule, with implications and the decision left explicit. → §5.

Constraints restated: AGE-106–110 stay open; this direction approves no closing, no scoring
formula, no spending, no production change. Finish the safe preparation, then present one
consolidated set of founder decisions (§6). The next workstream after this one is recorded in
§8 and is not started.

## 1. Authority matrix (from founder-approved records only)

Sources are records on the board, not role titles. "Founder" is the board actor `local-board`
(the only human principal on the instance; a synthetic identity under spec rule 15).

| Role / actor | Allowed transitions | Scope | Required evidence | Source (record) |
|---|---|---|---|---|
| **Assignee agent** | `backlog/todo → in_progress`, `in_progress → in_review`; **never → done** | own items only | assignment record (`issue.assignment_changed` or snapshot) | default agent prompt, verdict-workflow block ("transition to `in_review` (NOT `done`)… the verdict — not your assertion — closes the loop") |
| **Neutral validator** (Chief of Staff or a CoS-hired reviewer; the queue here assigns the "CoS Reviewer" agent) | `in_review → done` (pass) or `→ in_progress` (revision) | items in the review queue | a `verdicts` row by an independent reviewer (never the assignee; `NEUTRAL_VALIDATOR_VIOLATION` otherwise) | same prompt block; data-surfaces spec §5 (`verdicts`, `issue_review_queue_state`) |
| **Maya (CEO) — reconciliation directive** | status moves that resolve a board-vs-repository mismatch, incl. `done → in_review` and `in_review → done` | MVL 1.0 items | "safely and reversibly", evidence posted on the item; no release, deploy, MK contact or policy finalization | AGE-40 owner directive 2026-09-05 03:23Z and owner nudge 03:32Z ("Resolve board/repository status mismatches where this can be done safely and reversibly"); ratified by the founder's board comment on AGE-3 at 04:56Z (set AGE-3 blocked on AGE-56) |
| **Maya (CEO) — execution cadence** | at a handoff: assign the recipient and **set status correctly**; daily: repair missing ownership and stale handoffs | active 1.0 work; durable company cadence | "link the evidence needed to act. Comments alone are not a handoff"; production release stays Eyan's go/no-go | AGE-46 (created by the founder 04:27Z, done 05:05Z); founder verification comment 04:56Z ("Maya's owner/status handoffs landed") |
| **Priya (PM) — backlog triage** | move shipped-but-open items → `done` **with PR references**; classify every open issue; **propose** execution order naming Theo/Jules | "the AGE backlog" as of 2026-09-04 (37 issues named or enumerated) | PR reference for a close; one-line rationale per classification | AGE-38 (created by the founder 2026-09-04 14:47Z) |
| **Priya (PM) — triage of later items, assignment** | not stated | AGE-104 (created 2026-09-06, evaluator project) is outside the enumerated set | — | practice only: PM handoffs `pm_to_builder`; Priya reported the AGE-104 assignment on AGE-38 at 07:23Z, no objection recorded. **Ambiguity, recorded, not a founder question unless triage of new items is to be a standing PM duty (D-A3)** |
| **Theo (Engineering Lead)** | none recorded on others' items; technical review verdicts as comments | AGE-45 = the single review queue (AGE-46 outcome) | prose verdicts only ("VERDICT: APPROVED for merge decision" on AGE-3) — not `verdicts` rows | AGE-45/AGE-46 |
| **Any agent** | none on human-owned items (`assigneeUserId` set) | — | — | rule cited by Priya on AGE-38 (05:13Z); its text was not located in the repository — recorded as cited, not verified |
| **Founder** | all; merges; decisions | all | — | repository owner; PR #518 merged by the founder 2026-09-04 16:10Z |
| **Evaluator** | none (read-only principal, spec §10.2) | — | — | mechanism, not prompt |

Two facts that shape everything below: the company has **zero `verdicts` rows**, and agents
receive **403 on the DoD PUT** ("agents cannot change company direction", Theo on AGE-20 at
05:14Z). The sanctioned close path therefore leaves no structured record on this instance.

## 2. Reassessment of the four flagged moves

Ledger and verdict history are preserved: the four `exception_reviewed` dispositions filed on
2026-09-07 (events f4bc6efb, 977ece05, 7d23c69c, f257fc36; all `false_positive`) stand. This
section refines their **grounds**; the refinement is recorded as two `shadow_note`
dispositions (topics `missing_telemetry` and `disagreement`), not by editing history.

| Item | Flagged event | What the record shows | Classification |
|---|---|---|---|
| **AGE-20** (Theo) | `9f886235` Maya, `? → in_review`, 05:56:40Z | `from: null, fromUnknown: true`. Theo himself moved the item `in_progress → in_review` at 05:01:33Z (`a3f1ab14`). Maya's PATCH at 05:56:40Z wrote `status: in_review` with **no `_previous`** — the route writes `_previous` only when a field changed, so nothing changed. Theo confirmed the outcome at 05:59:57Z. | **Insufficient evidence — no transition occurred.** The ambiguity ("may Maya move Theo's task into review?") is moot for this event. Had a real move happened, AGE-46 ("at each handoff… set status correctly") covers it; no founder question needed. |
| **AGE-104** (Jules) | `db41a264` Priya, `? → todo`, 2026-09-06 07:20:27Z | same row as the assignment `1cb59feb` (null → Jules); `_previous` carried only `assigneeAgentId` — status unchanged. The rule saw Jules as owner because the item's only snapshot (08:46Z) post-dates the move and `snapshotAt` falls back to it. | **Insufficient evidence — no transition; owner projected backward** (measurement defect). The assignment itself is not a P6 subject; Priya's authority to assign new items is the recorded ambiguity D-A3. |
| **AGE-3** (Jules) | `e42d399b` Maya, `done → in_review`, 03:36:39Z | Jules had self-closed `blocked → done` at 2026-09-04 16:02Z with the fix **not on main** (PR #598 open). Four minutes after the founder's nudge (03:32Z) Maya reopened with evidence; the founder then set the item blocked on the merge decision AGE-56 (04:56Z). | **Authorized** (AGE-40 nudge; founder ratification on the item). The rule cannot see a directive that lives in a comment. |
| **AGE-14** (Jules) | `87608189` Maya, `in_review → done`, 03:36:39Z | PR #518 merged by the founder (`8d9bc1a9`, 2026-09-04 16:10Z); Jules moved to `in_review` for neutral validation at 16:36Z with the CoS Reviewer as queue reviewer; **no verdict row** exists. Maya closed citing the merge, reversible. | **Authorized by the AGE-40 nudge; closure evidence incomplete.** The merge evidence is real (T1: GitHub). The missing `neutral_verdict` is an evidence-class gap (O1/O5, E1 territory), not an authority breach — and on this instance agents cannot write verdicts at all. |

Under the matrix the four items split 2 authorized / 0 unauthorized / 2 insufficient evidence.
None is a confirmed authority breach.

## 3. Rule-change proposal (P6 "transition of an item you are not assigned to")

### 3.1 Implemented (6a/6b) — gate cleared by the founder on 2026-09-07 (D-R1)

| Rule | Change | Why |
|---|---|---|
| **6a unknown previous status** | a transition with `from == null` is not judged; counted in `detail.insufficient.unknownFrom`, cited in the metric's refs, one note | the PATCH route records `_previous` only for changed fields; a status write without a previous status evidences no state change (AGE-20, AGE-104) |
| **6b owner at the time** | owner comes from `assigneeAtStrict` — assignment or snapshot **at or before** the move; none → `detail.insufficient.ownerUnknown`, not judged | `snapshotAt` falls back to the first snapshot even when it is later; a later assignee must not be projected backward (AGE-104) |

Order of checks (after the independent review, below): actor is the agent → owner at the time via
`assigneeAtStrict` → an agent's **own or an unassigned item is never a candidate** → then 6a
(`from == null`, counted, cited at tier T0) → then 6b (owner unknown, counted, cited) → detection.
The strict lookup scans every record rather than stopping at the first later one, because replay
order is exact only to the five-minute skew bucket.

**Known consequences, recorded, not fixed here.** (a) `issue.created` mints no assignment record,
and an item's first snapshot carries `updatedAt`, so an item **assigned at creation** and moved by
another agent before its first snapshot now reads `ownerUnknown` where `m2-score/7` raised a
detection — faithful to "never fabricate an owner", but a coverage loss; the durable fix is an
assignment record at creation (follow-up, §7). (b) The `self_review` rule inside the same metric
still reads ownership through `assigneeAt`, which falls back to a later snapshot — the very
mechanism 6b removes; changing it is the same defect class but was not part of D-R1
(decision **D-R3**, §6). (c) The new `insufficient` counts reach a reader only through the notes;
the dashboard drops nested detail (follow-up, §7).

Formula pins moved with the arithmetic: `FORMULA_VERSION` `m2-score/8`, `METRICS_FORMULA_VERSION`
`metrics/5` (composites untouched, `composite/6`); the contract fixture was regenerated. Cards
stored before the change report "formula changed" on verify; the first snapshot after
deployment is the new baseline. Exception keys are stable, so the four dispositions keep
pointing at the v1 findings; on a re-scored card the AGE-20 and AGE-104 findings are no longer
raised, and precision is computed on what is raised.

Regression cases (`server/src/__tests__/evaluation-p6-authority.test.ts`, 9 passing): the
reviewer's close after its own passed verdict is **still a detection** while 6c is held;
unauthorized `in_progress → done` by a non-assignee; out of scope — a verdict on another item or a
failed verdict never changes the judgment; missing evidence — unknown previous status (6a), owner
known only from a later snapshot (6b) and the same move judged once an assignment precedes it; a
reopen `done → in_review` by a non-assignee stays a detection while the assignee's own moves never
count; 6a ignores the assignee's own no-op writes and a human's writes; a recorded previous status
is judged whatever the emitter's `fromUnknown` flag says; a window where 6a and 6b both fire hashes
identically in any event order.

**Independent review round (2026-09-07, reviewer outside the author's context): CHANGES REQUESTED
→ addressed.** Blocking: 6a ran before the own-item check, so an agent's routine no-op writes on
its own items inflated the "not judged" count, printed the note on clean agents and pushed
irrelevant ids into the 200-slot evidence list — fixed by ordering the owner check first. Also
taken: refs now carry tier T0; the strict lookup no longer stops early; four test gaps closed.
Recorded, not changed: consequences (a)–(c) above. Confirmed by the reviewer: no emitter can
produce `from == null` for a real state change (PATCH `_previous` is built over the final fields;
reopen paths carry `reopenedFrom`; recovery-service transitions are `system` actors and never
reach P6), so 6a hides nothing; determinism holds under shuffle; `composite/6` is right to stay.

### 3.2 Held for the second milestone's evidence (D-R2, decided 2026-09-07): 6c and 6d

**6c sanctioned close (held).** `in_review → done` by an agent that recorded a passed verdict on
that item at or before the move would be recorded as `authorized.verdictClose`, not a violation —
the verdict workflow's own step. It was implemented and tested on this branch, then removed under
D-R2; the test file keeps the case asserting today's behaviour so the carve-out is a deliberate
future change, not drift. It changes nothing on the live cards (zero verdicts).

**6d recorded authority grants (held, design only).**

The two real moves (AGE-3, AGE-14) were authorized by prose the founder wrote minutes earlier.
The spec is right that prose neither credits nor penalises; the fix is to give authority a
record. Proposal: a ledger event `authority.granted`, declared by an administrator (human) via
`POST …/evaluation/authority-grants`, fields `{ grantee: {kind: agent|role, id}, scope: {projectId |
issueIds}, transitions: [{from?, to}] | "any", validFrom, validUntil | null, evidenceRequired:
["comment_with_evidence" | "pr_reference" | "verdict"], source: "AGE-40 owner nudge 03:32Z" }`.
P6 rule 6d: a move covered by a grant in force at the time, with the required evidence class
present on the item, is `authorized.grant`; a move covered by a grant but lacking the evidence
is a **new exception class "authorized move without evidence"** (routine, not immediate); a move
outside every grant stays E3. Cases to add when the event exists: grant-covered coordinator move
(no E3); grant on project P, move in project Q (E3); grant expired (E3); grant present, evidence
absent (routine exception, not E3).

What would be transcribed as grants if the founder agrees (D-A1, D-A2): AGE-40 nudge → Maya,
MVL items, any status, evidence `comment_with_evidence`, valid for the run (03:32Z–05:05Z) or
standing; AGE-46 → Maya, active 1.0 items, "set status at handoff", evidence `comment_with_evidence`;
AGE-38 → Priya, the enumerated backlog, `→ done` with `pr_reference`, plus classification.

### 3.3 The gate — decided 2026-09-07

Founder decision: **D-R1 yes — 6a/6b clear the gate as defect fixes; D-R2 hold — 6c and 6d wait
for the second milestone's evidence.** The assessment that led there:

- **6a and 6b are measurement defects, not calibration.** They mint state changes that never
  occurred and attribute ownership from the future — the ledger rule "label historical gaps as
  unknown, never passed" already forbids both. Recommendation: **eligible to clear the gate now**
  as defect fixes (founder decision D-R1); they change no authority semantics.
- **6c is a calibration change** (a carve-out) — it waits for the second milestone unless the
  founder lifts the gate for it (D-R2). It changes nothing on the current cards (zero verdicts).
- **6d needs a design decision** (D-A1/D-A2) before code; it waits for the gate regardless.

6a/6b land through the normal lane (independent review, CI green, squash merge). The instance
running the shadow evaluator picks the change up only when the founder orders a restart; the
first snapshot after that is the `m2-score/8` baseline.

## 4. Draft evaluation contracts (spec §4, `evaluation_contract/v1`)

Legend: **FACT** (on the board or in the ledger) · **PROPOSED** (my proposal for the founder to
accept or change) · **UNDECIDED** (the founder's to set; deliberately left blank).

### 4.1 Shared prerequisites (both milestones)

1. **Identity for attestations.** The only human principal is `local-board`, a synthetic
   identity; `human_attest` checks decided by it never confer independence (rule 15). Either the
   founder attests from a personal identity on the instance, or attest-checks stay unmeasurable.
   (D-C1)
2. **Verdict records.** Zero `verdicts` rows; agents get 403 on DoD PUT. `record: verdict.passed`
   checks cannot be met until the verdict path works for the CoS/reviewer on this instance.
   (D-C2: fix the path, or accept `human_attest` in its place for Stage 1.)
3. **Delivery records.** No GitHub adapter (spec D4 optional); `pr.merged` is not a ledger record
   today. Merge evidence is T1 prose (PR numbers in comments) until D4 lands. (D-C3)
4. **Cost telemetry is not trustworthy.** Three `cost.recorded` events in the whole company: 0 ¢
   / 168 tokens (Theo), 25 ¢ / 0 tokens (Jules), **450 000 ¢ / 0 tokens** (Priya, run a9ca5ddb,
   2026-09-05 22:28Z); company spend reads 450 025 ¢ against a budget of 0. E7 "metering absent"
   is raised on all four agents. Cost criteria must be **token-based from the Hermes ledger**
   with cents shown only where a provider reports them, and the 450 000 ¢ row needs a correction
   record before any cost cap means anything. No cap is proposed here (D-C4).
5. **Target dates.** Neither project carries `targetDate`; issues carry none. O2 is insufficient
   by construction until a date is set (D-C5, D-C6).

### 4.2 MVL 1.0 Launch — draft

```jsonc
{
  "contractVersion": "v1", "source": "declared",
  "companyId": "ff60936e-fd79-4a34-98ae-02e5e7a07250",                    // FACT
  "milestoneRef": { "kind": "project", "id": "e21af1b7-b0a9-4ae8-9284-fab818c3a414" }, // FACT
  "goalId": "dbde7bca-220d-41d0-9339-d8b33ea95eb8", "parentGoalId": null, // FACT (Ship Agent Runner 1.0)
  "accountableUserId": "local-board",   // FACT today (only human); see D-C1
  "leadAgentId": "fe33471c-751c-48c0-b7f1-25e21d865321",                  // FACT (Priya, project lead)
  "definitionOfDone": "Priya's launch gate (AGE-38, 2026-09-04): every launch-blocker closed with evidence on the launch instance; rollout notes per shipped fix; the three founder decision gates recorded; a release-readiness brief with validation evidence, known risks and rollback notes.", // FACT (text) — PROPOSED as the DoD
  "acceptanceCriteria": [                                                  // PROPOSED set; checks marked
    { "id": "mvl-1", "text": "PR #562 (Docker/CD build order) merged — an installable image exists", "source": "AGE-57 / Maya §4", "check": { "kind": "record", "record": "pr.merged" } },   // check UNMEASURABLE until D-C3
    { "id": "mvl-2", "text": "PR #598 (governance read for the accountable human) merged", "source": "AGE-56 / AGE-3", "check": { "kind": "record", "record": "pr.merged" } },
    { "id": "mvl-3", "text": "AGE-25, AGE-3, AGE-14, AGE-20, AGE-33, AGE-15, AGE-1, AGE-50 closed with an independent passed verdict", "source": "AGE-38 pillars / Maya §2", "check": { "kind": "record", "record": "verdict.passed" } }, // needs D-C2
    { "id": "mvl-4", "text": "Founder decisions AGE-26, AGE-4, AGE-7 recorded on their issues", "source": "AGE-38 launch gate (c)", "check": { "kind": "human_attest", "attesterUserId": "UNDECIDED (personal identity, D-C1)" } },
    { "id": "mvl-5", "text": "Rollout notes on the launch instance for #571–#573, #584–#586, AGE-23/24 (instance + SHA)", "source": "AGE-38 launch gate (b)", "check": { "kind": "human_attest", "attesterUserId": "UNDECIDED" } },
    { "id": "mvl-6", "text": "Scoped-actions e2e over the Steward Inbox approve path exists and passes on main", "source": "Maya §1", "check": { "kind": "record", "record": "ci_green" } },   // record form PROPOSED
    { "id": "mvl-7", "text": "Release-readiness brief posted on AGE-59 and the go/no-go assigned to Eyan", "source": "AGE-59", "check": { "kind": "record", "record": "issue.done:AGE-59" } }, // record form PROPOSED
    { "id": "mvl-8", "text": "Release notes' migration delta and squash count match main at the cut", "source": "TRACK B / Maya §2", "check": { "kind": "human_attest", "attesterUserId": "UNDECIDED" } }
  ],
  "requiredEvidence": ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"], // PROPOSED = engineering default (no waiver)
  "independenceRule": "independence/v1", "excludedReviewers": [], // PROPOSED: none excluded beyond the rule
  "founderLocks": ["AGE-26", "AGE-4", "AGE-7", "AGE-56", "AGE-57", "AGE-58", "AGE-51"],       // PROPOSED (ids to be resolved to uuids): the founder-decision and secret tasks
  "outcomeTarget": null,                       // UNDECIDED — no metric definition exists on the goal
  "targetDate": null,                          // UNDECIDED (D-C5); nothing on the board sets one; "Tuesday 10:00 PT train" is Maya's cadence proposal, not a date
  "downstreamRiskAcceptance": null,            // UNDECIDED — AGE-4 egress risk posture is the founder's pending verdict
  "windowStart": "2026-09-04T14:47:26Z",       // PROPOSED: AGE-38 created (the project's first issue); the ledger holds earlier records for member items
  "windowEnd": null                            // FACT: open milestone
}
```

Cost measurement and budget boundary (MVL): **PROPOSED** unit = tokens per run per agent from the
Hermes ledger, reported per milestone on the card next to `meteredRuns/runs`; cents shown only
when a provider reports them; the evaluator's own runs reported separately (§5). **UNDECIDED:**
cap (D-C4). Scoring prerequisites: D-C1–D-C3 and the 450 000 ¢ correction (D-C4).

### 4.3 Company Evaluator — Stage 1 (shadow) — draft

```jsonc
{
  "contractVersion": "v1", "source": "declared",
  "companyId": "ff60936e-fd79-4a34-98ae-02e5e7a07250",
  "milestoneRef": { "kind": "project", "id": "3313d8d1-26d9-4623-8dd7-b2c01a047d6b" },      // FACT
  "goalId": "3c58a6a2-778d-4b03-9af7-c466b684a181", "parentGoalId": null,                    // FACT (Trustworthy autonomy)
  "accountableUserId": "local-board",   // PROPOSED: the derived contract has null here (no project lead); the provisioning administrator per D12
  "leadAgentId": null,                                                                        // FACT (no lead; built in the founder lane)
  "definitionOfDone": "The founder's 2026-09-05 mandate: milestones 0–5 delivered with independent review, then an evidence-backed recommendation (remain read-only / revise / propose an enforcement policy) — enforcement never activated.", // FACT (mandate text)
  "acceptanceCriteria": [
    { "id": "ev-1", "text": "M0–M5 landed on main with independent review recorded on AGE-84…AGE-103", "source": "mandate M0–M5", "check": { "kind": "record", "record": "pr.merged" } },        // PRs #608–#619 are FACT; the check is UNMEASURABLE until D-C3
    { "id": "ev-2", "text": "100% of material or immediate claims cite ledger events", "source": "graduation criterion", "check": { "kind": "metric", "metricKey": "shadow.material_claims_traced", "target": 1, "unit": "share" } },
    { "id": "ev-3", "text": "Zero self-review and zero authority mutations by the evaluator", "source": "graduation criterion", "check": { "kind": "metric", "metricKey": "shadow.authority_breaches", "target": 0, "unit": "count" } },
    { "id": "ev-4", "text": "Deterministic replay agreement ≥ 95%", "source": "graduation criterion", "check": { "kind": "metric", "metricKey": "shadow.replay_agreement", "target": 0.95, "unit": "share" } },
    { "id": "ev-5", "text": "Precision and recall ≥ 90% on agreed material exceptions, every miss reviewed", "source": "graduation criterion", "check": { "kind": "metric", "metricKey": "shadow.precision_recall", "target": 0.9, "unit": "share" } },
    { "id": "ev-6", "text": "At most one routine evaluator message per milestone", "source": "graduation criterion", "check": { "kind": "metric", "metricKey": "shadow.chatter", "target": 1, "unit": "count" } },
    { "id": "ev-7", "text": "Evaluator model cost capped and reported per milestone", "source": "graduation criterion", "check": { "kind": "metric", "metricKey": "shadow.cost", "target": 0, "unit": "UNDECIDED (D-C4)" } },
    { "id": "ev-8", "text": "Two milestones completed without the founder rescuing ordinary flow", "source": "graduation criterion", "check": { "kind": "human_attest", "attesterUserId": "UNDECIDED (D-C1)" } },
    { "id": "ev-9", "text": "Playwright flow over a live server for the evaluation surfaces passes in CI (AGE-104)", "source": "M4 review follow-up", "check": { "kind": "record", "record": "ci_green" } }
  ],
  "requiredEvidence": ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"], // PROPOSED default
  "independenceRule": "independence/v1",
  "excludedReviewers": ["90d17536-7b10-46f0-8c2d-702b0adca4cd"],  // PROPOSED: the evaluator agent may never review its own build (spec §10.4, rule 12)
  "founderLocks": [],                            // PROPOSED: none
  "outcomeTarget": { "metricKey": "shadow.precision_recall", "target": 0.9, "unit": "share", "source": "shadow-report" }, // PROPOSED (the mandate's own number)
  "targetDate": null,                            // UNDECIDED (D-C6): the mandate sets no date; "two consecutive real milestones" is the horizon
  "downstreamRiskAcceptance": null,              // UNDECIDED
  "windowStart": "2026-09-05T17:45:00Z",         // FACT: the mandate's receipt; project created the same day
  "windowEnd": null
}
```

The `shadow.*` metric keys are **PROPOSED**: today those measurements live in the shadow report
(`measureMilestone`), not in `goals.metricDefinition`; wiring the `metric` check to the report is
the small piece of work that makes ev-2…ev-7 measurable (no decision needed, listed in §7).

## 5. Evaluator-agent wake policy (bounded)

What already runs, and needs no model: **ingest** every 5 minutes (`AGENTDASH_EVALUATION_INGEST_ENABLED`)
and the **snapshot cadence** daily (`AGENTDASH_EVALUATION_SNAPSHOT_ENABLED`) — cards, exceptions
and review items are deterministic projections. The evaluator **agent** is a separate thing: a
`hermes_local` agent, status **paused**, no heartbeat schedule (`runtimeConfig.heartbeat` carries
only `maxConcurrentRuns: 20`), monthly budget 0, prompt budget 150k tokens per card with a 500k
hard cap. It is invoked only for judgment the rules cannot make (E2 with two T0 sides, gaming
signals under rules 10–16, ambiguous E5 paths, P2 quality notes, severity triage above five
material exceptions). **On the current cards there are zero such cases.**

Wake surfaces that exist: `POST /api/agents/:id/heartbeat/invoke` and `POST /api/agents/:id/wakeup`
(board actor with manage-agents permission; the agent may also invoke itself). Nothing wakes it
today, by design.

| Option | What happens | Implications |
|---|---|---|
| **W0 — stay paused; founder invokes by hand per case** (current) | zero model cost; judgment notes only when the founder asks | judgment lags the card by however long the founder takes; fine while judgment cases are zero |
| **W1 — bounded automatic wake after the daily snapshot** (PROPOSED design) | after each cadence tick, if a stored card carries ≥1 judgment-eligible exception with no `evaluation.finding` on its key, invoke once with the card's token budget; ceilings: ≤1 run per milestone per day, ≤N runs per month (N UNDECIDED), hard stop at the budget; every run's tokens recorded on the evaluator's own card | judgment within a day of the card; cost bounded by count × token budget; requires un-pausing the agent and trusting the cost telemetry (§4.1 item 4) |
| **W2 — no agent runs in Stage 1** | deterministic only; the judgment classes stay "not reviewed" | cheapest; loses the M3 capability the mandate asked for |

Recommendation: **W0 now, W1 designed and switched on only by the founder** once (a) a judgment
case actually appears on a card and (b) the cost telemetry is trustworthy enough to report the
runs. Decision D-W1 below. The wake never changes the cadence: ingest and snapshots stay
deterministic and unaffected.

## 6. Consolidated founder decisions (the one list)

Authority
- **D-A1** Record authority as ledger grants (§3.2) rather than prose? If yes, who declares them
  (administrator route) and do the AGE-40 / AGE-46 / AGE-38 directives get transcribed now?
- **D-A2** Is Maya's reconciliation authority (AGE-40 nudge) standing, or was it for that run only?
- **D-A3** Is triage-and-assignment of newly filed items a standing PM duty (Priya), or does it
  need a handoff record each time?

Rule change (branch `evaluator/m5-calibration`, not merged)
- **D-R1** Clear the gate for 6a/6b as defect fixes now? — **decided yes, 2026-09-07.**
- **D-R2** Hold 6c and 6d for the second milestone's evidence? — **decided hold, 2026-09-07.**
- **D-R3** Apply the 6b discipline (no backward projection of ownership) to the `self_review` rule
  as well? Same defect class, separate change with its own pin bump.

Contracts (§4)
- **D-C1** Personal founder identity on the instance for `human_attest` checks.
- **D-C2** Make the verdict path usable by the CoS/reviewer, or accept attest in its place for Stage 1.
- **D-C3** Build the GitHub adapter (D4) so `pr.merged` is a record, or accept T1 merge evidence.
- **D-C4** Cost cap (both milestones) and the correction of the 450 000 ¢ row.
- **D-C5** MVL target date. **D-C6** Evaluator-build target date.
- **D-C7** Confirm the two milestones (D3) and accept or edit the two drafts; then I post them.

Wake
- **D-W1** W0 / W1 / W2; for W1 the monthly run ceiling N.

Review items AGE-106–110 remain open until the founder disposes of them.

## 7. Validation and what is on the branch

- `server/src/services/evaluation/scoring/metrics.ts` (P6 rules 6a/6b, `metrics/5`),
  `scoring/timeline.ts` (`assigneeAtStrict`), `scoring/card.ts` (`m2-score/8`), regenerated
  `ui/src/pages/evaluation/__fixtures__/scored-card.json`, version pins in three tests, new
  `server/src/__tests__/evaluation-p6-authority.test.ts`, this plan.
- Verification on the branch (2026-09-07): `pnpm -r typecheck` clean for every package; the twelve
  `evaluation-*`/`evaluator-*` server suites pass (159 tests, including the 9 P6 cases); the four
  UI evaluation suites pass against the regenerated fixture (14 tests); the agents-md drift check and
  the forbidden-token scan pass. The rule on `main` is unchanged.
- Small follow-ups needing no decision: expose the shadow report's measurements as `shadow.*`
  metric keys for `metric` checks (§4.3); carry `assignedReviewerAgentId` from
  `queue_state_changed` rows into the ledger so the queue's reviewer is a record; mint an
  `issue.assignment_changed` record when an issue is created already assigned (closes the 6b
  coverage loss); render nested metric detail (the `insufficient` counts) on the dashboard.

## 8. Next workstream (queued, not started): Agent Dash SaaS offering

Founder direction of 2026-09-07 (separate file, read in full): after this preparation, design
Agent Dash's SaaS offering and the signup-to-box journey for agentdash.cloud — today a public
front page whose login leads to no real multi-tenant offering. Scope: capabilities and hosting
constraints; a concrete offering and end-to-end journey (what a customer buys, initial setup,
first useful workflow, what a "box" is); isolated instances vs shared multi-tenancy on
architecture, isolation, operations and cost; identity and membership, provisioning lifecycle,
agent/model credentials, usage accounting and limits, billing assumptions, upgrades, data
lifecycle, support; facts vs proposals vs founder decisions; never imply signup, billing or
provisioning exist. Deliverables: recommended initial model, phased plan with validation
criteria, minimal founder decisions, and an interface brief for the separate marketing-site task
(honest claims, CTA readiness, demo vs live, future signup handoff). Planning and design
authorization only — no infrastructure, purchases, billing activation or unapproved business
model. The marketing redesign is another task and is not assumed to have started.
