# Company Evaluator — Stage 1 (read-only shadow) design

**Written:** 2026-09-05. **Revised:** 2026-09-05 after the first independent
review (findings on AGE-84). **Status:** draft for founder acceptance of §5
(Milestone 0 of the founder's executable plan). Companion decision record:
`doc/plans/2026-09-05-company-evaluator-decisions.md`; data-surface map:
`docs/superpowers/specs/2026-09-05-company-evaluator-data-surfaces.md`.

## 1. Problem and decision record

The two-track 1.0 review (board tickets AGE-67/AGE-68, 2026-09-05) reached one
thesis from four independent lanes: Agent Runner runs on disciplined individual
behaviour layered over partially missing machinery. Concretely, on the live
company at that date: 0 of 80 issues carried a definition of done (the per-tenant
DoD guard flag had never been enabled), 0 verdicts and 0 approvals had ever been
recorded, the CoS Reviewer agent had never run, 13 of 142 runs carried usage
data, and a founder-authority breach was found only by a human reading prose.
Nobody can currently answer "how well is this company executing its goals?" from
records rather than from memory.

**Founder decision (2026-09-05, verbatim in the mandate):** build a Company
Evaluator as a platform capability. Stage 1 is read-only shadow mode for two
complete product milestones. It measures, scores and escalates; it cannot block,
reassign, merge, deploy, release, change credentials, or mutate reviewed work.
Automatic enforcement is a later stage that requires Eyan's explicit activation
after the shadow results prove trustworthy. The evaluator is independent of
Maya's reporting chain and may not review or approve its own work.

This spec is the contract for that stage: what is measured, from which records,
how missing data is treated, how the scores can be gamed and how that is
prevented, how the read-only guarantee is enforced, and how a score is disputed.
It does not define enforcement.

## 2. Scope and non-goals

In scope for Stage 1: an **append-only evaluation ledger** fed from records the
control plane already keeps plus structured self-reports agents already post;
**deterministic projections** (scorecards) rebuilt by replay; an **independent
evaluator agent** that reads ledger and cards, reviews only exceptions and
ambiguity, and writes findings and review items through its own routes; and
**product surfaces** with drill-down to formula and evidence plus a founder view.

Out of scope, by founder decision: any write to **source records** — issues
outside the Evaluator project, runs, verdicts, approvals, agents, credentials,
releases, deployments; any automatic consequence of a score; any ranking without
difficulty and coverage normalisation; any change to Maya's product-lead role for
the work she leads; scoring humans (§14).

## 3. Vocabulary

| term | meaning | record |
|---|---|---|
| Goal | company/team/agent/task objective | `goals` (level, status `planned→active→achieved`, `ownerAgentId`, `parentId`, `metricDefinition`) |
| Milestone | a bounded slice of a goal | a `projects` row (`targetDate`, structured `definitionOfDone`) linked to the goal via `project_goals`; a `team`/`agent` goal with no project acts as one (D3) |
| Work item | unit of assignment and review | `issues` (status, priority, assignee agent/user, `definitionOfDone` jsonb, `goalId`, `projectId`, `parentId`, `startedAt`/`completedAt`/`cancelledAt`) |
| Membership | which items a milestone scores | `issues.projectId = project`, plus descendants through `parentId` (any depth) that carry no other `projectId`; for a goal-as-milestone, `issues.goalId = goal` with null `projectId`. An item is scored in the milestone it belongs to when it reaches a terminal status, or at window end if still open; a move between projects is a ledger event, and the item is never counted twice. **Review items (label `evaluator-review`) are excluded from every scored population** (rule 12). |
| Accountable owner | the human answerable for an outcome | issue `assigneeUserId`; else the assignee agent's `accountableUserId` or active `agent_stewardships` user; project lead's accountable human; goal owner's |
| Contributor | an actor with a **write** on the item | any actor that changed status, assignee, blockers, description or DoD; authored a comment; ran a heartbeat whose `contextSnapshot.issueId` is the item; authored a delivery ref or a self-report payload; recorded a verdict. Reads, read-state marks, label edits and mentions from other items are not writes. |
| Evidence | a record supporting a claim | tiers T0–T3 (§6) |
| Verdict | a reviewer's recorded judgement | `verdicts` (outcome, `rubricScores`, reviewer agent xor user) |
| Exception | a rule-detected condition needing a human | §9 |
| Intervention | a human acting inside ordinary agent flow | derived (§5.2 P1) |
| Review item | the evaluator's request for a human decision | an issue in the **Evaluator review-items project** (separate from the build project), label `evaluator-review`, human assignee only (§9.2) |

## 4. The canonical evaluation contract (v1)

One versioned JSON document per milestone, `evaluation_contract/v1`, stored as a
ledger event so it is append-only and replayable. Fields:

1. **Identity** — `companyId`, `goalId`, `parentGoalId|null`, `milestoneRef`
   `{kind:"project"|"goal", id}`, `contractVersion`, `createdAt`, `createdBy`.
2. **Accountability** — `accountableUserId`, `leadAgentId|null`; contributors
   are derived (§3), never declared.
3. **Acceptance** — `acceptanceCriteria[]`, each `{id, text, check, source}`
   where `check` is one of: `record` (a named T0/T1 record must exist, e.g.
   `verdict.passed`, `pr.merged`, `project.status=completed`), `human_attest`
   (a named independent human records `satisfied|unsatisfied` as a ledger event
   with evidence refs), or `metric` (a `goals.metricDefinition` measurement
   meets `target`). Criteria without a `check` are recorded as **unmeasurable**
   and count against coverage, never as satisfied. `requiredEvidence[]` names
   the §4.1 classes each item must carry; a set weaker than the engineering
   default is a **contract exception** shown on the card and requiring the
   founder's recorded acceptance (rule 16).
4. **Independence** — the rule id (§4.2), declared exclusions, and any
   **founder locks**: items only the founder may act on (there is no system
   record of a lock; the contract is where it lives).
5. **Outcome** — `outcomeTarget {metricKey, target, unit, source}|null`,
   `targetDate|null`, `downstreamRiskAcceptance` (risks knowingly accepted at
   close).
6. **Window** — `windowStart`, `windowEnd|null`. An open milestone (both live
   projects are `in_progress` with no target date) is scored *to now* and its
   card carries the marker **open milestone — denominators still moving**; a
   milestone scored from records that predate the evaluator carries **scored
   retrospectively — confidence capped**, and every E1 it raises carries the same
   marker.

A contract is declared by the accountable human; when the evaluator derives one
from existing records it is marked `source:"derived"`, every metric on that card
is capped at Medium confidence, and it **always uses the engineering-default
`requiredEvidence` set** — a derived contract never drops a class, because which
classes apply is the single biggest lever on O1/O5 and only a human may pull it
(rule 16). Changing a contract is a new event. A criterion declared after an item
reached a terminal status cannot judge that item (rule 17).

### 4.1 Required evidence classes

| class | satisfied by | never satisfied by |
|---|---|---|
| `dod_present` | a `definitionOfDone` with ≥1 criterion in force before the item left `backlog` (rule 11 says which version counts) | a DoD first set after `done`; a DoD narrowed after leaving `backlog` |
| `neutral_verdict` | a `verdicts` row `outcome=passed` by an independent reviewer (§4.2); or a `verdict_escalation` approval decided by an independent, **personal** human identity | any non-independent reviewer; an approval decided by a shared or synthetic identity (rule 15) |
| `delivery_ref` | a merged PR resolvable to the item — from `tpm_merge_report.pr` / `reviewer_to_tpm.pr` (T2) or GitHub (T1, D4) | a prose "merged" |
| `ci_green` | a structured `regression_gate_result` with `typecheck/test/build` passing and `pre_existing_failures` named (T2), or GitHub check runs (T1) | "tests pass" in prose |
| `independent_review` | a review-class event by an independent actor (verdict, PR review, `tester_to_reviewer` from a different agent) | self-review; the creator-implementer reviewing |

A class is **undecidable** only when the deployment has *no* source for it at
all (e.g. `ci_green` with no structured payloads and no GitHub adapter). When a
source exists and this item simply lacks the record, the class is **failed**
(rule 10).

### 4.2 Reviewer independence rule (`independence/v1`)

An actor is not independent for an item if it is a contributor (§3) — which
covers the assignee, the PR author and the creator-who-implemented — or the
project lead when the item is the project's own deliverable, or the goal owner
when the item closes the goal. Today's verdict-service guard is narrower: for
issue verdicts it refuses only reviewer = assignee; project lead and goal owner
are checked only on project and goal verdicts and only for agent reviewers
(`server/src/services/verdicts.ts:151-195`). The evaluator applies the fuller
rule to every review-class event; a violation is E4 and the event counts as
`self_review`, never as evidence. One path is named so it is not mistaken for a
T0/T0 disagreement: the escalation bridge writes a closing verdict with
`reviewerUserId = decidedByUserId`, and the service guard knows nothing of PR
authorship, so a PR-author human can lawfully record a service-valid `passed`
verdict that the evaluator scores as non-independent. Both records stand; the
card says which rule each satisfied. The evaluator is excluded from scoring anything
it authored, and its own behaviour is scored by deterministic rules reviewed by
the founder (§10.4), never by itself.

## 5. Metrics

Every metric reports `{value, unit, n, coverage, confidence, breakdown,
formulaVersion, evidenceRefs[]}` where `breakdown` is `{satisfied, failed,
undecidable: [{reason, count}]}` and the card's headline prints it in words —
"satisfied 12 of 36 done; 20 undecidable (no CI evidence source configured);
4 failed" — never a bare percentage. Coverage = decidable population /
population. Confidence is the tier from §7; at **Insufficient** no value is
shown. Nothing is imputed.
Metrics marked *by construction* are Insufficient until a named prerequisite
lands, and the card says which.

### 5.1 Outcome metrics (per milestone, rolled to goal)

**O1 Acceptance satisfied.** Population: member items with terminal status
`done`. An item is satisfied when every contract criterion applying to it has a
`satisfied` disposition from its `check` (a `record` found, an independent
`human_attest`, or a `metric` met). Items with unmeasurable criteria are
undecidable. `value = satisfied / done`. A `done` item with an unsatisfied or
missing disposition is **E1**. Today no item carries criteria, so O1 starts
Insufficient and says so; it exists so the gap is measured, not assumed.

**O2 Deadline adherence.** Population: items and milestones with a target date
(`projects.targetDate` or the contract's `targetDate`; issues and goals carry no
target date). `value = closed on or before target / with target`. Both live
projects have null dates → Insufficient until set.

**O3 Downstream risk index.** Per delivered item, consequences after close:
reopen (`done`→non-terminal), an explicit recovery issue for it, a blocker added
to another item citing it — all T0 — and, **only when T1 or T2 delivery
evidence exists**, a revert of its delivery ref. `value = consequences /
delivered` (an index; lower is better); the T1/T2-conditional term is shown
separately with its own coverage. Incident attribution is
**Insufficient by construction** in Stage 1: `server_errors` carries no company,
agent, run or release link, so it cannot be joined to a company ledger (F6).

**O4 Goal progress.** Goal status transitions, and the contract's
`outcomeTarget` when present (measured via `goals.metricDefinition` and
`measurements`). Both live goals have null definitions → status only, Low.

**O5 Evidence hygiene.** Population: `done` member items. `value = items
carrying every required evidence class / done` (the classes named in the
contract's `requiredEvidence`). This is the shape check the
first draft called O1; it is kept separately so a well-evidenced item that fails
its criteria is visible as such.

### 5.2 Operating metrics (per agent, per team, per window)

**P1 Autonomy.** Population: agent-owned items reaching `in_review` or `done`.
An **intervention** is a human changing status, assignee or blockers on an
agent-owned item, a human comment that reopens or redirects it (the comment
route's implicit reopen counts), or a human taking it over. `value = items with
zero interventions / population`; the raw count is shown too. Answering an
agent's own `ask_user_questions` (interaction status `answered` or `accepted`;
the enum is `pending|accepted|rejected|answered|cancelled|expired|failed`) is
not an intervention.

**P2 Judgment.** Escalation precision: `escalated_to_human` verdicts and
`request_board_approval`-class approvals later approved as raised / raised —
"later approved" is derived through the verdict-approval bridge (a later
`passed` verdict linked to the escalation's approval), since verdicts are
insert-only and carry no status.
Unanswered `ask_user_questions` past 48 h are charged to the company row, not
the asking agent, and reported with their median pending age (a count alone is
uninterpretable). Neutral-verdict rubric dimensions averaged with n.

**P3 Factual accuracy.** Population: **checkable claims** — structured
self-report fields with a higher-tier counterpart (`regression_gate_result` vs
CI, `merge_result` vs PR state, run "succeeded" vs run status, quoted counts vs
ledger counts). `value = 1 − contradicted / checkable`; each contradiction is
**E2**. Prose is neither credited nor penalised. An actor with zero checkable
claims in a window has coverage 0 (rule 10), not a perfect score.

**P4 Handoff quality.** Population: assignment changes (there is no
`issue.assigned` action — they are `issue.updated` rows whose `_previous`
carries the old assignee), `→in_review` transitions and MAW-titled comments.
Well-formed = valid payload against `doc/maw/handoff-schemas.json` (or, for
assignments, a description and a DoD), a **derivable receiver** — the MAW
schemas carry no to/from field, so the receiver is the item's assignee at the
comment's `createdAt` (and the sender is the comment author) — and no bounce
within 24 h. `value = well-formed / handoffs`.

**P5 Recovery.** Population: runs ending `failed|timed_out|cancelled`, stranded
items (execution-semantics §7–8), `issue.recovery_budget_exhausted` (emitted in
`heartbeat.ts`; limits in `task-recovery-budget.ts`), `heal_attempts` outcomes.
Reported: time to a valid action path (median, p90), share auto-recovered vs
explicit recovery vs human escalation, retries per success. Zero-turn hangs past
the time budget are platform failures on the company row. Runs ending
`human_question_unanswered` are correct agent behaviour and an unanswered
question owed by the company.

**P6 Authority compliance.** *Detected violations, shown as a count with rules,
not as a ratio*, because refused actions currently leave no record and grants
are additive with no deny scope (E1 of the review). Detection rules: E4
self-review; an agent acting on a contract founder-lock item; an agent
transitioning an item it is not assigned to; a merge without the recorded gates
(T1/T2); a `NEUTRAL_VALIDATOR_VIOLATION` or authority 403 refusal **once
refusals are logged** (Milestone 1 prerequisite: `activity_log` action
`authz.refused` with actor, route and reason). Every detection is **E3,
immediate**. Prose-level breaches (a recommendation presented as a decision) are
out of Stage 1 scope; there is no population to review.

**P7 Cycle time.** Per item: queue (`createdAt→startedAt`), work
(`startedAt→first in_review`), review (`first in_review→done`), total. Median
and p90 per milestone and per agent. Bucketed by size **only where a size signal exists**: a `size:` label set in
the company (none today) or the MAW payload's `t_shirt_size` (T2, present on
the 25 `pm_to_builder` payloads); size coverage is reported separately so an
unbucketed median is not mistaken for a normalised one. Shown, never scored.

**P8 Token and cost efficiency.** Source: `cost_events` per run; `usage_json` is
the adapter's self-report and is shown only when no cost event exists, marked
`selfReported`. `agent_runs` is derived from `cost_events` and is not a second
source. Reported: cost per O1-satisfied item, tokens per run, anomalies (run
> 3× the actor's rolling median, **E7**). Coverage today ≈ 9 % → Insufficient,
stated on the card. Shown, never scored.

**P9 Duplicate and rework rate.** Duplicates: items cancelled with a
`duplicate` label or an `originFingerprint` collision, or created within 15 min
of another open item with the same normalised title. Rework: `done`→reopen,
`revision_requested` verdicts, MAW `fix_attempt > 1`, PR change requests (T1).
`value = (duplicates + rework) / delivered`.

### 5.3 Composite scores

The mandate asks for an outcome score and an operating score, kept separate.
Each is a **renormalised weighted mean** over included metrics:
`score = Σ wᵢ·vᵢ / Σ wᵢ`, values scaled to 0–100, inverted where lower is
better. Outcome weights: O1 0.4, O2 0.15, O3 0.2, O4 0.1, O5 0.15. Operating
weights: P1 0.2, P2 0.2, P3 0.25, P4 0.15, P9 0.2 (P5 shown, not scored, until
its populations are stable; P6, P7, P8 shown, never scored). A metric is
included only at Low confidence or better. **Guards:** no outcome score with
fewer than two included metrics, no operating score with fewer than three; the
card always lists excluded metrics with reasons; composite confidence = the
lowest included tier; any E3/E4 in the window is shown as a flag on the card,
not folded into arithmetic. Never rewarded: counts of issues, runs, comments or
tokens; speed without evidence; self-declared status.

## 6. Source precedence

| tier | sources | authority |
|---|---|---|
| T0 control plane | `issues`, `issue_comments` (metadata), `activity_log`, `heartbeat_runs`, `heartbeat_run_events`, `agent_wakeup_requests`, `agent_runtime_state`, `verdicts`, `approvals`, `issue_thread_interactions`, `issue_relations` (`blocks`), `issue_execution_decisions`, `heal_attempts` (via run → company), `cost_events`, `finance_events`, `budget_incidents`, `agent_stewardships`, `agent_governance_policies`, `principal_permission_grants`, `workflow_events` (person-free timings) | what happened in the system |
| T1 verified external | GitHub PR state, reviews, check runs; release tags and manifests — only with an approved adapter (D4) | delivery and CI |
| T2 structured self-report | MAW payloads in comments, run `resultJson`, `usage_json` | checkable claims |
| T3 prose | comment/description text, run excerpts | context only |

**Instance-scoped tables are excluded**: `server_errors` and `heal_events`
(nullable `runId`) carry no company attribution and would leak across tenants.
A higher tier decides a fact; a contradicting lower tier is **E2** charged under
P3. When two T0 sources disagree, both are kept, the card shows it, and the
metric's confidence drops one tier. Nothing is deleted or overwritten.

## 7. Missing data, coverage, confidence and identity

- **Unknown is never passed.** An undecidable class lowers coverage and is named
  on the card ("CI evidence: no source configured").
- **One confidence rule for every metric**, from coverage: High ≥ 0.8 with two
  independent tiers for decisive facts; Medium 0.5–0.8 or single-tier or a
  `derived` contract; Low 0.2–0.5 or a T0/T0 disagreement (value shown with a
  warning); Insufficient < 0.2 or *by construction* (no value). There are no
  per-metric floors; composites inherit the lowest included tier. Cards display
  the tiers as **strong / adequate / limited evidence / insufficient evidence**
  — the tier describes how much the records show, not how good the work was.
- **Backfill** ingests only records that exist with their original timestamps;
  periods without records are *unknown*.
- **Deployment-mode caveat.** In `local_trusted` mode every human actor is the
  synthetic `local-board` identity. Interventions are countable but not
  attributable to a person; accountable-owner derivation yields a pseudo-person;
  approvals decided by that identity never satisfy independence (rule 15). The
  first shadow milestone (a retrospective on records made under this mode) shows
  this caveat on its card, and the founder should read its human-attribution
  metrics accordingly.

## 8. Anti-gaming rules

1. No volume credit (§5.3).
2. Self-review is a violation, not weak evidence (E4).
3. Claims need counterparts; a contradiction costs more than the claim earns.
4. Retroactive edits are visible: every event has `eventTime` and `ingestTime`;
   a DoD, verdict or payload dated after `done` does not satisfy that close.
   **A T2 payload's own `timestamp` is never trusted as event time**: ingest
   clamps it to `min(payload.timestamp, comment.createdAt)` — the comment row's
   arrival is the T0 fact — and a payload timestamp earlier than its comment by
   more than the skew tolerance is itself a checkable claim (E2).
5. Clock skew tolerance 5 minutes. **Replay order is total and stated**: events
   sort by `eventTime` bucketed to the tolerance, then `ingestTime`, then
   `dedupeKey`; the sort is part of `formulaVersion`, so byte-for-byte replay
   agreement is provable. `heartbeat_run_events.seq` orders within a run only.
6. Duplicate events are idempotent by dedupe key `(companyId, sourceTable,
   sourceId, eventType, sourceVersion)`; the key embeds the company so two
   tenants can never collide. `sourceVersion` is named per table: the
   `activity_log` row id for issue, agent and approval transitions (mutable rows
   yield one event per transition, never one per row); `heartbeat_run_events.id`
   and the run's `updatedAt` for runs; the comment id plus body hash for T2
   payloads; the verdict/approval id for insert-only tables. Two sources for one
   fact are linked by `correlationId` and counted once.
7. Source authority is fixed: agents cannot emit T0/T1 about themselves; a T2
   payload posted by its own subject is `selfReported:true`.
8. Splitting work is detected by the duplicate-title rule and by children closed
   within minutes with no run.
9. The evaluator is out of its own scope; its findings are ledger events subject
   to §9.4.
10. **No coverage starvation.** A missing record where a source exists is
    `failed`, not undecidable (§4.1); an actor whose evidence-emission rate falls
    below 50 % of its trailing four-week baseline raises **E11**; a metric
    excluded for low coverage names the actors whose omissions caused it.
11. **The DoD that counts is the earliest one in force after the item left
    `backlog`.** Every later `dod_set` is ingested with its prior value; a
    narrowing (criteria removed or weakened) after leaving `backlog` is **E12**.
    Prerequisite (Milestone 1): `dod_set` activity must record the real actor and
    the previous value — today it logs `actorType:"system"` and the new value
    only (`server/src/services/verdicts.ts:617-625`).
12. **Evaluator output never enters scored populations**: issues labelled
    `evaluator-review` (the evaluator's review items and digests) are excluded
    from every metric for every actor. The *build* project of the evaluator is
    an ordinary project and may itself be a scored milestone (D3); the
    evaluator agent's own findings never earn contributor credit there.
13. **Mutation inside the ingest window is caught by content hashes.** Each
    ingest pass records a hash per source row; a changed hash with no matching
    `activity_log` entry is **E2**; a T2 payload that disappears (comment
    deletion — there is no comment-edit route) is `evidence_withdrawn` (**E13**).
    The card states the maximum ingest lag as the size of the blind window.
14. **Bundling is visible**: the card shows changes per delivery ref and flags
    items whose ref spans an outlier count (a size normaliser needs a size
    signal, which does not exist today).
15. **Synthetic identities never confer independence**: approvals or attestations
    decided by `local-board`, `board` or an implicit instance admin are
    undecidable for `neutral_verdict` and `independent_review`.
16. **A weak contract is a recorded exception**: `requiredEvidence` below the
    engineering default, or criteria without checks, appear on the card with
    who declared them, and require the founder's recorded acceptance.
17. **Contracts obey the retroactivity rule too**: a criterion whose declaration
    `eventTime` follows an item's terminal transition cannot judge that item —
    the item is *undecidable (criteria declared post hoc)*, never satisfied and
    never failed. Retrospective scoring therefore measures evidence hygiene
    (O5) more than acceptance (O1), and the card says which.
18. **Cancel-and-recreate is correlated**: a cancelled item followed within 14
    days by a new item sharing its `checkoutRunId`/`executionRunId` lineage, its
    parent, or a fuzzy-matched title (normalised token overlap ≥ 0.6) is linked
    as a successor; the cancellation counts as rework for P9 and the successor
    inherits the predecessor's undecidable classes. Cancellations are otherwise
    free, which is the hole this closes.
19. **Reviewer concentration is visible**: reviews between actors who share an
    `accountableUserId` are allowed (on this company every agent shares one)
    but marked `sharedAccountability:true`; a pair whose reviews of each other
    exceed 80 % of either's reviews in a window raises **E14** and those reviews
    drop to Limited-evidence weight for `independent_review`.

## 9. Exceptions, escalation and appeals

### 9.1 Catalogue

**Routing vocabulary.** *Manager* means the agent's `reportsTo`; when that is
null (today: Maya, CoS Reviewer) the exception routes to the accountable human.
*Accountable owner* is derived per §3. On the live company every autonomous
agent's `accountableUserId` is the same human, so accountable-owner routes
collapse onto the founder; the digest rule in §9.2 is what makes that bearable,
and it is deliberate.

| id | condition | severity | routed to |
|---|---|---|---|
| E1 unsupported completion | `done` with an unsatisfied/missing criterion disposition | material | accountable owner |
| E2 contradiction | lower tier contradicts higher, T0/T0 disagreement, or hash change without activity | material for delivery/authority, else routine | both actors' managers |
| E3 authority breach | any P6 detection | **immediate** | founder view + accountable owner |
| E4 self-review | non-independent review-class event | **immediate** | founder view + manager |
| E5 stale work | non-terminal item with no valid action path > 48 h | routine | accountable owner |
| E6 duplicate work | P9 duplicate rule | routine | creator's manager |
| E7 cost anomaly | P8 anomaly, or metering absent on > 50 % of an agent's runs | routine | manager |
| E8 excessive intervention | ≥ 3 interventions on one item, or a human completing an agent-owned item | routine | manager |
| E9 unresolved downstream risk | O3 consequence open 7 days after close | material | accountable owner |
| E10 missing DoD at start | agent-owned item entered `in_progress` with no DoD | routine | assignee's manager |
| E11 emission drop | rule 10 | routine | manager |
| E12 DoD narrowed | rule 11 | material | accountable owner + founder view |
| E13 evidence withdrawn | rule 13 | material | accountable owner |
| E14 reviewer concentration | rule 19 | routine | both actors' managers |

### 9.2 What an exception does, and the chatter ceiling

Routine exceptions are **batched into one review item per milestone per routed
human** — a digest that is created on the first routine exception and **updated
in place** as more accrue; that single item *is* the one routine message the
mandate allows, and updates to it send no further message. The dashboard
(Milestone 4) is the live surface, so a stale item is visible the day it goes
stale without another ping; unbounded milestones therefore do not delay
visibility, only the message. Immediate exceptions (E3, E4,
and E2/E12/E13 touching a release or credential) each create one item at once.
A review item is an issue in the Evaluator review-items project, label
`evaluator-review`, status `todo`, **assigned only to a human** (never to an agent, so no agent is
woken or directed by the evaluator), linking the ledger events and card version.
It never changes a source issue, its status, assignee, verdicts or approvals.
Closing it is the human's act; the disposition is recorded as a ledger event.

### 9.3 When model reasoning is used

Deterministic rules produce every number and every exception. The evaluator
agent is invoked only for: E2 with two T0 sources in conflict; potential gaming
signalled by rules 10–16 that needs judgment (is the emission drop a holiday or
evasion?); ambiguous action paths in E5; quality-of-judgment notes on P2
escalations; and severity triage when a card carries more than five material
exceptions. Each invocation has a token budget (default 150k per card, hard cap
500k, both configurable and reported on the card), works from cached event
digests, and must cite event ids for every statement; an uncited statement is
dropped by the renderer and logged as an evaluator defect.

### 9.4 Appeals and corrections

Any accountable human, an actor's manager, or the founder may file a
**correction**: a ledger event `evaluation.correction` naming the disputed
event, the claimed fact and the evidence. The disputed event is never edited;
replay applies corrections after it, and cards show *corrected from*. **The
disposition is a human's**: the routed human's manager, or the founder when the
correction concerns an evaluator finding about that manager's lane. The
evaluator agent may attach an evidence note; it never decides. While a
correction on a material exception is undecided, the card shows **disputed,
unresolved**; a correction undecided after one milestone, and every rejected
correction, is visible on the founder view automatically — no second filing.
A correction against a T0/T0 disagreement may cite the disagreement's
`correlationId` instead of new evidence, since no higher tier exists to cite.
Corrections filed by the scored actor are allowed and marked `selfFiled:true`
in drill-down provenance only, never on a headline. Until Milestone 4's
surfaces exist, humans file corrections through the evaluation route (or the
founder lane on their behalf); the shadow cards say so.

## 10. Independence and authority of the evaluator

### 10.1 Identity
Role `evaluator`, `reportsTo` null, accountable human = the founder. Outside
Maya's chain by founder decision — a recorded, scoped exception to
`doc/DELIVERY-AND-REVIEW.md` (D2). Independence from the chain is a routing
rule plus the ledger's immutability, not a claim that no one can touch a review
item: humans are meant to act on review items.

### 10.2 Read-only is a mechanism, not a prompt
No read-only principal exists today, and an ordinary agent key can record
verdicts (`POST …/verdicts` checks only company access) and mutate any
unassigned issue (`assertAgentIssueMutationAllowed` returns true when
`assigneeAgentId` is null). So Stage 1 adds one:

- `agent_api_keys.principalKind` (`"agent"` default, `"evaluator"`); the actor
  middleware marks the actor `readOnly`.
- **One deny-by-default gate** in `server/src/middleware/auth.ts`, next to the
  bridge allowlist it mirrors: a read-only actor's non-safe request (anything
  but GET/HEAD/OPTIONS) is refused with 403 unless its path is on the
  **evaluator write allowlist**: `POST /api/companies/:companyId/evaluation/findings`,
  `POST …/evaluation/review-items`, `POST …/evaluation/scorecards`,
  `POST …/evaluation/corrections/:id/note`. Those routes enforce the
  constraints themselves: review items land only in the Evaluator project, with
  the label, `todo`, and a human assignee; findings and cards are ledger
  inserts. No generic issue, verdict, approval, agent, key or release route is
  reachable from that principal, and the tests in §13 prove each refusal.
- The ledger has **no update or delete route for anyone**; immutability is
  enforced at the route layer and by the absence of such routes, and by a
  database rule refusing UPDATE/DELETE on `evaluation_events`.

This is a cross-cutting change of one middleware and one column; the decision
record (D11) costs it. It does not touch existing tables' data or existing
routes' behaviour for other principals.

### 10.3 What the evaluator never does
Create verdicts or approvals; edit or transition a source issue; assign work to
an agent; merge, release, deploy, or change a credential or configuration. Each
is a refused route under §10.2, not a sentence in a prompt.

### 10.4 Who scores the evaluator
Its own operating behaviour is measured by deterministic rules only — chatter
ceiling kept, budget kept, citation rule kept, false-positive rate from human
dispositions on its review items, replay agreement — into an **evaluator card**
the founder reads at each milestone (this is the calibration record Milestone 5
requires). The evaluator agent never runs on its own card.

## 11. Architecture (kept simple)

```
control-plane rows ──► ingest (idempotent, hashed, async) ──► evaluation_events (insert-only)
MAW payloads in comments ─┘                                          │
GitHub (optional adapter, D4) ┘                                      ▼
                                                   deterministic projections (replay)
                                                      ├─ milestone card vN (stored JSON)
                                                      ├─ agent / team operating card vN
                                                      └─ exceptions → digest + immediate items
                                                                     │
                                  evaluator agent (exception-only, budgeted) ──► notes, review items,
                                                                                 founder brief
```

- `evaluation_events`: insert-only, company-scoped, unique dedupe key; columns
  per the mandate (stable id, company/project scope, actor, source ref, event
  time, ingest time, schema version, dedupe key, payload, correlation id, row
  hash). `evaluation_scorecards`: one stored JSON projection per version
  (rendering is a Milestone 4 UI concern).
- Ingest runs on **its own interval** (default 5 min, floor 60 s — not the
  30 s heartbeat scheduler tick, whose fire-and-forget callbacks share the event
  loop and pool with run dispatch), with per-source high-water-mark cursors
  (`heartbeat_run_events.id` and other monotonic ids; `activity_log` by
  `(createdAt, id)`), a per-tick row budget (default 5 000), a `LIKE
  '%"handoff_type"%'` prefilter before any payload parsing, and a
  `statement_timeout` on ingest reads. Backfill is a one-shot job, not a loop.
  Budgets on the card: ingest tick p95 < 10 s; run-start latency delta p95
  < 250 ms during ingest. The card states the maximum ingest lag. Ingest never
  filters approvals by the `APPROVAL_TYPES` union: `verdict_escalation` is
  written by the service but absent from the constant.
- `replay(companyId, milestoneRef, throughEventId)` rebuilds a card and must
  equal the stored one byte-for-byte (the 95 % replay-agreement criterion is
  measured against this).
- **Milestone 1 prerequisites in the control plane** (small, additive
  instrumentation): log authority refusals (`authz.refused`); make `dod_set`
  record the real actor and previous value. Both are activity-log additions.
- Reused as sources, not rebuilt: `verdicts`, `approvals`,
  `issue_review_queue_state`, `cos_reviewer_assignments`,
  `issue_execution_decisions`, `heartbeat_run_watchdog_decisions`, `budget_*`,
  and the `dashboard.ts` task-quality queries that O5 generalises.
  `workflow_events` is person-free by database check and is read only for
  pipeline timings (D8). The live event bus is in-memory; ingest reads tables.

## 12. Acceptance criteria for Milestone 0

1. This spec, the decision record and the data-surface map are on `main`.
2. Reviewed by Theo (technical), Priya (product) and one reviewer outside the
   company agents, findings and dispositions recorded on AGE-84; the founder
   accepts §5 or names the changes.
3. Every metric names population, formula, sources, exception and whether it is
   scored, shown, or Insufficient by construction.
4. §4.2, §6, §7, §8, §9.4 and §10.2 are written before any table or code exists.

## 13. Test focus areas

- Unit: contract schema incl. criterion checks; each formula on fixture ledgers;
  tier boundaries at 0.2/0.5/0.8; renormalisation and guards; dedupe
  idempotence; rules 4–5, 10–16; the read-only gate (every non-allowlisted
  non-safe request from an evaluator key → 403 and no row in the target table;
  every allowlisted route enforces project/label/human-assignee).
- Integration: issue lifecycle, runs, verdicts, approvals, cost → ingest →
  replayed card equals stored card.
- Adversarial: fabricated `tpm_merge_report` with no PR; DoD first set after
  `done`; DoD narrowed after leaving `backlog`; issue description rewritten
  inside an ingest window; comment deleted after a card version; duplicate
  events with different ids; self-review attempt; run status vs activity log
  conflict; runs with no cost; 4- and 6-minute skew; an approval decided by
  `local-board`; a weak `requiredEvidence` declaration.
- End-to-end: two shadow milestones with drill-down from every number.
- Load and cost: ingest of the current instance within the loop budget with no
  measurable change to run-start latency; token spend per card reported.
- Security: company isolation (a key for A reads nothing of B; instance-scoped
  tables excluded); read-only authority by test, not by prompt.

## 14. Out of scope for Stage 1

Enforcement of any kind; automatic reassignment; score-driven budget stops;
customer-facing cards; cross-company comparison; scoring humans (they appear
only as accountable owners and intervention actors); prose-level authority
review; incident attribution.

## 15. Open decisions

D1 (ledger), D3 (milestone), D4 (GitHub credential — none without the
founder), D5 (runtime and budget), D7 (who reviews, who accepts §5), D8
(per-agent identity), D11 (read-only mechanism). See the decision record.
