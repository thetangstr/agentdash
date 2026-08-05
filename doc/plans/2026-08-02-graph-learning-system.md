# Graph Learning System (GLS) — plan

**Date:** 2026-08-02
**Builds on:** [ARCHITECTURE-harness.md](../ARCHITECTURE-harness.md) §6 Measurement, §6.1 Recommendation half
**Depends on shipped slices:** B (measurement substrate), C (agent↔agent facts), G (deliverable pipeline + derivation record), H (review agent — recommendations)
**Status:** Planned. Foundations shipped; the graph, cross-harness aggregation, and visualization are unbuilt forward work.

## 0. What this is, in one paragraph

The GLS is the **organization-level aggregation layer** that reads the events already
emitted by every deliverable run and every agent↔agent exchange, assembles them into an
evolving graph of *workflows* (not people), and feeds that graph to an org-wide reader —
the **Uber Agent** — which surfaces efficiency, ROI, and improvement recommendations to
the humans who own the work. It is a **generalization of the review agent (H)** from one
pipeline to the whole company, and it inherits H's iron rule: it observes and advises, it
never acts, and it measures workflows and seats, **never individuals**.

## 1. The line that defines the whole system

Before any node, edge, or metric: the graph's measured subjects are **pipelines, steps,
deliverables, facts, and seats — never a named person.** This is not a preference; it is
the same structural constraint as Slice B (ARCHITECTURE §6): `workflow_events` has no
user-subject column and no user index, so per-person aggregation is impossible by
construction, and an adversarial test (B3) fails if anyone adds one.

> ✅ *"This deliverable needed 40 minutes of review this week, down from 95."*
> ❌ *"Sarah took three days to answer."*

The GLS **must not open a new path to a person that the substrate closed.** The residual
limit is already documented (ARCHITECTURE §6.1): `pipeline_id` + `step_key` are correlation
keys, and a determined holder of authority over three tables can still join their way to a
person. The graph makes joining *easier by design* — that is its whole purpose — so it must
carry the constraint forward explicitly: **every GLS node and edge is keyed on workflow
identity, and the graph exposes no query that returns a per-person aggregate.** A GLS-level
adversarial test (the B3 analogue) must fail if a node is ever subjected to an individual.

## 2. What is already shipped (the foundations, in the move)

These exist on `codex/agentdash-mk` and travel in the bundle / on GitHub. The GLS consumes
them; it does not replace them.

| Foundation | Symbol | What the GLS reads from it |
|---|---|---|
| Measurement substrate (B) | `workflow_events`, `server/src/services/workflow-events.ts` | The event stream: ask / answer / escalation / correction / approval, with `actorKind`, `durationMs`, `occurredAt` |
| Per-pipeline metrics (B) | `metricsForPipeline`, `listMeasuredPipelines`, `server/src/routes/workflow-metrics.ts` | Minutes of human review, % steps with no human touch, correction count per fact, escalation stall duration |
| Agent↔agent facts (C) | `server/src/services/agent-fact-requests.ts` | The collaboration edges: who requested which fact from whom, with provenance |
| Deliverable derivation (G) | `deliverable-{runs,checks,review,record}.ts`, MCP `resources.ts` | The run graph: collect → assemble → check → present, and the served derivation record |
| Review agent (H) | `workflow_recommendations`, `server/src/services/workflow-recommendations.ts` | The advisory pattern: cite the rows, route to one human, never act |

**The one honest caveat, unchanged from H:** *no real weekly cycle has ever run.* Every
figure any of these can produce today came from events written in tests. The GLS machinery
can be built and proven, but the **quality** of what it emits cannot be validated until
real cycles accumulate. The plan below is built so nothing depends on pretending otherwise.

## 3. Dependency graph

```
        ┌──────────────────────────────────────────────────────────┐
SHIPPED │  B measurement   C facts   G pipeline   H recommendations │
        └───────────────┬──────────────────────────────────────────┘
                        │  (read-only consumers of the above)
        ┌───────────────▼──────────────┐
PHASE 1 │  GL-1 Graph model & ingest   │  workflow nodes/edges from existing events
        └───────────────┬──────────────┘
        ┌───────────────▼──────────────┐
PHASE 2 │  GL-2 Cross-harness roll-up  │  aggregate across pipelines & local harnesses
        │  GL-3 Uber Agent reader      │  H generalized org-wide; still advisory
        └───────────────┬──────────────┘
        ┌───────────────▼──────────────┐
PHASE 3 │  GL-4 ROI & efficiency view  │  workflow-level trend + cost, read-only
        │  GL-5 Node-based graph UI    │  stakeholder visualization + traceability
        └──────────────────────────────┘
```

**Non-negotiable ordering:** GL-1 before everything (there is no graph to read otherwise),
and the §1 boundary test lands **with GL-1**, not after — the constraint must be true from
the first node.

## 4. Phases and acceptance criteria

