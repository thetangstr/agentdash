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

**Recommend A.** For the two shadow milestones the obvious candidates are the
completed "MVL 1.0 Launch" (scored retrospectively from existing records, so its
confidence will be capped by coverage) and the next project the founder names.
**Founder to name the second milestone.**

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
recommendation to the founder is to approve B before Milestone 5, because
"100 % of material claims trace to evidence" is hard to meet for delivery claims
on T2 alone.

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
| **A. A `evaluation_scorecards` table of versioned JSON projections plus a rendered document per version** | one additive table | queryable, replayable, diff-able between versions; the document is what humans read |
| B. Documents only | none | not queryable for trend or drill-down |
| C. Compute on every page load | none | slow, and the "replay agreement" criterion needs a stored artifact to compare against |

**Recommend A.**

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

---

## Plan by milestone (acceptance summarised; details live on the board)

| milestone | deliverable | acceptance |
|---|---|---|
| 0 Discovery and contract | this record + the spec on `main`; data-surface map on the board | independent review recorded; founder accepts §5 or names changes |
| 1 Ledger | `evaluation_events` migration, ingest for T0 sources and T2 payloads, backfill with unknown labels, `replay` command | integration test: fixture events → replayed card equals stored; adversarial dedupe/skew tests |
| 2 Scoring | deterministic projections for O1–O4, P1–P9, exceptions E1–E10, confidence/coverage | unit tests per formula; replay agreement 100 % on fixtures; no metric scores below its floor |
| 3 Evaluator agent | role `evaluator`, read-only principal, exception-only prompt, budget, cached digests, review items | permission tests: every forbidden write 403; one routine message per milestone enforced |
| 4 Surfaces | dashboard, drill-down, founder view, normalised comparison | e2e: every number links to formula and events; no unnormalised ranking |
| 5 Shadow and calibration | two milestones scored; disagreement log; cost report; recommendation | the mandate's graduation criteria, each measured and reported |

## Implementation sketch (for review; nothing is built yet)

Additive, company-scoped, following the repo's service/route/schema patterns:

- `packages/db/src/schema/evaluation_events.ts` — insert-only ledger (id,
  companyId, projectId?, goalId?, actorType/actorId, sourceTable/sourceId,
  eventType, schemaVersion, eventTime, ingestTime, dedupeKey unique, payload
  jsonb, correlationId?). `packages/db/src/schema/evaluation_scorecards.ts` —
  versioned projections (companyId, milestoneRef, version, contractVersion,
  formulaVersion, throughEventId, card jsonb, createdAt). One migration (0127),
  forward-only, no existing table touched. Exported from `schema/index.ts`.
- `server/src/services/evaluation/ingest.ts` — idempotent readers for T0 tables
  and the MAW payload parser (T2); runs on the periodic loop off the request
  path with its own interval and row budget. `replay.ts` — pure projection from
  ordered events; `scoring.ts` — O1–O4, P1–P9 with floors; `exceptions.ts` —
  E1–E10; `independence.ts` — the §4.2 rule shared with the verdict service's
  guard.
- `server/src/routes/evaluation.ts` — read routes for cards, drill-down and
  events; one write route for corrections (`evaluation.correction` events);
  every handler asserts company access; the evaluator principal's grants are
  checked at the route.
- `packages/shared/src/constants.ts` — event types, exception ids, tiers;
  `packages/shared/src/schemas` — the contract v1 and scorecard schemas.
- `ui/src/pages/evaluation/*` — dashboard, drill-down, founder view
  (Milestone 4).
- Agent: role `evaluator`, `reportsTo` null, accountable human = founder,
  Hermes profile as the other agents (D5), prompt limited to exception review,
  budget on the card.

## Baseline recorded at Milestone 0 (read-only, 2026-09-05)

Company Agent Runner: 80 issues (32 done, 10 cancelled, 15 backlog, 7 blocked,
8 in review, 8 todo); definition of done set on 0; verdicts 0; approvals 0;
142 runs (113 succeeded, 28 cancelled, 1 failed) with usage on 13; 2 cost events;
2 goals, both without metric definitions; 5 `ask_user_questions` interactions
pending unanswered; CoS Reviewer assigned as reviewer, never run. These numbers
are the coverage floor the shadow run starts from, and the reason §7 of the spec
refuses to show a score where evidence does not exist.
