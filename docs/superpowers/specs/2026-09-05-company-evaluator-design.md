# Company Evaluator — Stage 1 (read-only shadow) design

**Written:** 2026-09-05. **Status:** draft for independent review (Milestone 0 of the
founder's executable plan). Companion decision record:
`doc/plans/2026-09-05-company-evaluator-decisions.md`.

## 1. Problem and decision record

The two-track 1.0 review (board tickets AGE-67/AGE-68, 2026-09-05) reached one
thesis from four independent lanes: Agent Runner runs on disciplined individual
behaviour layered over partially missing machinery. Concretely, on the live
company at that date: 0 of 80 issues carried a definition of done (the per-tenant
DoD guard flag had never been enabled), 0 verdicts and 0 approvals had ever been
recorded, the CoS Reviewer agent had never run, 13 of
142 runs carried usage data, and a founder-authority breach was found only by a
human reading prose. Nobody can currently answer "how well is this company
executing its goals?" from records rather than from memory.

**Founder decision (2026-09-05, verbatim in the mandate):** build a Company
Evaluator as a platform capability. Stage 1 is read-only shadow mode for two
complete product milestones. It measures, scores and escalates; it cannot block,
reassign, merge, deploy, release, change credentials, or mutate reviewed work.
Automatic enforcement is a later stage that requires Eyan's explicit activation
after the shadow results prove trustworthy. The evaluator is independent of
Maya's reporting chain and may not review or approve its own work.

This spec is the contract that stage. It defines what is measured, from which
records, how missing data is treated, how the scores can be gamed and how that
is prevented, and how a score is disputed. It does not define enforcement.

## 2. Scope and non-goals

In scope for Stage 1:

- An **append-only evaluation ledger** fed from records the control plane
  already keeps, plus structured self-reports agents already post.
- **Deterministic projections** (scorecards) rebuilt from the ledger by replay.
- An **independent evaluator agent** that reads ledger and scorecards, reviews
  only exceptions and ambiguity, and writes findings, scorecards and review items
  for humans.
- **Product surfaces** to read scores, drill to formula and evidence, and a
  founder view of decisions, material risk and exceptions.

Out of scope for Stage 1 (explicitly, by founder decision): any write to issues,
runs, verdicts, approvals, agents, credentials, releases or deployments; any
automatic consequence of a score; any per-agent ranking presented without
difficulty and coverage normalisation; any change to Maya's product-lead role
for the work she leads.

## 3. Vocabulary

| term | meaning in this spec | record it maps to |
|---|---|---|
| Goal | a company/team/agent/task objective | `goals` (level, status planned→active→achieved, ownerAgentId, parentId, metricDefinition) |
| Milestone | a bounded slice of a goal with a start and an end | a `projects` row linked to the goal through `project_goals` (projects carry `targetDate` and a structured `definitionOfDone` `{summary, criteria[], goalMetricLink}`); when a goal has no project, a `goals` row at level `team` or `agent` acts as the milestone |
| Work item | the unit of assignment and review | `issues` (status, priority, assignee agent/user, `definitionOfDone` jsonb, goalId, projectId, parentId, `startedAt`/`completedAt`/`cancelledAt`) |
| Accountable owner | the human answerable for an outcome | issue `assigneeUserId`; else the assignee agent's `accountable_user_id` (`agents`) or active stewardship (`agent_stewardships`); project lead; goal owner |
| Contributor | any actor whose event touched the work item | actors on ledger events |
| Evidence | a record that supports a claim | control-plane rows, verified external records, structured self-reports, prose — in that order of authority (§6) |
| Verdict | a reviewer's recorded judgement on goal/project/issue | `verdicts` (outcome, rubric_scores, reviewer agent/user); neutrality already enforced by the service (`NEUTRAL_VALIDATOR_VIOLATION`) |
| Exception | a rule-detected condition that needs a human or manager | evaluator output (§9) |
| Intervention | a human acting inside ordinary agent flow | derived event (§5, P1) |

## 4. The canonical evaluation contract (v1)

One versioned JSON document per milestone, `evaluation_contract/v1`, held as a
ledger event so it is itself append-only and replayable. Fields:

1. **Identity** — `companyId`, `goalId`, `parentGoalId|null`, `milestoneRef`
   (`{kind:"project"|"goal", id}`), `contractVersion:"v1"`, `createdAt`,
   `createdBy` (actor).
2. **Accountability** — `accountableUserId`, `leadAgentId|null`,
   `contributors[]` (derived at scoring time, not declared).
3. **Acceptance** — `acceptanceCriteria[]` (each `{id, text, source}` where
   source is the issue `definitionOfDone`, a MAW `pm_to_builder.acceptance_criteria`
   entry, or a goal `metricDefinition`), `definitionOfDone` (milestone-level
   text), `requiredEvidence[]` (§4.1).
4. **Independence** — `reviewerIndependence` rule id (§4.2) and any declared
   exclusions (people who may not review, e.g. the implementer's manager when
   the founder says so).
5. **Outcome** — `targetDate|null`, `downstreamRiskAcceptance` (text: which
   risks were knowingly accepted at close, e.g. "no container image").
6. **Operating window** — `windowStart`, `windowEnd|null` (open milestones score
   to now).

The contract is declared once per milestone by the accountable human (or by the
evaluator from existing records with `source:"derived"` and confidence capped at
Medium, §7). Changing it is a new contract event; scorecards record which
contract version they used.

### 4.1 Required evidence classes

A milestone's `requiredEvidence` names which of these classes each work item
must carry to count as satisfied. Defaults for engineering milestones:

| class | satisfied by | never satisfied by |
|---|---|---|
| `dod_present` | an `issues.definitionOfDone` with at least one criterion, present before status became `done` (the per-tenant `dod_guard_enabled` flag that would *require* it is an enforcement control and stays off in Stage 1; the evaluator only observes) | DoD added after `done` (retroactive edit, §8) |
| `neutral_verdict` | a `verdicts` row `outcome=passed` whose reviewer is not the assignee, PR author, project lead or goal owner; or a human `verdict_escalation` approval approved | a verdict from the same actor as any contributor with a write on the item |
| `delivery_ref` | a merged pull request reference resolvable to the item (structured `tpm_merge_report.pr` or `reviewer_to_tpm.pr`; or, when GitHub ingest is enabled, the PR itself) | a prose "merged" claim alone |
| `ci_green` | a structured `regression_gate_result` with `typecheck/test/build` passing and `pre_existing_failures` named; or GitHub check runs when ingest is enabled | "tests pass" in prose |
| `independent_review` | a review event by an actor with no write on the item (verdict, PR review, `tester_to_reviewer` from a different agent) | self-review, or review by the item's creator when the creator also implemented |

### 4.2 Reviewer independence rule (`independence/v1`)

An actor is **not independent** for a work item if it is the assignee, the PR
author, the creator-who-also-implemented, the project lead when the item is the
project's own deliverable, or the goal owner when the item closes the goal. This
generalises the existing verdict-service neutrality guard (assignee, project
lead, goal owner) by adding PR authorship and the creator-implementer case. The
evaluator applies the rule to every review-class event; a violation is exception
E4 and the event counts as `self_review`, never as evidence.

The evaluator is itself excluded from scoring anything it authored: its own
project, its review items, its scorecards.

## 5. Metrics

Every metric reports `{value, unit, n, coverage, confidence, formulaVersion,
evidenceRefs[]}`. `coverage` is the fraction of the population for which the
inputs were knowable; `confidence` is the tier from §7. A metric whose coverage
is below its floor is reported as `insufficient` with no value, and is excluded
from any aggregate. Nothing is imputed.

### 5.1 Outcome metrics (per milestone; rolled up to goal)

**O1 Acceptance satisfied.** Population: work items in the milestone with
terminal status `done`. Satisfied when every class in `requiredEvidence` is met
(§4.1). `value = satisfied / done`. Coverage: fraction of `done` items for which
each required class is decidable from ledger (a class with no possible source in
this deployment, e.g. `ci_green` without GitHub ingest and without structured
payloads, makes the item undecidable, not failed). A `done` item with a missing
class raises **E1 unsupported completion claim**. Floor 0.6.

**O2 Deadline adherence.** Population: milestones and items with a target date.
Sources: `projects.targetDate` (the only dated record in the schema; issues and
goals carry no date), else the contract's `targetDate`. `value = closed on or
before target / with target`. Both live projects have a null `targetDate`, so O2
reports `insufficient` until dates are set. It is kept in v1 so the gap is
visible rather than silent. Floor 0.5.

**O3 Downstream risk index.** Counts, per delivered item, of consequences after
close: reopen (`done`→non-terminal), explicit recovery issue created for it,
blocker added to another item citing it, incident fingerprint (`server_errors`)
first seen after the delivering release and attributed by the evaluator, and
revert of its delivery ref. `value = consequences / delivered` (lower is
better; presented as an index, not a score). Attribution of incidents is the one
place model review may be invoked (§9.3). Floor 0.5 on the deterministic
components; incident attribution reported separately with its own confidence.

**O4 Goal progress.** Goal status transitions and, when a goal carries a
`metricDefinition` with `measurements`, the measured value against target.
Today both goals have null metric definitions and no measurements exist, so O4
reports status-only with Low confidence. Floor: status always available.

**Outcome score** = weighted mean of the available outcome metrics (O1 0.5, O3
0.3 inverted, O4 0.2; O2 joins at 0.2 with O1 dropping to 0.4 when present),
computed only over metrics above their floors, and always shown with the list of
excluded metrics. There is no outcome score at `insufficient` confidence.

### 5.2 Operating metrics (per agent and per team, over a window)

**P1 Autonomy.** Population: agent-owned items that reached `in_review` or
`done` in the window. An **intervention** is a human actor changing status,
assignee or blockers on an agent-owned item, a human comment that reopens or
redirects it (the comment route's implicit reopen counts), or a human taking
over the item. `value = items with zero interventions / population`; also the raw
intervention count, which the dashboard shows separately because the founder
asked for it. Human answers to an agent's own `ask_user_questions` are **not**
interventions — asking is the desired behaviour. Floor 0.7.

**P2 Judgment.** Deterministic part: escalation precision — `escalated_to_human`
verdicts and `request_board_approval`-class approvals later **approved** as
raised, over all raised; and unanswered-question hygiene — `ask_user_questions`
still pending past the window's SLA (default 48 h) are charged to the *company*
(coverage note), not to the asking agent. Rubric scores from neutral verdicts,
when present, are averaged per dimension and shown with n. Model review may add a
judgment note only on items flagged by E5/E6 (§9). Floor 0.5 on escalations.

**P3 Factual accuracy.** Population: **checkable claims** — structured
self-report fields that a higher-authority record can confirm or contradict
(`regression_gate_result` vs recorded CI, `merge_result` vs PR state,
`test_pass_count` vs test evidence, "run succeeded" vs run status, counts quoted
against ledger counts). `value = 1 − contradicted / checkable`. Prose claims are
checked only when a structured counterpart exists; otherwise they are neither
credited nor penalised. Each contradiction is **E2**. Floor 0.5.

**P4 Handoff quality.** Population: handoffs — assignment or reassignment
events, status→`in_review`, and comments titled as MAW handoffs. A handoff is
**well-formed** when it carries a payload valid against `doc/maw/handoff-schemas.json`
(or, for assignment events, a non-empty description plus DoD), names the
receiver, and is not bounced (reassigned back or `revision_requested` within
24 h). `value = well-formed / handoffs`. Floor 0.6.

**P5 Recovery.** Population: runs ending `failed`, `timed_out` or `cancelled`,
plus items that entered a stranded state (execution-semantics §7–§8) and
`issue.recovery_budget_exhausted` events (the per-task recovery budget in
`server/src/services/task-recovery-budget.ts`: one automatic retry, then turn,
token, dollar and wall-clock ceilings enforced at claim and turn boundaries).
Reported: time to a valid action path (median, p90), share resolved by
auto-recovery vs explicit recovery issue vs human escalation, retries per eventual
success, and `heal_attempts` outcomes. Zero-turn hangs that ran past the time
budget without crossing a turn boundary are counted as recovery failures of the
*platform*, attributed to the company row, not to the agent. Runs ending
`human_question_unanswered` are counted as correct behaviour by the agent and as
an unanswered question owed by the company (see P2). Floor 0.5.

**P6 Authority compliance.** Population: authority-bearing actions by the actor
(status changes, assignments, blocker edits, merges, releases, agent pause/resume,
key or config changes, verdicts). A **violation** is an action the actor's role,
grants (`principal_permission_grants`) or a recorded founder lock did not permit;
a `NEUTRAL_VALIDATOR_VIOLATION` attempt; an agent acting on a ticket recorded as
owner-locked; a merge without the recorded gates. `value = 1 − violations /
authority-bearing actions`. Every violation is **E3, immediate**. Prose-level
breaches (a recommendation presented as a decision) are detectable only by review
and are flagged as E3-candidate for the evaluator agent (§9.3). Floor 0.8.

**P7 Cycle time.** Per item: queue (`createdAt`→`startedAt`), work
(`startedAt`→first `in_review`), review (first `in_review`→`done`), and total.
Reported as median and p90 per milestone and per agent, **bucketed by size label
when present** (`size:XS..XL`); never a single number across sizes and never
part of a composite score — speed is context, not merit. Floor: timestamps always
available; size buckets shown only with n ≥ 3.

**P8 Token and cost efficiency.** Inputs: `heartbeat_runs.usage_json`,
`agent_runs` (token_count, cost_cents, duration_ms, complexity_tier) and
`cost_events`, reconciled per run with precedence `cost_events` > `agent_runs` >
`usage_json` and a contradiction exception when two present sources disagree by
more than 10 %. Reported: cost per item satisfied (O1), tokens per run, and
**anomalies** — a run above 3× the actor's rolling median for its size bucket
(E7). Coverage today is about 9 % of runs, so P8 reports `insufficient` until
metering lands; the dashboard must say so rather than show a low spend. Floor 0.5.

**P9 Duplicate and rework rate.** Duplicates: items cancelled with a duplicate
relation or a duplicate label, or created within 15 minutes of another open item
with the same normalised title in the same company. Rework: `done`→reopen,
`revision_requested` verdicts, MAW `fix_attempt` > 1, PR change requests before
merge (when ingest is enabled). `value = (duplicates + rework) / delivered`
(lower is better). Floor 0.6.

**Operating score** = weighted mean of available metrics normalised to 0–100
(P1 0.15, P2 0.15, P3 0.2, P4 0.1, P5 0.1, P6 0.2, P9 0.1 inverted; P7 and P8
are shown, not scored), only over metrics above their floors. Any E3 violation
in the window caps the operating score at 49 and is shown on the card.

### 5.3 What is never rewarded

Number of issues created, closed or commented; number of runs; number of tokens
spent or saved in isolation; speed without evidence; self-declared status.

## 6. Source precedence

| tier | sources | authority |
|---|---|---|
| T0 control plane | `issues`, `issue_comments` (metadata), `activity_log`, `heartbeat_runs`, `heartbeat_run_events`, `agent_wakeup_requests`, `agent_runtime_state`, `verdicts`, `approvals`, `issue_thread_interactions`, `issue_relations`, `issue_execution_decisions`, `heal_attempts`/`heal_events`, `cost_events`, `finance_events`, `agent_runs`, `budget_incidents`, `agent_stewardships`, `principal_permission_grants`, `agent_governance_policies`, `server_errors`, `workflow_events` (person-free pipeline timings only), release manifests attached to GitHub Releases | authoritative for what happened in the system |
| T1 verified external | GitHub pull-request state, reviews and check runs; release tags and assets — only when an ingest adapter with an approved credential exists | authoritative for delivery and CI |
| T2 structured self-report | MAW handoff payloads in comments (`pm_to_builder`, `builder_to_ci`, `tester_to_reviewer`, `reviewer_to_tpm`, `tpm_merge_report`), run `resultJson`, PR bodies quoted in comments | claims, checkable against T0/T1 |
| T3 prose | comment and description text, run stdout excerpts | context only; never evidence for O1, never a violation by itself |

Rules: a higher tier decides a fact; a lower-tier statement that contradicts it
is recorded as a contradiction (E2) and the lower tier's actor is charged under
P3. When two T0 sources disagree (e.g. run status vs activity log), both are
kept, the scorecard shows the disagreement, and the metric's confidence drops
one tier. Nothing is deleted or overwritten to resolve a conflict.

## 7. Missing data, coverage and confidence

- **Unknown is never passed.** A required evidence class with no possible
  source in the deployment marks the item *undecidable*, lowers coverage, and is
  named on the card ("CI evidence: no source configured").
- **Coverage** per metric = decidable population / population.
- **Confidence tier** per metric and per card: **High** — coverage ≥ 0.8 and at
  least two independent source tiers for the decisive facts; **Medium** —
  coverage 0.5–0.8, or single-tier facts, or a `derived` contract; **Low** —
  coverage 0.2–0.5, or a T0/T0 disagreement in the window; **Insufficient** —
  coverage < 0.2, or the metric's floor not met: no value is shown.
- Aggregates inherit the lowest confidence of their included metrics.
- Historical backfill (Milestone 1) ingests only records that exist with their
  original timestamps; periods with no records are labelled *unknown*, and
  metrics over them report `insufficient`.

## 8. Anti-gaming rules

1. **No volume credit** (§5.3). Creating or closing more items never raises a
   score; O1 is a ratio and E1 penalises unsupported closes.
2. **Self-review is a violation, not weak evidence** (§4.2, E4).
3. **Claims need counterparts.** Prose is never evidence; structured
   self-reports are checkable claims, and a contradiction costs more than the
   claim would have earned.
4. **Retroactive edits are visible.** Every ledger event carries `eventTime`
   (when the fact happened) and `ingestTime` (when the evaluator learned it).
   A DoD, verdict or payload whose `eventTime` follows the item's `done`
   transition does not satisfy the class for that close (it can satisfy a later
   reopen-and-close). Edits to comments after a scorecard version are new events
   referencing the old.
5. **Clock skew tolerance** is 5 minutes between sources; ordering disputes
   inside the tolerance are resolved by ingest order and marked.
6. **Duplicate events are idempotent.** The dedupe key (source table, source id,
   event type, version) makes re-ingest a no-op; two different sources reporting
   the same fact are two events linked by `correlationId`, counted once.
7. **Source authority is fixed.** An agent cannot emit a T0 or T1 event about
   itself; only the control plane and ingest adapters write those tiers. A T2
   payload posted by the actor it describes is marked `selfReported:true`.
8. **Splitting work to game P7 or P9** is detected by the duplicate-title rule
   and by child items closed within minutes of creation with no run.
9. **The evaluator is out of its own scope** (§4.2), and its findings are
   themselves ledger events reviewable under the appeals rule.

## 9. Exceptions, escalation and appeals

### 9.1 Exception catalogue

| id | condition | severity | routed to |
|---|---|---|---|
| E1 unsupported completion claim | `done` without a required evidence class | material | accountable owner |
| E2 contradiction | T2/T3 claim contradicted by T0/T1, or T0/T0 disagreement | material if about delivery or authority, else routine | actor's manager; both actors named |
| E3 authority breach | §5.2 P6 violation, or NEUTRAL_VALIDATOR_VIOLATION attempt | **immediate** | founder view + accountable owner |
| E4 self-review | review-class event by a non-independent actor | **immediate** | founder view + manager |
| E5 stale work | non-terminal item with no valid action path for > 48 h (execution-semantics §7) | routine | accountable owner |
| E6 duplicate work | §5.2 P9 duplicate rule fires | routine | creator's manager |
| E7 cost anomaly | §5.2 P8 anomaly, or metering absent for > 50 % of an agent's runs | routine (material if spend cap approached) | manager |
| E8 excessive intervention | P1 interventions on one item ≥ 3, or a human completing an agent-owned item | routine | manager |
| E9 unresolved downstream risk | O3 consequence still open 7 days after close | material | accountable owner |
| E10 missing DoD at start | agent-owned item moved to `in_progress` with empty DoD | routine | assignee's manager |

Routine exceptions are batched into **one evaluator message per milestone**.
Immediate exceptions (E3, E4, and any E2 about a release or credential) are
posted at once. This is the mandate's ceiling on evaluator chatter, and it is a
hard rule of the agent's prompt and of the notifier.

### 9.2 What an exception does

It creates a **review item** (an issue in the Evaluator project, kind
`evaluator-review`, assigned to the routed human or manager) that links the
ledger events and the scorecard version. It never changes the source issue, its
status, its assignee, its verdicts or approvals. Closing the review item is the
human's act; the evaluator records the disposition as a ledger event.

### 9.3 When model reasoning is used

Deterministic rules run first and produce every number. The evaluator agent is
invoked only for: E2 with two T0 sources in conflict; E3-candidate prose
breaches; E5 with ambiguous action paths; potential gaming patterns not covered
by §8; incident attribution for O3; and severity triage when a card carries more
than five material exceptions. Each invocation has an explicit token budget
(default 150k tokens per milestone card, hard cap 500k, both configurable and
reported on the card), works from cached event digests rather than raw logs, and
must cite event ids for every statement it makes. A statement without a cited
event is dropped by the renderer and logged as a defect of the evaluator.

### 9.4 Appeals and corrections

Any accountable human, the actor's manager, or the founder may file a
**correction**: a ledger event `evaluation.correction` that names the disputed
event id, the claimed fact, and the evidence. Corrections are append-only; the
disputed event is never edited. Replay applies corrections after the disputed
event, so the scorecard recomputes deterministically and shows *corrected from*.
The evaluator agent records a disposition (`accepted`, `rejected`, `needs
evidence`) within one milestone; rejected corrections may be raised to the
founder view. Corrections filed by the actor being scored are allowed and
marked `selfFiled:true`.

## 10. Independence and authority of the evaluator

- The evaluator agent has role `evaluator`, reports to no agent (`reportsTo`
  null), and its accountable human is the founder. It is not in Maya's chain by
  founder decision; this is a recorded exception to `doc/DELIVERY-AND-REVIEW.md`,
  which otherwise routes status through Maya (decision D2).
- It holds a dedicated agent API key whose permission grants are **read on
  everything, write only on** `evaluation_events` (its own findings and
  dispositions), scorecard documents, and issues inside the Evaluator project.
  Route-level checks refuse any other write from that principal, and the tests
  in §13 prove it.
- It never creates verdicts or approvals, never edits or transitions a source
  issue, never merges, releases, deploys or changes a credential. The mandate's
  prohibition is implemented as permission, not as prompt guidance.
- Its outputs: milestone scorecards (versioned documents), trend reports, review
  items, and a founder brief containing only decisions, material risk and
  exceptions.
- It is excluded from scoring its own work (§4.2). Its code is reviewed by an
  independent reviewer, and the founder — not Maya — accepts the metric
  definitions, because Maya's work is among the things measured (decision D7).

## 11. Architecture (kept simple)

```
control-plane rows ──► ingest (idempotent, async) ──► evaluation_events (append-only)
MAW payloads in comments ─┘                                   │
GitHub (optional adapter) ┘                                   ▼
                                              deterministic projections (replayable)
                                                 ├─ per-milestone scorecard vN
                                                 ├─ per-agent / per-team operating card
                                                 └─ exceptions
                                                              │
                                    evaluator agent (exception-only, budgeted) ──► review items,
                                                                                   founder brief
```

- `evaluation_events`: one table, insert-only, company-scoped, unique on the
  dedupe key. Columns per the mandate: stable id, company and project scope,
  actor, source reference, event time, ingest time, schema version, dedupe key,
  payload. No updates or deletes are granted to any principal.
- Ingest runs off the request path on the existing periodic loop with its own
  interval and budget; it never blocks agent execution.
- Projections are pure functions of ordered events; `replay(companyId,
  milestoneRef, throughEventId)` rebuilds a scorecard and must equal the stored
  one byte-for-byte (the mandate's 95 % replay-agreement graduation criterion is
  measured against this).
- Existing machinery is **reused as sources, not rebuilt**: `verdicts`,
  `approvals`, `issue_review_queue_state`, `cos_reviewer_assignments`,
  `issue_execution_decisions`, `heartbeat_run_watchdog_decisions`,
  `budget_*`, `resource_usage_events`, and the `dashboard.ts` task-quality
  queries (issues with a DoD, unreviewed done issues, issue-linked spend) which
  O1 generalises. The research-cycle `evaluations` table is a different domain
  and is left alone. `workflow_events` is deliberately person-free (database
  checks forbid any actor identity), so it cannot host per-agent scoring and is
  read only for pipeline timings (decision D8). The live event bus is in-memory
  and not durable; ingest reads tables, never the bus.

## 12. Acceptance criteria for Milestone 0

1. This spec and the decision record are in the repository on `main`.
2. The plan was reviewed by at least one independent reviewer who did not write
   it, with findings recorded on the board, and the founder accepted the metric
   definitions in §5 or named the changes.
3. Every formula in §5 names its inputs, population, floor and exception.
4. The independence rule (§4.2), source precedence (§6), missing-data behaviour
   (§7), anti-gaming rules (§8) and appeals mechanism (§9.4) are written and
   reviewable before any table or code exists.

Acceptance for Milestones 1–5 is written in the decision record's plan section
and repeated in each milestone's board ticket.

## 13. Test focus areas (from the mandate's verification requirements)

- Unit: contract schema validation; each metric formula with fixture ledgers;
  coverage and confidence tiers at the floors; dedupe key idempotence;
  anti-gaming rules 4–8; permission grants of the evaluator principal (every
  forbidden write returns 403 and leaves no row).
- Integration: events from issue lifecycle, runs, verdicts, approvals and cost
  through ingest to a replayed scorecard equal to the stored one.
- Adversarial: fabricated `tpm_merge_report` with no PR; DoD added after close;
  duplicate events with different ids; self-review attempts; run status vs
  activity-log conflict; runs with no cost; events with 4-minute and 6-minute
  skew; a comment edited after a card version.
- End-to-end: two shadow milestones with drill-down from every number to its
  events.
- Load and cost: ingest of the current instance (≈1.3k activity rows, ≈400 run
  events, ≈6k heal events) within the periodic loop's budget with no measurable
  change to run start latency; evaluator token spend per card reported.
- Security: company isolation (a key for company A reads nothing of company B);
  read-only authority proven by tests, not by prompt.

## 14. Out of scope for Stage 1

Enforcement of any kind; automatic reassignment; budget hard-stops driven by
scores; customer-facing scorecards; cross-company comparison; scoring humans'
personal performance (humans appear only as accountable owners and as
intervention actors).

## 15. Open decisions

See the decision record. The ones that block Milestone 1 are D1 (ledger versus
extending `verdicts`), D3 (milestone definition), D4 (GitHub ingest credential —
none is added without the founder's approval), D5 (evaluator runtime and token
budget), D7 (who reviews and who accepts the metric definitions) and D8
(per-agent identity in the ledger).