Every slice passes the six harness cross-cutting gates (harness plan §Cross-cutting gates:
non-test caller, runner registration, real entry point, adversarial security test, full
gate green, prompt-surface sync). GLS-specific criteria below.

### GL-1. Graph model & ingest
An evolving graph derived **only** from existing `workflow_events` and `agent_fact_requests`
— no new event source, no new person-linkable column.

- **GL-1.1** Node kinds: `deliverable`, `pipeline`, `step`, `fact`, `agent-role`, `seat`.
  No `person`/`user` node kind exists.
- **GL-1.2** Edge kinds: `pipeline→step`, `step→fact`, `fact→agent-role` (who produces it),
  `agent-role→agent-role` (C's fact requests), `run→step` (temporal). Edges carry
  `durationMs` / counts from B, never an identity.
- **GL-1.3** Ingest is incremental and idempotent: replaying an event window yields the same
  graph. Derived entirely by reading B/C — the graph is a **by-product**, never
  self-authored (ARCHITECTURE §7: "a knowledge base as a product… is the by-product of
  running deliverables or it is nothing").
- **GL-1.4 Adversarial (the B3 analogue):** a test asserts no node is keyed on an individual
  and no graph query returns a per-person aggregate. It must **fail** if a `person` node or
  `userId` edge attribute is ever added.

### GL-2. Cross-harness roll-up
Aggregate the graph across pipelines and across local harnesses into one company view.

- **GL-2.1** Roll-up is company-scoped and profile-gated (`agentdash_mk`), 404 for others.
- **GL-2.2** Aggregates over `agent-role`/`seat`, never over the human behind a seat.
- **GL-2.3** A harness that reported nothing appears as *silent*, not as *slow* — absence is
  never rendered as a person-negative signal.

### GL-3. Uber Agent reader
H generalized from one pipeline to the org. Same discipline: cite the rows, route to one
human, **never act** (no status meaning `applied`, no write to any deliverable/fact/run).

- **GL-3.1** Raises a suggestion only when a pattern holds ≥3 cycles (H's floor), citing
  event ids **and** a reproducible query.
- **GL-3.2** Routes to the **pipeline owner** (H's first-approver default), never up the org
  chart; an unresolvable owner raises nothing.
- **GL-3.3** Every recommendation passes through `approvalService`; acceptance records
  agreement only. There is no create/accept/apply route.
- **GL-3.4** Refuses the same three categories H refused (approval-seat latency, review-burden
  trend, "this step always needs a human") — and any org-level analogue that resolves to a
  person.

### GL-4. ROI & efficiency view
The number that decides whether this is a business — expressed as workflow economics.

- **GL-4.1** Per deliverable/pipeline over time: minutes of human review, % no-touch,
  correction counts, escalation stalls (all already served by B), plus a derived
  **cost-per-deliverable** trend. Never a per-person cost.
- **GL-4.2** Every figure carries its age and last-confirmed-by (G9 discipline).
- **GL-4.3** Served read-only over MCP resources; no enforcement claimed.

### GL-5. Node-based graph UI
The stakeholder (e.g. Titus) visualization. Read-only, traceable, boundary-safe.

- **GL-5.1** Renders the GL-1 graph with GL-4 metrics on nodes/edges; drill-down opens the
  derivation record, never a person.
- **GL-5.2** Default audience is the pipeline owner; org-wide view is available to
  owner/admin, and even there shows seats/roles, not individuals.
- **GL-5.3** Nothing in the UI can be edited into an action — approvals still flow through
  the approvals service, not the graph.

## 5. What the GLS deliberately does not do

- **Measure people.** §1. The reason adoption survives.
- **Act on its own findings.** Inherited from H — it advises; an implementer changes things
  while watching a real cycle.
- **Verify that any harness obeyed a suggestion.** Shared context over MCP is read-optional
  by protocol (ARCHITECTURE §7); the graph shows what happened, never enforces what should.
- **Invent a knowledge base as a product.** The graph is the by-product of runs or it is
  nothing.

## 6. Definition of done, per slice

1. RED captured before implementation.
2. All acceptance criteria met, each with a named test; GL-1.4 boundary test present from GL-1.
3. All six harness cross-cutting gates pass; full gate green with real numbers.
4. Lore-format commit; `pnpm-lock.yaml` untouched; migrations via `pnpm db:generate`. [Superseded 2026-08-03: the lockfile is now tracked; CI owns it via the refresh-lockfile bot — see DEVELOPING.md.]
5. The tested/merely-wired boundary stated explicitly — including that no real cycle has run.

## 7. Open questions — do not let these block GL-1

- What is the unit of **ROI** MKThink will actually present — cost-per-deliverable,
  hours-saved-per-cycle, or both side by side?
- Does "across all local harnesses" mean one company's harnesses only, or eventually
  cross-company benchmarking (which would reopen the privacy boundary at a new scale)?
- Is the graph persisted (a materialized table) or derived on read? GL-1.3 idempotency
  allows either; the choice is a performance/freshness trade, not a correctness one.

GL-1 is independent of all three.
