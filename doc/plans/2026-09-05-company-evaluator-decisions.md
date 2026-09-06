# Company Evaluator — decisions to review, one per design choice

> **Status 2026-09-05:** proposed. Nothing below is applied. Each section states
> the decision, the options with what they cost, and a recommendation.
> Recommendations are the author's to propose and the founder's to accept.
> Companion spec: `docs/superpowers/specs/2026-09-05-company-evaluator-design.md`.
> Founder mandate: Stage 1 is read-only shadow mode; enforcement needs Eyan's
> explicit later activation; the evaluator is outside Maya's chain and never
> reviews its own work.

**Written:** 2026-09-05, immediately after the v2026.904.0 cut, on a branch
from `main` `daa2d6c9`. No release-candidate file is touched by this work.

---

## D1 — A new append-only ledger, or extend the existing `verdicts` table?

| option | cost | effect |
|---|---|---|
| **A. New `evaluation_events` table, insert-only; existing tables become sources** | one additive migration; ingest code | one place to replay from; existing rows keep their meaning; no risk to the verdict service |
| B. Extend `verdicts` with more outcome types and score columns | small migration | conflates a reviewer's judgement with system-derived facts; replay impossible without event time/ingest time; couples to the HITL flow that is currently unused |
| C. Derive everything at query time from source tables, no ledger | no migration | not replayable, no ingest time, no dedupe, retroactive edits invisible — fails the mandate's determinism and anti-gaming requirements |

**Recommend A.** The mandate asks for immutability, idempotence, event time vs
ingestion time and deterministic replay; only a dedicated append-only table
gives all four. `verdicts`, `approvals`, `activity_log` and the run tables are
ingested as sources, never modified.

## D2 — Recorded exception to `doc/DELIVERY-AND-REVIEW.md` routing

That document routes material status, decisions and exceptions Maya →
Executive OS → Monica and forbids a direct user-facing bypass. The founder's
mandate requires the evaluator to be independent of Maya's chain and to report
to the founder view.

| option | cost | effect |
|---|---|---|
| **A. Record a scoped exception: the evaluator's scorecards, exceptions and founder brief go to the founder view; everything else keeps the chain** | a paragraph in DELIVERY-AND-REVIEW.md naming the exception and its reason | the measured party does not sit between the measurement and the founder; ordinary product work is unchanged |
| B. Route evaluator output through Maya | none | defeats the independence the founder decided on |
| C. Replace the chain doc | large, unrelated | out of scope |

**Recommend A.** The exception is the point of the design, and it is narrower
than it sounds: the evaluator reports on the company; it does not run the
company. Maya keeps product leadership and continues to receive the same cards
everyone else sees.

## D3 — What is a "milestone"?

The schema has goals (levels company/team/agent/task, with parents) and
projects (linked to goals through `project_goals`), and no milestone entity.

| option | cost | effect |
|---|---|---|
| **A. Milestone = a project; a team/agent-level goal without a project acts as one** | none — contract carries `milestoneRef {kind, id}` | matches how the company already works (projects "MVL 1.0 Launch", "Design-Partner Learning & GTM Readiness"); no schema change |
| B. Add a `milestones` table | migration, UI | new concept for people to maintain; unused tables already litter the schema |
| C. Milestone = goal at level `task` | none | too fine; hundreds of cards |

**Recommend A.** Both live projects are `in_progress` with null target dates,
so "milestone = project" imports "milestone = whenever someone closes the
project"; acceptable in shadow, and the card carries the *open milestone* marker
(spec §4.6). For the two shadow milestones: the first is "MVL 1.0 Launch",
scored retrospectively with confidence capped (most of its items will be
*undecidable — criteria declared post hoc*, rule 17, so it measures evidence
hygiene more than acceptance). For the second, Priya's review (AGE-86 F7)
proposes **the Company Evaluator Stage 1 build project itself**, because it is
the only work with written, bounded per-milestone acceptance (M0–M5), it is
forward-looking so its contract is declared before the work, and it exercises
the review-item exclusion (rule 12) for real; the alternative, "Design-Partner
Learning & GTM Readiness", would be a second retrospective with the same nulls.
Prerequisite either way: the Evaluator project and its goal currently have no
lead and no owner — the contract declaration must set the founder as
`accountableUserId` first (AGE-86 F9). **Founder to name the second milestone.**

## D4 — GitHub and CI evidence: how does it enter the ledger?

Delivery (`delivery_ref`, `ci_green`, `independent_review` in the spec's
evidence classes) lives in GitHub. The control plane stores none of it.

| option | cost | effect |
|---|---|---|
| **A. Stage 1 ingests the structured MAW payloads already posted in comments (`builder_to_ci`, `tester_to_reviewer`, `reviewer_to_tpm`, `tpm_merge_report`) as T2 self-reports; no new credential** | parser + schema validation against `doc/maw/handoff-schemas.json` | honest but capped: delivery evidence is self-reported, so O1 confidence is at most Medium and E2 contradictions cannot be detected against GitHub |
| B. Add a server-side GitHub ingest adapter using a read-only token | **a new credential, which the mandate says needs the founder's approval**; adapter code | T1 evidence: PR state, reviews, check runs; self-review on PRs becomes detectable; O1 can reach High |
| C. A CI job that POSTs its results to the instance | an instance URL and key in CI secrets — also a credential | covers CI but not reviews |

**Recommend A now, B when the founder approves a read-only GitHub token.** The
design is written so B is an adapter that raises tiers, not a redesign. The
concrete consequence of staying on A, verified by Priya against the live board
(AGE-86 F1): the company holds 25 `pm_to_builder` payloads and **zero**
`builder_to_ci`, `tester_to_reviewer`, `reviewer_to_tpm` or `tpm_merge_report`
payloads, so `delivery_ref`, `ci_green` and `independent_review` are
undecidable for all of MVL 1.0's history and its card will read *insufficient*
for O1 and O5 until T1 evidence exists. The recommendation to the founder is
to approve B before Milestone 5, because "100 % of material claims trace to
evidence" cannot be met for delivery claims on T2 alone.

