# Deliverable pipeline — dev plan

**Date:** 2026-08-01
**Status:** planned, not started. Two facts gate the *choice of deliverable* (§7);
they do not gate the *shape*, which is what this plan builds.

## What this is

One recurring deliverable, produced end to end: facts fetched from source systems
under read-only credentials, gaps asked of humans once and specifically, a draft
assembled, checked independently, reviewed by one named approver, and shipped —
leaving behind a machine-readable record of how each figure was derived.

That record is then served over the MCP endpoint we already ship, so any harness
in the firm can ask where a number comes from and get the answer that was actually
used.

**Customer-facing description of the same thing:**
https://claude.ai/code/artifact/7af2d0e4-8b97-4a02-b0ab-e739af43162a

## Why this shape

Three findings constrain it, and every design decision below traces to one of them.

1. **Self-service process capture does not work.** No evidence anywhere; every
   working analogue (Prialto's Engagement Managers) has a third party doing the
   encoding. → *Nobody at the customer authors anything. The fact list is produced
   by an implementer watching one real cycle.*
2. **Verification is the cost bound, and the failure mode is reviewer
   capitulation** — not agent error. Review slots collapse from hours to minutes
   and stop catching things. → *The check runs independently of assembly, and the
   approver sees flags rather than a blank re-review.*
3. **Context that is authored goes stale; context that is exhaust stays current.**
   The compounding-as-moat claim died on evidence, but freshness-as-byproduct did
   not. → *The derivation record is written by producing the deliverable, never by
   hand.*

## What is size-invariant (and therefore safe to build now)

MKThink is a design partner ~100× smaller than the target market, so it can only
validate part of this. Build the part it can validate; instrument the part it
cannot.

| Validated at MKThink | NOT validated at MKThink |
|---|---|
| Read-only credentialed connectors | Multi-human routing / delegation chains |
| Deterministic assembly | Whose approval binds whose action |
| Derivation record + provenance | Agent registry, org structure |
| One named approver per artifact | Buyer, price, channel |
| MCP endpoint serving current truth | Whether coordination is worth paying for |

**Step 3 (the human ask) is the only multi-human component.** At MKThink it will
involve ~2 people and look trivially easy. Instrument it heavily anyway — it is
the one part whose behaviour at 2,000 people we will be extrapolating rather than
observing.

## Schema

New tables. Generate migrations with `pnpm db:generate`; never hand-author.
All company-scoped. Export from `packages/db/src/schema/index.ts`.

**`deliverables`** — the definition.
`id, companyId, key, name, cadence, approverUserId, status, createdAt, updatedAt`

**`deliverable_facts`** — the fact list. This *is* the encoding artifact.
`id, deliverableId, key, label, sourceType ('system'|'human'), connectorId (null for human),
derivation (text — how it is computed, in prose), ownerUserId (who to ask, when human),
orderIndex`

**`deliverable_runs`** — one cycle.
`id, deliverableId, companyId, status ('collecting'|'assembled'|'checked'|'awaiting_approval'|'approved'|'shipped'|'abandoned'),
openedAt, assembledAt, approvedAt, approvalId, shippedAt`

**`fact_values`** — one fact's value in one run.
`id, runId, factId, value (jsonb), status ('fetched'|'asked'|'answered'|'missing'),
sourceRef (text — the exact call made), method (text), fetchedAt,
flagged (bool), flagReason, answeredByUserId, answeredAt`

**`fact_corrections`** — durable, carried forward across runs. **This is the
learning loop**, and it attaches to the *fact*, never to a person.
`id, companyId, factId, correction (jsonb), reason (text), originRunId,
createdByUserId, createdAt, retiredAt`

**`deliverable_checks`** — acceptance tests.
`id, deliverableId, kind ('moved_more_than'|'missing'|'matches_prior'|'range'|'custom'),
config (jsonb), severity`

Indexes: `(companyId)` on every table; `(deliverableId, orderIndex)` on facts;
`(runId, factId)` unique on values; `(factId) WHERE retired_at IS NULL` on corrections.

## Slices

Each is TDD (prove RED first), Lore commit format, full gate before done
(`pnpm -r typecheck && pnpm test:run && pnpm build`). Never commit `pnpm-lock.yaml`.
Default-profile behaviour unchanged; profile-only routes 404 off-profile.

### A — Definition and fact list
Schema, migration, service, routes. The implementer's surface. No execution yet.
- Create a deliverable, add facts, mark each `system` (with connector) or `human`
  (with owner).
- **Test the real entry point.** This codebase has a documented history of tests
  covering the service that *would* be called rather than the route that reaches it.

### B — The run: fetch system facts
- Open a run; for each `system` fact, fetch via its connector.
- **Read-only is enforced at the credential, not in a prompt.** Practitioners have
  reported models applying changes under explicit read-only *instruction*.
  Instructions are not controls. The connector must be incapable of writing.
- Record `sourceRef`, `method`, `fetchedAt` for every value. A value with no
  provenance is a bug, not a degraded case.
- Apply active `fact_corrections` on the way in.

### C — The human ask
- `human` facts generate one specific ask, routed to `ownerUserId`.
- Ask goes to that person's CoS first; only what it cannot answer surfaces to the
  human. Reuse the existing Inbox and channel-binding machinery.
- One ask per fact per run — deduplicated. Never "send me your numbers."
- Timeout → the fact lands `missing` and is flagged, not silently dropped.

### D — Independent check
- Runs the `deliverable_checks` against the assembled draft.
- **Structurally separate from assembly.** Not a prompt instruction telling an
  agent to check its own work — a different execution path, so self-certification
  is impossible rather than discouraged.
- Seed 20–50 checks drawn from real failures in the observed cycle.
- Score `pass^k` across runs, not `pass@k`: 75% per-run over three cycles is 42%.

### E — Review and approval
- The surface from the artifact: draft plus flagged items only.
- Goes through the **existing approvals service** — it remains the single decision
  boundary. Do not write approval rows directly.
- Corrections write to `fact_corrections`, carried forward automatically.
- Nothing ships without the named approver.

### F — MCP resources
- Expose the derivation record on `packages/mcp-server`:
  `agentdash://facts/{key}` — current definition, source, derivation, corrections, last confirmed
  `agentdash://deliverables/{key}/latest` — last approved run with provenance
- **Read-only, opt-in, no enforcement claimed.** It is shared context, not policy.
  Nothing checks that anyone read it, and we must not imply otherwise.
- Every served fact carries its age and last-confirmed-by. A human at the end
  catches errors, not wrong foundations — a stale premise passes review silently.

## Not building

Explicitly out, and each for a reason already established:

- **Enforcement of behavioural rules.** Not possible — no chokepoint, no decidable
  predicate. Not an AWS/Microsoft/Google gap either; nobody will close it.
- **Agent identity / registry / org chart.** Bundled by Microsoft at $15/seat,
  Google, AWS.
- **A knowledge base as a product.** It is the by-product of §F or it is nothing.
- **Skill authoring by employees.** The whole point of the implementer role.
- **Per-seat packaging for this surface.** If the unit is a deliverable, price the
  deliverable.

## Gating facts — still unanswered

Neither blocks the slices above; both decide *which deliverable goes first*.

1. **MKThink's stack and cadence.** One 45-minute call. If they are on Deltek
   Vantagepoint or Unanet, Dela and Champ ship into this job at $0 marginal cost.
   If the board meets quarterly, the packet fails on frequency and the first
   pipeline should be a monthly artifact instead (WIP review, project financials,
   pipeline review). Every adversarial critique named this as load-bearing. It has
   still not been asked.
2. **Retrieval or reconstruction?** Observe one real cycle. If the five people are
   *fetching* things that exist in five accounts, read access replaces them. If
   they are reconstructing figures that exist nowhere, read access returns nothing
   and the deliverable is not agentable. This decides whether there is a product.

## Honest risk

Sizing from MKThink's own description: 5 people × ~5 hrs/month × ~$85/hr ≈ **$25k/yr
of total pain**, against 2–4 weeks of senior encoding at **$28–32k**. Year-one cost
may exceed annual pain by 2–10×, and the pain is diffuse — five people's slack time
is nobody's line item. The architecture being coherent does not make the arithmetic
work. Gating fact 2 is what actually measures this.
