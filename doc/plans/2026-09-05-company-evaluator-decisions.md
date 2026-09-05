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
  ledger-derived open flag.