## D5 — Evaluator agent runtime and token budget

| option | cost | effect |
|---|---|---|
| **A. Same Hermes profile as the other agents (`glm-5.3-flash`), default 150k tokens per milestone card, hard cap 500k, both configurable and reported** | no new provider or credential | consistent with company practice; cheap; adequate for exception-only review of cached digests |
| B. A Claude-backed agent | a provider key the company does not hold today | higher judgement quality for prose breaches; new credential |
| C. No model at all in Stage 1 | none | E3-candidate prose breaches and incident attribution would go unreviewed |

**Recommend A**, with the budget on the card so the founder can see cost per
milestone (a graduation criterion). Revisit at the end of milestone one of the
shadow run if the deterministic rules leave too many exceptions for the model
to triage well.

## D6 — Where do scorecards live?

| option | cost | effect |
|---|---|---|
| **A. An `evaluation_scorecards` table holding one stored JSON projection per version; rendering is a Milestone 4 UI concern** | one additive table | queryable, replayable, diff-able between versions; one artifact per version for the replay-agreement check |
| B. Documents only | none | not queryable for trend or drill-down |
| C. Compute on every page load | none | slow, and the "replay agreement" criterion needs a stored artifact to compare against |

**Recommend A.** (Revised after review: the first draft also stored a rendered
document per version; that is a third artifact the projection already
determines, so it is dropped.)

## D7 — Who reviews the plan, and who accepts the metric definitions?

| option | cost | effect |
|---|---|---|
| **A. Technical review by Theo on the board; product/operability review by Priya; one independent reviewer pass outside the company agents; the founder accepts §5 (metrics) explicitly** | three review tickets; founder time on one section | no author approves own work; the measured party (Maya's work is among the things measured) does not set the ruler |
| B. Maya reviews and approves as product lead | none | conflict of interest on the metrics that will measure her lane |
| C. Founder reviews everything alone | founder time | slow; loses the team's knowledge of the machinery |

**Recommend A.** Maya is informed and may comment; she does not approve the
metric section.

## D8 — Per-agent scoring next to the person-free `workflow_events` table

`workflow_events` and `workflow_recommendations` were built person-free on
purpose: database checks reject any actor identity in their rows, so the
platform can trend a pipeline without ranking people. The founder's mandate asks
for per-agent, per-team, per-goal and per-milestone scores.

| option | cost | effect |
|---|---|---|
| **A. Separate ledger that carries actor identity for agents; humans appear only as accountable owners and intervention actors, never as scored subjects; `workflow_events` stays untouched and is read for timings** | one table (D1) | honours both: agents are scored as the mandate requires; people are not, which is the existing table's intent |
| B. Relax `workflow_events` checks to admit agent ids | migration touching a privacy control | breaks a deliberate guarantee for the MK product profile |
| C. Score agents only in aggregate (team level) | none | fails the mandate's per-agent requirement |

**Recommend A**, and write the human-out-of-scope rule into the spec (§14) so
nobody reads an agent scorecard as a staff review.

## D9 — The DoD guard flag stays off

`feature_flags.dod_guard_enabled` makes the control plane refuse an issue leaving
`backlog` without a definition of done. It has never been enabled on the live
company, which is why 0 of 80 issues carry one.

| option | cost | effect |
|---|---|---|
| **A. Leave it off; the evaluator observes and raises E10 (missing DoD at start) and E1 (done without evidence)** | none | measurement without enforcement, as the mandate requires |
| B. Enable it as part of Stage 1 | one flag row | blocks agents' status transitions — enforcement by another name |

**Recommend A.** Enabling the flag is a candidate for the later enforcement
stage and needs the founder's explicit activation like everything else there.

## D10 — Enforcement stays off until an explicit activation event

Recorded so it cannot be lost: Stage 1 writes nothing outside its own ledger,
scorecards and review items. Any later enforcement is a separate design with
its own decision record, activated only by an explicit founder action recorded
as a ledger event. **Not a choice — the founder's standing instruction.**

## D11 — How "read-only" is enforced for the evaluator principal

The first draft asserted that the evaluator's prohibition was "implemented as
permission". The independent review showed there is nothing to implement it
with: `principal_permission_grants` holds nine additive keys with no deny
scope, `agent_api_keys` has no read-only notion, `POST …/verdicts` requires
only company access, and any agent key may mutate an unassigned issue.

| option | cost | effect |
|---|---|---|
| **A. A `principalKind` on the evaluator's API key and one deny-by-default gate in `server/src/middleware/auth.ts`, mirroring the existing bridge-endpoint allowlist: non-safe requests from a read-only actor are refused unless the path is on the evaluator write allowlist (its own `evaluation/*` routes, which enforce project/label/human-assignee)** | one column, one middleware block, four evaluation routes, tests per refused route | the prohibition becomes a property of the system; the pattern already exists in the same file; no other principal's behaviour changes |
| B. Per-route permission checks on every write route | touches 80+ route files | large, easy to miss one, and the review found only 6 of 81 route files consult `hasPermission` today |
| C. Prompt-level only | none | the mandate's central constraint rests on the model's obedience; the review's F2 shows what a key could do today |

**Recommend A.** It is a cross-cutting change of one middleware and one column,
so the implementation sketch below no longer claims "no existing table touched":
it adds a nullable column to `agent_api_keys` and a gate beside the bridge
allowlist, and it changes nothing for ordinary agent keys.

---

## Plan by milestone (acceptance summarised; details live on the board)

| milestone | deliverable | acceptance |
|---|---|---|
| 0 Discovery and contract | this record, the spec and the data-surface map on `main` | three reviews recorded and dispositioned on AGE-84; founder accepts §5 or names changes |
| 1 Ledger | `evaluation_events` + `evaluation_scorecards` migration; ingest for T0 sources and T2 payloads with row hashes; backfill with unknown labels; `replay`. Prerequisite instrumentation split out: `dod_set` recording actor + previous value landed separately (#611); `authz.refused` activity events are AGE-91 (in progress) and gate P6's refusal detections in Milestone 2 | integration test: fixture events → replayed card equals stored, including after the milestone closes; adversarial dedupe/skew/hash/dense-window tests |
| 2 Scoring | deterministic projections for O1–O5, P1–P9, exceptions E1–E13, tiers, renormalised composites with guards | unit tests per formula and tier boundary; replay agreement 100 % on fixtures; no value shown at the Insufficient tier; composites absent when guards fail |
| 3 Evaluator agent | role `evaluator`, `principalKind: evaluator` key, the read-only gate (D11), evaluation routes, exception-only prompt, budget, cached digests, digest review items | every non-allowlisted non-safe request from the evaluator key → 403 with no row written; one routine review item per milestone per human enforced by the notifier |
| 4 Surfaces | dashboard, drill-down, founder view, normalised comparison | e2e: every number links to formula and events; no unnormalised ranking |
| 5 Shadow and calibration | two milestones scored; disagreement log; cost report; recommendation | the mandate's graduation criteria, each measured and reported |

## Implementation sketch (for review; nothing is built yet)

Company-scoped, following the repo's service/route/schema patterns. Additive
except where D11 and the two instrumentation prerequisites say otherwise:

- `packages/db/src/schema/evaluation_events.ts` — insert-only ledger (id,
  companyId, projectId?, goalId?, actorType/actorId, sourceTable/sourceId,
  sourceRowHash, eventType, schemaVersion, eventTime, ingestTime, dedupeKey
  unique, payload jsonb, correlationId?) with a database rule refusing UPDATE and
  DELETE. `packages/db/src/schema/evaluation_scorecards.ts` — one stored JSON
  projection per version (companyId, milestoneRef, version, contractVersion,
  formulaVersion, throughEventId, card jsonb, createdAt). `agent_api_keys`
  gains a nullable `principalKind` (D11). One migration (0127), forward-only.
  Exported from `schema/index.ts`.
- `server/src/middleware/auth.ts` — read-only actor marking and the evaluator
  write allowlist gate, beside the bridge allowlist (D11).
- Instrumentation prerequisites in existing services (small): `authz.refused`
  activity events on 403 refusals (incl. `NEUTRAL_VALIDATOR_VIOLATION`);
  `dod_set` recording the real actor and `_previous` in `verdicts.ts`.
- `server/src/services/evaluation/ingest.ts` — idempotent, hashed readers for
  T0 tables and the MAW payload parser (T2); periodic, off the request path,
  with interval and row budget. `replay.ts` — pure projection; `scoring.ts` —
  O1–O5, P1–P9, tiers, composites with guards; `exceptions.ts` — E1–E13 and the
  digest rule; `independence.ts` — §4.2, also offered to the verdict service.
- `server/src/routes/evaluation.ts` — read routes for cards, drill-down and
  events; write routes only for findings, review items (Evaluator project,
  label, `todo`, human assignee enforced), scorecards, correction notes, and the
  human `correction` and `disposition` events; every handler asserts company
  access.
- `packages/shared/src/constants.ts` — event types, exception ids, tiers;
  `packages/shared/src/schemas` — the contract v1 and scorecard schemas.
- `ui/src/pages/evaluation/*` — dashboard, drill-down, founder view
  (Milestone 4).
- Agent: role `evaluator`, `reportsTo` null, accountable human = founder,
  Hermes profile as the other agents (D5), key with `principalKind: evaluator`,
  prompt limited to exception review, budget on the card. Adding the role
  touches the four agent prompt surfaces named in AGENTS.md (Milestone 3).

## Baseline recorded at Milestone 0 (read-only, as of 2026-09-05 18:35Z)

Company Agent Runner: 80 issues (32 done, 10 cancelled, 15 backlog, 7 blocked,
8 in review, 8 todo); definition of done set on 0 — **the per-tenant DoD guard
was never enabled, so nothing ever asked for one**; verdicts 0; approvals 0;
142 runs (113 succeeded, 28 cancelled, 1 failed) with usage on 13; 2 cost events;
2 goals, both without metric definitions; 5 `ask_user_questions` interactions
pending unanswered (median age to be reported, not the count alone); CoS
Reviewer assigned as reviewer, never run; deployment mode `local_trusted`. By
the time Priya reviewed the same afternoon the counts were already 85 issues /
36 done, 3 projects, 3 goals (the evaluator's own program) — which is why every
baseline in the shadow run is pinned to an as-of timestamp. These numbers are
the coverage floor the shadow run starts from, and the reason §7 of the spec
refuses to show a score where evidence does not exist.

## Milestone 1 review notes (2026-09-05, PR #612)

Recorded here rather than in the spec, which is at its size limit.

- **Immutability caveat (spec §10.2).** The ledger's row triggers refuse UPDATE
  always and DELETE outside the tenant-deletion transaction. Two statements
  bypass row triggers by design and are not trapped: `TRUNCATE` (privilege-gated;
  no application path; the test harness truncates `companies CASCADE`, which is
  why a statement-level TRUNCATE trigger was tried and reverted) and
  `ALTER TABLE … DISABLE TRIGGER` (owner-only). The gate is a session setting
  any SQL path can set — including plugin migrations, which run raw SQL — so it
  is a strong accident-prevention mechanism and a weak adversary-prevention one:
  it stops application code from deleting ledger rows by mistake or by an
  ordinary bug, not a hostile operator with database access. A separate
  restricted database role for the evaluator is the adversary-grade control and
  stays deferred (B2).
- **Ingest concurrency.** One tick per company is one transaction holding a
  per-company advisory lock, so the scheduler and the operator route (separate
  service instances, possibly separate processes) can never interleave; the
  cursor advance commits with the events it covers. A locked company returns 409
  on the operator route and is skipped with a warning by the scheduler.
- **Withdrawal detection cadence (rule 13).** Detecting deleted comments scans
  every known comment id, so it runs hourly (per company, recorded in the
  `issue_comments` cursor), not every tick. Withdrawal becomes visible within an
  hour; scoring (Milestone 2) reads the ledger, so this is a latency, not a gap.
- **Versions are facts, not touches.** A comment's handoff payloads are versioned
  by type, position in the comment and body hash (two same-type payloads in one
  comment are two facts; at most 8 per comment, the rest counted). Interactions
  are one event per status. A terminal run without `finished_at` never takes a
  time into its version. Issue snapshots include `updated_at`, so an A→B→A
  rewrite is three snapshots.
- **Accepted, not fixed.** A comment whose `created_at` is backdated by the
  productivity-review writer after insert can be stamped with the pre-backdate
  time if a tick races the write (F9): accuracy nit, no loss, dedupe key
  unchanged. The 60-second cursor lag covers the common case.
- **Deferred with a reason.** Leading `(company_id, created_at/updated_at)`
  indexes on the source tables and a `cost_events.created_at` index (E4, Theo
  Q6.3): fine at execos-local scale, add before real load. A CHECK on
  `agent_api_keys.principal_kind` and the visibility of
  `GET /evaluation/events` to company-member agents (it carries per-agent cost
  payloads): both decided in Milestone 3 when the evaluator principal exists.
  The ingest interval is read once at boot; changing it needs a restart.
- **Health gauge.** Every scheduled tick logs `maxLagMs` (now minus the oldest
  event time inserted) beside scanned/inserted counts; the shadow run's ingest
  measurement (AGE-90 c5) reads it.
- **Second independent review (round 2, 2026-09-05).** Taken: the `open`
  flag is pinned inside the card so a stored version keeps verifying after its
  project or goal closes (Milestone 2 derives it from `project.snapshot` events
  instead); keyset reads are two bounded parts — progress on `(time, id)` plus a
  lag re-read — so a dense window can never stall a cursor; an issue snapshot is
  minted only when its content hash changes (the run lifecycle touches
  `updated_at` on every claim); a combined status + assignee change mints both
  facts from one activity row; the retrospective check no longer spreads a
  window into a call; the replay route is administrator-only while it
  materialises the company window in Node; the operator routes' own audit rows
  are skipped by the activity reader (rules 9/12); the lock key is 64-bit;
  `backfill` reports a lock collision instead of discarding committed passes;
  withdrawal-candidate lookup excludes withdrawn ids in SQL. Design limit
  recorded: replay loads one company's whole window into memory and sorts it —
  fine for the shadow companies, to be moved into SQL aggregation before real
  load. Accepted as notes: the integration test is order-coupled; a terminal run
  whose `finished_at` is filled in after its status would mint twice (no writer
  does this today); the comments prefilter matches any JSON with a `type` key.
- **Verification of round 2 (same reviewer) and Theo's re-review (AGE-95, READY).**
  Taken: `GET …/scorecards?verify=true` is administrator-only like the replay
  route (plain card reads stay open to members); the lag re-read runs backwards
  from the cursor so its bound covers the rows nearest it; a PATCH that echoes
  an unchanged assignee mints no assignment fact (with `_previous` present the
  assignee key must be there); the ingest-run audit row records `passes`,
  `exhausted` and `lockedOut`, and a 409 carries `Retry-After`; `verify` skips
  the live milestone read when the flag is pinned. Restated: the effective lock
  hold is `statement_timeout × statements` (scope resolution walks up to eleven
  queries per source, withdrawal detection chunks by 1000, appends chunk by 500),
  every statement bounded, so a tick is bounded — not `× sources` as first
  written. Operational note from Theo: migration 0127 was edited in place across
  review commits; a development database that applied an intermediate shape
  keeps it (`pnpm db:migrate` does not repair a journaled migration) and must be
  reset before running the final shape. Fresh databases and CI are unaffected.

## Milestone 2 implementation notes (2026-09-05, scoring branch)

- **Every fact a projection needs is in the window.** Roster snapshots
  (`agent.snapshot`, `project.snapshot`, `goal.snapshot`) and label additions
  enter the ledger; issue snapshots carry labels, title tokens, lifecycle
  timestamps and lineage; DoD events carry criterion ids and text hashes. The
  open flag is therefore a ledger fact once a roster snapshot exists; the live
  row is only the fallback for a window without one. Schema version 2.
- **Card = pure function.** `scoreMilestone(window, ref, throughSeq, companyId,
  {fallbackOpen})` folds the ordered window into per-item timelines, resolves
  the contract (declared, else derived with the engineering-default evidence set
  and no criteria), evaluates evidence classes and criterion dispositions, then
  O1–O5, P1–P9 per agent plus the company row, tiers, composites with guards,
  and exceptions E1–E14 with roster routing. `FORMULA_VERSION = m2-score/1`.
  The deterministic "now" is the latest event or ingest time in the window.
- **Single writer preserved.** Snapshots (which append `evaluation.finding`
  events) and contract declarations take the same per-company advisory lock as
  ingest, so `seq` never gains a lower row after a cut.
- **Derived contracts declare no criteria.** Criterion text is not in the
  ledger, so O1 is Insufficient until a human declares a contract with checks —
  the gap the spec says to measure, not assume. `human_attest` dispositions are
  read from `evaluation.disposition` events; the route that writes them is M3.
- **Known approximations, to be judged on the first shadow cards.** P6's
  "agent transitioning an item it is not assigned to" fires on the sanctioned
  review→done step by a reviewer or TPM and will be the noisiest rule; E5's
  "valid action path" is approximated as any activity, pending question,
  pending approval or human owner within 48 h; P4 judges assignments on the
  definition of done because description presence is not in the ledger; P3's
  only checkable claims today are payload timestamps (the GitHub adapter, D4,
  adds the rest); O3's recovery-issue term and P5's `heal_attempts` are not
  modelled; O2 populations are the milestone only (issues carry no target
  date); a fully no-op PATCH still mints phantom facts (no `_previous` is
  written when nothing changed).
- **Tests.** 23 fixture-ledger unit cases (determinism, rules 4, 10–19, tiers
  at 0.2/0.5/0.8, composites and guards, membership moves, each exception) plus
  the Milestone 1 suites extended for roster events, contract routes and the
  ledger-derived open flag; a second file pins every correction from the first
  independent review (below).
- **First independent review (round 1).** Three findings were real spec
  deviations and are fixed: the §4.2 project-lead and goal-owner checks were
  unreachable for issue reviews (now applied to every review-class event from
  the item's project and goal at review time); a declared contract that dropped
  evidence classes scored O5 as 100 (waived classes are now undecidable for every
  item, so waiving lowers coverage, and a rule-16 exception without a recorded
  founder acceptance — an `evaluation.disposition` of kind
  `contract_exception_accepted` naming the contract event — caps O1/O5 at
  limited evidence); rule 17 was applied per contract document (now per
  criterion: each criterion keeps its earliest declaration time across
  amendments). Also fixed: a narrowed DoD fails `dod_present`; a synthetic
  decider leaves `independent_review` undecidable (rule 15); rule-19 pair reviews
  weigh as limited evidence and cap O5 when they are the only review; the
  evaluator's own findings no longer inflate the blind window or the digest;
  `agent.snapshot` versions carry the row time; O4 is shown, never scored, until
  an outcome target is measurable (nothing imputed); count metrics render zero
  as a value; O2 falls back to the project's target date; E2 is material for
  delivery claims; snapshots read on the lock's own connection; evaluator
  review items cannot become successors or blocker citations (rule 12);
  findings hash their identity, not their phrasing; an unattributed review is
  neither credit nor violation; `ci_green` requires `pre_existing_failures`
  named; per-agent composites carry E3/E4 flags raised anywhere about that
  agent; the card caps exceptions at 500 and issue ids at 5000 with exact
  counts. `FORMULA_VERSION` is `m2-score/2`. Accepted as notes: P2's value is
  approved over decided (undecided escalations are undecidable, not failures);
  roster names and titles are stored while issue titles are tokenised; O2's due
  instant is UTC end of day; the per-agent metric block is O(agents × members)
  and O3/P9 scans are quadratic in members — fine for the shadow companies,
  to move into SQL with the replay aggregation before real load.
- **Theo's technical review (AGE-96) and Priya's product review (AGE-97).**
  Contributors now follow §3 in full — anyone who changed status, assignee,
  blockers or the DoD, authored a comment or a non-review self-report, ran a
  heartbeat on the item, or was ever its assignee. One reading is recorded:
  review-class acts (verdicts, tester handoffs, approval decisions) are the acts
  independence judges, so they do not by themselves make their author a
  contributor; otherwise every second verdict on an item would be a self-review.
  P2 links an escalation to its decision through the approval id; E9 covers
  blocker citations still standing and reverts not re-shipped within seven days,
  not only reopens; E14 routes both actors' managers. The card's prose follows
  Priya's rules: no rule or section numbers in founder-facing strings (they live
  in this record and in drill-down), no parentheses or semicolons inside an
  undecidable reason (headlines join reasons with "; "), remedies inside
  undecidable reasons, dollars not cents, enum keys rendered as words, markers
  that name their cap, and two new markers — partial records when any source is
  absent from the window, and a lag marker when records trail events by more
  than a day. The derived-contract exception now states that acceptance is
  insufficient by construction and names the one action that changes it.
- **Second verification of the scoring branch (round 2).** Two more real
  defects, both fixed: every posted comment has an `issue.comment_added` twin in
  the activity log, so the review-class carve-out has to skip the twin of a
  review handoff too (otherwise every MAW reviewer is a self-reviewer on real
  data — the fixtures now carry the twin); and rule 17 keyed on a criterion's id
  alone let a check be rewritten in place under the same id, so a criterion is
  now its id and its content. Independence is judged twice: as of the review,
  and as of the close with the terminal transition excluded, so a verdict
  recorded before its author took the item over cannot certify the close. O1 and
  O5 values are over the decidable population (§7: unknown is never passed and
  never failed either); coverage carries the unknown. Findings that were dated by
  the moving "now" (E11, E14, the metering E7) are dated by their last fact.
  Acceptance of a contract exception must come from a real human — the
  accountable one when named — never a synthetic identity. Schema-invalid contract
  versions are shown but cap nothing. The lag marker stays off retrospectives.
  P6's tier says when the refusal detector is blind. **For the founder to expect
  on the first shadow card:** any agent that leaves an ordinary comment on an item
  and later records its verdict is a self-reviewer under §3 — it will be the
  largest source of immediate exceptions in the shadow run, by design; the
  question for Milestone 5 is whether that rule should stand.
- **Third verification (round 3).** The review-class set is both reviewer
  handoffs (`tester_to_reviewer`, `reviewer_to_tpm`) — a reviewer handing its
  review down the chain is not a contribution — and their comment twins,
  matched by comment id or, when an id is missing, by the same actor within the
  skew tolerance. A criterion's rule-17 key is its id and its check; its text
  is prose and may be reworded without becoming a new declaration. The
  close-time independence check counts work-changing acts only (runs, entering
  in_progress, taking the assignment, implementation self-reports, DoD edits),
  so a reviewer's "thanks" after its verdict changes nothing while a run after
  it does. Under a partial waiver, items are judged on the classes the contract
  requires and the waiver is carried by the rule-16 cap and the per-class
  record; a contract that requires no class decides nothing. Composites weight
  each metric by its coverage, so a value over a fifth of the items does not
  count like one over all of them; O3 and P9 keep population denominators
  because they are indices. The refusal detector's blindness caps P6 at limited
  evidence rather than pretending a coverage number. The surface the twin skip
  creates is named: directive prose inside a review handoff is unscored, as all
  prose is.
- **Fourth verification (round 4).** The O5 rewrite had reopened rule 16's
  lever: an item counted as satisfied only when every required class was
  decidable, so on a source-poor deployment the default contract scored 0 while
  a waiver scored 0.8 at full composite weight. Now each item is judged over the
  required classes decidable for it, and coverage is the share of the five
  default classes decidable per item — an undecidable class and a waived class
  lower it alike, so waiving is weight-neutral. Composites report their own
  coverage (Σwᵢcᵢ / Σwᵢ) and are withheld below 0.5, so muting a failing metric
  by making it undecidable cannot lift the score. The twin fallback fires only
  when a comment id is missing on either side; a reviewer's comment that has its
  own id and matches no review handoff is a real comment however close in time.
  `FORMULA_VERSION` is `m2-score/3` (composites `composite/3`). Deliberate
  narrowing recorded: the close-time independence check counts work-changing
  acts only — runs, entering in_progress, taking the assignment, implementation
  self-reports, DoD edits — and therefore not blocker edits or non-in_progress
  status changes after a verdict, which §3 would count as writes; the check
  exists to catch implementation performed after certifying, and those acts
  still disqualify when they precede the review.
- **Fifth verification (round 5).** The coverage floor made one defect
  consequential: O3 reported coverage 1.0 whatever the records held, so on the
  first shadow company — done items, no criteria, no verdicts, no delivery
  references — the outcome composite was computable and read about 77, supplied
  entirely by "no consequences recorded". Two changes close it. O3's coverage is
  now the mean of its three terms' observability: the two T0 terms are always
  observable, the revert term only for items with a delivery reference, so the
  shadow company shows 0.667 and the note says for what share the revert term
  could be seen. Composites gained a concentration guard beside the floor: no
  single metric may supply more than 70% of the effective weight (Σwᵢcᵢ), and a
  withheld composite names the metric and its share; every violated guard is
  listed, the most specific first. Independently, any handoff type had counted
  as a review source, so a company that only records PM briefs saw
  independent_review fail instead of stay undecidable; presence is now judged
  on review-class handoffs (tester_to_reviewer, reviewer_to_tpm) alone, and the
  undecidable reason carries the remedy. The composite floor and the
  concentration ceiling live in `packages/shared` beside the minimum-included
  counts. `FORMULA_VERSION` is `m2-score/4` (composites `composite/4`, metrics
  `metrics/2`). Two notes for operators: an accepted waiver lifts O5's
  confidence cap but restores no weight, because the records still do not
  exist; and a deployment that stops emitting structured regression gates turns
  ci_green failures into undecidables, which lowers O5's coverage rather than
  raising its value — the composite floor and the concentration guard hold that
  line, and E11 (activity drop) needs its five-week baseline before it can name
  the drop itself, so the first shadow milestone cannot detect that lever
  through E11 alone.
- **Sixth verification (round 6): READY, ceiling moved to 0.75.** The reviewer
  re-derived the shadow baseline by hand (O3 effective 0.133 against O5 0.03:
  82% concentration, 47% coverage, score withheld) and confirmed both fixes
  revert-sensitive. One design consequence surfaced: at a 70% ceiling, O1 + O2
  and O1 + O5 at full coverage sit at 72.7% and would be withheld with complete
  evidence on both, which quietly made the outcome minimum three metrics
  whenever O1 is present — and the second shadow milestone is chosen precisely
  because O1 will be measurable there. The ceiling is 0.75: every O1-bearing
  pair stays reachable, and a metric standing in for a missing one (77% in the
  unit pin, 82% on the baseline) is still caught. Guard shape fixed for the
  Milestone 4 renderer: `guard.reasons` is always an array (empty when
  satisfied) and `guard.reason` is the headline alias for its first entry; the
  concentration and floor reasons are judged only once the minimum-included
  check passes, so a lone metric never reports a tautological 100%. Recorded,
  not changed: O3's two T0 terms are counted observable with no exposure
  window, so a young milestone reads O3 = 0 by construction until items have
  had time to attract a reopen or a blocker citation; the concentration guard
  bounds what that can supply, and E9's seven-day horizon is the precedent if
  an exposure normaliser is wanted later.
  Commit 7 changed the card's bytes (`guard.reasons` on every satisfied
  composite, the ceiling in `guard.maxConcentration`) and its substance (a
  72.7% pair now scores), so `FORMULA_VERSION` is `m2-score/5` and composites
  `composite/5`; metrics stay `metrics/2`. Known approximation recorded for P6:
  the AGE-91 refusal log deduplicates the same actor, reason, route and entity
  within sixty seconds in process, so a retry storm on one forbidden act counts
  once per minute per server instance and P6 is a floor on violating requests,
  not a count of them; distinct acts on distinct items are never collapsed.

## Milestone 3 implementation notes (2026-09-06, principal branch)

- **Read-only is a mechanism (D11, §10.2).** `agent_api_keys.principal_kind =
  "evaluator"` mints an actor with `readOnly: true`; the actor middleware refuses
  every non-safe request from it with 403 `EVALUATOR_READ_ONLY` unless the path
  is on the evaluator write allowlist (findings, review-items,
  scorecards/snapshot, corrections/:id/note), and records the refusal as an
  `authz.refused` activity row. Scoring excludes rows with that reason code from
  P6: the gate doing its job is not a company breach. Ordinary agent keys are
  untouched (tests prove both).
- **Provisioning.** `POST /companies/:companyId/evaluation/principal`
  (administrators): one agent with role `evaluator`, `reportsTo: null`,
  accountable to the provisioning administrator, one read-only key whose token is
  returned exactly once; idempotent, `rotateKey` revokes the previous evaluator
  keys; also creates the "Evaluator review items" project. The evaluator role
  gets its own instruction bundle (`onboarding-assets/evaluator/AGENTS.md`):
  exception review only, citation rule, budget, what it never does.
- **Review items (§9.2) are deterministic server code**, not the agent: one
  digest per milestone per routed human (created on the first routine
  exception, updated in place — an update sends no message), one item per
  immediate exception (E3, E4, material E2/E12/E13); always in the review-items
  project, labelled `evaluator-review`, `todo`, assigned to a human — the routed
  accountable owner, else the contract's accountable human, else the
  administrator who ran the snapshot; exceptions with no human anywhere are
  reported as unrouted, never assigned to an agent. Items carry their key in a
  marker, so re-running changes nothing that has not changed. Triggered by
  `POST …/evaluation/scorecards/snapshot?reviewItems=true` or
  `POST …/evaluation/review-items` (evaluator principal or administrators).
- **Shadow cadence.** `AGENTDASH_EVALUATION_SNAPSHOT_ENABLED=true` runs a pass
  on its own interval (floor one hour, default one day): every open project of
  every company gets a stored card and its review items; the fallback human for
  unowned exceptions is the company's first active administrator; a locked or
  failing milestone is skipped with a warning and caught up on the next pass.
  Deterministic; no model call; off by default like ingest.
- **The evaluator's own writes (§9.3, §9.4).** `POST …/evaluation/findings` —
  an evidence note on an exception; `POST …/evaluation/corrections/:id/note` —
  an evidence note on a human's correction; both require at least one citation
  that is a ledger event of this company (an uncited note is refused, not
  stored) and are appended under the company lock with the `evaluator` actor.
  Humans: `POST …/evaluation/corrections` (any board member; the disputed event
  must exist; a T0/T0 disagreement may cite its correlation id instead of new
  evidence) and `POST …/evaluation/dispositions` (administrators: decide a
  correction, attest a criterion, accept a contract exception). The
  disposition is always the human's; the evaluator never decides.


- **Milestone 3 review round 1 (independent reviewer, REQUEST CHANGES → fixed).**
  Two blockers. Read-only had been a property of the evaluator's API key, so an
  ordinary key minted on the evaluator agent or the local JWT the heartbeat
  issues to any dispatched agent would have carried full agent authority; the
  gate now derives the principal from the agent's role as well as the key's
  kind and runs for both credential paths, so every credential that resolves to
  the evaluator agent is read-only. A closed review item was invisible to the
  idempotency lookup and would have been recreated on the next pass — an
  unbounded loop for a hostile key holder; the lookup now finds the item in any
  status and a closed one is left closed, reported as `closed`, never reopened
  or recreated. Also fixed: the evaluator's own refusals no longer open an
  operating row for it or count as evidence that the company records authority
  refusals; `scorecards/snapshot` left the evaluator allowlist (the route was
  administrator-only anyway — snapshots belong to the cadence and
  administrators, the principal creates review items); an unchanged card adds
  no version; the cadence visits only companies that provisioned an evaluator
  principal, snapshots projects only, and routes unowned exceptions to an
  administrator or records them unrouted, never to an arbitrary member;
  immediate items keep their paragraph breaks; founder prose carries no section
  numbers, formula keys or raw ids (agent subjects are named); the review
  project and label are created under a per-company advisory lock; the key
  marker lookup escapes LIKE metacharacters; correction notes look up the
  correction by id and type; the optional call on key revocation and the cast
  on the evaluator agent's insert are gone. Prompt surfaces (`default/AGENTS.md`
  and the proposal-based creator) now tell agents never to pick up, act on or
  comment on `evaluator-review` items, so the drift check passes without a
  bypass. Recorded deviation kept: the evaluator agent's accountable human is
  the provisioning administrator, not the founder as §10.1 writes — the founder
  should confirm, since it decides who receives unrouted exceptions.

- **Milestone 3 review round 2 (READY; hardening taken).** The reviewer verified
  every round-1 fix against code and tests and confirmed no deadlock between the
  review-items lock and the ingest lock, and that a reused snapshot cannot skip
  findings (insert and append share one transaction). Taken from the round: a
  malformed event id in a citation or a correction path is a 400 or 404 the
  evaluator can learn from, never a uuid cast error — citations are validated
  as uuids and the ledger treats a non-uuid id as absent; the evaluator agent's
  role cannot be changed (the read-only gate, the cadence and provisioning all
  key on it, so the role string `evaluator` is the principal's identity and
  must not be renamed); the review-items route and the cadence now count closed
  items, so a human closing an immediate item is visible as a number, while the
  exception itself stays on the card and in the ledger. Not taken: two unnamed
  agent subjects in one digest render alike (cosmetic; the note carries the
  detail).

## Recorded after the Milestone 2 and 3 merges (2026-09-06)

- **Rule 14 (bundling is visible) is not implemented in Milestone 2, and this
  is the record of it.** The changes-per-delivery-reference view and its
  outlier flag need delivery references that carry a change count, which no
  source on the shadow company records today; the GitHub adapter (D4) is the
  first source that could. Until then bundling is undetectable rather than
  approximated, and no metric pretends otherwise. Owner: the milestone that
  lands the GitHub adapter; a card shows nothing for rule 14 until then.
- **Rule 18's inheritance clause is not implemented.** Successor links and
  rework counting are; the clause that a recreated item inherits its
  predecessor's undecidable classes is not, so a cancel-and-recreate is judged
  on its own records. Consequence recorded: the recreated item can look fresh
  where the predecessor was undecidable; the successor link and the rework
  count still show the recreate, so the pattern is visible even though the
  classes are not carried. Owner: Milestone 5 review of the shadow cards, which
  decides whether the carry-over is worth the complexity.
- **Test gaps named by Theo's re-check (AGE-98), kept as backlog, none a
  blocker:** P7 cycle-time arithmetic and size buckets; O2's closed-on-time
  branch; the skew boundary at the metric layer (P3 failed and E2 exactly at
  the tolerance); the 500-exception and 5000-issue-id card caps at their
  boundary; P2's decided-approval positional fallback.
- **Milestone 3 wording, from Priya's re-check (AGE-101):** in a multi-finding
  digest, accepting one finding and disputing another means filing the
  correction first and closing the item after; the closing line's promise that
  nothing is re-raised holds either way, and the Milestone 4 screen replaces
  this flow. Digests written before the state manifest existed are rewritten
  once on the first sync after deployment (new wording and footer) and show a
  delta header from the update after that; the code refuses to invent a
  history it never recorded.

- **Milestone 3 technical review (Theo, AGE-99, READY) — dispositions.** Taken:
  provisioning finds-or-creates the evaluator agent and the review project under
  the company's review-items lock, so two calls or a call racing the first
  cadence sync cannot create duplicates (finding 1); the evaluator's note on a
  correction is its own event type, `evaluation.evaluator_note`, so no consumer
  can mistake it for a human decision (finding 7); the review-items route no
  longer accepts a version it ignored (finding 8); the gate has adversarial
  tests for encoded segments, double slashes, case, query strings and the
  evaluator key on the other header (finding 10); a digest's closing line tells
  the reader that the description is rewritten from the card and notes belong
  in comments (finding 4). Recorded, not changed: rotating the key with
  `rotateKey: true` invalidates the live key without a confirmation — that is
  the intended recovery path and the token is returned once (finding 2); every
  material E2, E12 and E13 is immediate, a deliberate compression of §9.2's
  "touching a release or credential" because no field carries that distinction
  (finding 3); a change of accountable owner opens a new digest for the new
  human while the old one stays as the old human's record (finding 5); the
  cadence excludes the review project by name because the project has no other
  durable mark, and scoring excludes it by label regardless (finding 6); the
  gate records the concrete normalised path rather than a route pattern because
  it runs before routing, when no pattern exists — ids in that path are the
  evaluator's own request targets, not another company's data (finding 9);
  cadence edge cases (fallback routing, lock collision catch-up, interval floor)
  remain untested (finding 11).
## Milestone 4 implementation notes (2026-09-06, dashboard branch)

- **Surfaces render what the server stored; nothing is recomputed in the
  browser.** The card's result shapes moved to `packages/shared`
  (`evaluation-card.ts`) so the UI types are the server's types. Three new
  read routes, open to company members: `GET …/evaluation/overview` (every
  project and goal with what its latest card says, the review-items project id,
  whether a principal is provisioned, the ledger's max sequence),
  `GET …/evaluation/scorecards/versions` (every stored version without bodies),
  `GET …/evaluation/events/:id` (one ledger event, the drill-down target).
- **Every number links to its formula and its events.** Each metric row opens to
  the §5 sentence for its key (`EVALUATION_METRIC_FORMULAS`), the implementation
  version that produced it, its breakdown with undecidable reasons, its notes,
  and the cited event ids; every id opens the event itself in a drawer.
  Composites show their guard reasons, included weights and coverages, and
  excluded metrics with reasons. A withheld score is the words for why, never a
  number.
- **No unnormalised ranking.** The operating tab lists agents by name with a
  statement that the scores are coverage-weighted means shown with confidence
  and are not a ranking; the overview orders milestones by card recency then
  name; the company row is separate. Trend is the outcome score per stored
  version as an inline line with gaps where a version was withheld.
- **Founder view** (`/evaluation/founder`) carries only decisions waiting
  (corrections with no `correction_decided` disposition), material risk (score,
  confidence, markers per milestone) and the immediate, material or
  founder-routed exceptions from the latest cards. No operating rows.
- **Administrator actions on the versions tab** — verify the latest card
  against a replay, replay now, store a new version — are the page's only
  writes and are gated server-side; the page merely offers them to
  administrators. Review items are the issues in the evaluator's project,
  listed through the ordinary issues API.
- **Recorded, not built:** intervention count and metered cost on the overview
  are sums of P1 and P8 details across the card's actors and read "not on this
  card" when the metrics are absent; goal health is the goal's status and O4 as
  the card shows them; there is no chart dependency (a small inline SVG draws
  the trend). A Playwright flow over a live server is the remaining acceptance
  step and is listed on the pull request.
- **Milestone 4 review round 2 (independent reviewer): dispositions.** P9 is an
  index (duplicates and rework per delivered item, lower is better), not a
  share, and renders as a value with its unit like O3; the dashboard's
  intervention count is shown over the population it was counted on (P1 has
  no undecidable path, so its coverage is one by construction and says
  nothing); a card that predates the scoring engine still offers an
  administrator the new version it needs; the contract fixture is regenerated
  only on an explicit flag, never recreated when missing. Recorded, on §7: a
  display-only metric (P5–P8) keeps its value at the insufficient tier in the
  stored card — the engine chose in Milestone 2 to keep the figure with the
  words "insufficient evidence" beside it because the number is a fact
  (metered cents, hours to recovery) rather than a score — and the drill-down
  now renders exactly that; §7's "no value at Insufficient" applies to scored
  metrics, whose value is null at that tier.
- **Milestone 4 review round 3: the value's kind is the engine's to say.** Three
  rounds found the browser inferring a metric's unit from its key or unit text,
  each time wrong for one metric (P9 an index, the company row's P2 a count
  under an agent key). `MetricResult` now carries `valueKind` — share, index,
  count, duration, currency or status — set where the metric is built, and the
  surfaces render on it and nothing else; the company row's metrics carry
  their own names ("Questions owed by the company", "Platform failures")
  instead of the agent names their keys would give. The card's bytes changed,
  so `METRICS_FORMULA_VERSION` is `metrics/3` and `FORMULA_VERSION`
  `m2-score/6`; the contract fixture was regenerated and its test now asserts
  the company row's rendering on the real card.
- **Milestone 4 wording pass (Priya, AGE-102) and the version rule, again.** The
  product review's list moved founder prose to metric names, plain words and
  routes in words, put acceptance requests on the founder view, and changed
  four stored-card strings (O4's unit is the goal's state, P8's unit, the
  concentration reason, the lag marker). Card bytes changed, so the pins moved
  with them: `FORMULA_VERSION` `m2-score/7`, `METRICS_FORMULA_VERSION`
  `metrics/4`, `COMPOSITE_FORMULA_VERSION` `composite/6`. The rule, restated
  because it has now been missed three times in one build: any change to what
  a stored card contains — a number, a string, a field — moves every version
  pin in the same commit, so `verify` reports "formula changed" rather than a
  false replay disagreement.
