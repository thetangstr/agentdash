# AgentDash Harness — implementation plan

**Date:** 2026-08-02
**Architecture:** [ARCHITECTURE-harness.md](../ARCHITECTURE-harness.md)
**Workflow layer:** [2026-08-01-deliverable-pipeline.md](2026-08-01-deliverable-pipeline.md)
**Shipped:** Slice 1 (harness→agent control channel) — `d111cd36`, verified 4219/0.

## Dependency graph

```
        ┌─────────────────────────────────────────────┐
PHASE 0 │  A. Adapter coverage      B. Measurement    │  no dependencies
        └───────────────┬──────────────────┬──────────┘
                        │                  │
        ┌───────────────▼──────────────────▼──────────┐
PHASE 1 │  C. Agent↔agent facts    D. Teams delivery  │  C needs B's event schema
        │  F. OBO / Entra / SharePoint                │  C's offline path needs D
        └───────────────┬─────────────────────────────┘
                        │
        ┌───────────────▼─────────────────────────────┐
PHASE 2 │  G. Weekly pipeline      E. Inbound filter  │  G needs B, C, F
        └───────────────┬─────────────────────────────┘
                        │
        ┌───────────────▼─────────────────────────────┐
PHASE 3 │  H. Review agent — recommendations          │  needs ≥3 cycles of B
        └─────────────────────────────────────────────┘
```

**The one ordering that is not negotiable: B before G.** Cycle one cannot be measured
retroactively. If the weekly pipeline runs before instrumentation exists, the labour
curve — the only number that decides whether this is a business — is lost for those
cycles and cannot be reconstructed.

## Cross-cutting gates

Every slice must pass all six. These exist because each corresponds to a defect this
repository has actually shipped.

| # | Gate | Why it exists |
|---|---|---|
| **G1** | Every new exported service function has a **non-test caller**, provable by grep | `buildApprovalKeyboard` had 9 passing tests and no caller |
| **G2** | Every new package appears in **both** `vitest.config.ts` and `scripts/run-vitest-stable.mjs` | `packages/mcp-server` had 96 tests no runner executed |
| **G3** | Tests exercise the **real entry point**, not a fixture that bypasses it | HubSpot was broken for every real user while its tests hand-built connection rows |
| **G4** | Every security property has an **adversarial test that attempts the violation** | Properties asserted positively are not properties |
| **G5** | Full gate green: `pnpm -r typecheck && pnpm test:run && pnpm build`, real numbers reported | — |
| **G6** | Agent-facing change → all four prompt surfaces updated (CI drift check enforces) | — |

Standing: strict TDD proving RED first; Lore commit format; never commit
`pnpm-lock.yaml` [Superseded 2026-08-03: the lockfile is now tracked; CI owns it via the refresh-lockfile bot — see DEVELOPING.md]; migrations only via `pnpm db:generate`; default-profile behaviour
unchanged; profile-only routes 404 not 403; approvals service remains the only
decision boundary.

---

## PHASE 0

### A. Adapter directive coverage
**Closes the Slice 1 debt.** Seven of eight adapters are wired but unexercised;
`openclaw-gateway` has no `joinPromptSections` seam and rides a different path.

**Acceptance criteria**
- A1. Each of the 8 adapters has a test asserting directive text appears in the
  prompt that adapter actually emits.
- A2. `openclaw-gateway` either gains a seam, or its different path is tested
  directly and the reason documented.
- A3. A guard test fails if an adapter is added without directive coverage.

**Gate:** no adapter name appears in the wiring without appearing in the test file.

### B. Measurement substrate
The instrument the market does not have. Split deliberately from recommendations:
this half must exist before anything runs.

**Schema** — `workflow_events`:
`id, companyId, pipelineId, runId, stepKey, eventType, actorKind ('human'|'agent'|'system'), durationMs, payload (jsonb), occurredAt`

**The rule that makes this safe: events attach to the pipeline, never to a person
as subject.** `actorKind` records *what kind* of actor, never which one. There is no
user-subject column and no user index, so per-person aggregation is impossible by
construction — the same structural enforcement as Rule B, not a policy anyone must
remember.

**Acceptance criteria**
- B1. Every ask, answer, escalation, correction, and approval emits a typed event.
- B2. Query returns per run: **minutes of human review**, % steps completed with no
  human touch, correction count per fact, escalation stall duration.
- B3. **Adversarial (G4):** a test asserts the metrics API cannot return a
  per-person aggregate, and that no schema column identifies an individual as the
  measured subject.
- B4. Events are emitted from the real execution paths (G3), not a helper called
  only by tests.

**Gate:** B3 must fail if someone later adds a `userId` subject column.

---

## PHASE 1

### C. Agent-to-agent fact request
How the weekly report is assembled. Owner direction is **trigger, not automate** —
the request prompts whatever that person already does.

**Acceptance criteria**
- C1. Agent A requests a named fact from agent B; B answers, declines, or escalates.
- C2. Every answer carries provenance: who answered, source, when.
- C3. **Adversarial (G4):** an answer whose content originated outside AgentDash and
  is *not* framed as untrusted fails the test.
- C4. Escalation path: agent → its harness → if harness unreachable, Teams + stall
  under a lease. Lease expiry flags the fact `missing`; it is never silently dropped.
- C5. One ask per fact per run — deduplicated.
- C6. Emits B's events at every transition.

### D. Teams delivery
Promoted from parked to critical path: it is the notification channel for every
stalled escalation.

**Acceptance criteria**
- D1. `buildApprovalCard` and `resolveConversationReference` have real callers (G1).
- D2. `approval-card-delivery.ts` has a `teams` branch alongside telegram/whatsapp.
- D3. A stalled escalation delivers to Teams, proven at the route level (G3).
- D4. Decisions arrive through the opaque callback-token path — the button is never
  the authority.

**Gate:** a caller-existence test. This is the exact defect class that shipped here twice.

### F. OBO / Entra / SharePoint
**OBO is authentication; ceilings are authorization.** The agent authenticates as
the user, then ceilings narrow it. OBO must never widen — that would break Rule A.

**Acceptance criteria**
- F1. Agent obtains an on-behalf-of token for its principal via Entra.
- F2. **Two-user test (G4):** two users with different SharePoint access; the agent
  acting for each sees exactly what that user sees and no more. This proves we
  inherit SharePoint's permission model rather than reimplementing it.
- F3. Ceilings still narrow below OBO scope — `effective = owner ceiling ∩ steward
  request` is applied *after* OBO resolution.
- F4. Graph Excel reads handle both structured (named tables/ranges) and ad-hoc
  worksheets, with ad-hoc failing loudly rather than returning a wrong cell.

---

## PHASE 2

### G. Weekly pipeline — **shipped**
Slices A–F of the pipeline plan, with cross-agent collaboration replacing direct
connector fetch as the collection mechanism.

**Acceptance criteria**
- G1. A deliverable is defined with its fact list by an implementer — **no customer
  authors anything**. ✅ implementer-only routes; ordinary members and agent keys 403.
- G2. A run opens on schedule, collects, assembles, checks, and presents. ✅ four
  sequenced sweeps on one tick.
- G3. **The check runs on a different execution path from assembly** — self-
  certification impossible, not merely discouraged. ✅ four mechanisms: the
  assembler cannot author the criteria, there is no import edge in either
  direction and no reachable handle through the third module that bridges them,
  the check records a digest of exactly what it read, and the database refuses
  `checked` without the check's own artifacts.
- G4. Review surface shows draft + flagged items only. ✅ `attention` computed
  server-side, not left to a client filter.
- G5. **Two approvers, sequential** (Titus then CEO). Instrument who waited on whom
  and for how long — this is the only multi-human signal MKThink can produce.
  ✅ instrumented by SEAT (`approval.first` / `approval.second`, `approver_1` /
  `approver_2`, elapsed per stage). Never by person — B3 forbids it, and a
  per-employee response-time report is the documented task-mining backlash.
- G6. Corrections write to `fact_corrections`, attach to the **fact not the person**,
  and carry forward automatically. ✅ three kinds; `override_value` carries forward
  always flagged.
- G7. Nothing ships without both approvals. ✅ database check constraint, with an
  adversarial test that attempts the violation directly against the table.
- G8. Scored `pass^k` across runs, not `pass@k`. ✅ both returned, so they can be
  read next to each other.
- G9. Derivation record served over MCP, read-only, no enforcement claimed. ✅
  every served figure carries its age and last-confirmed-by.

**Never run:** no real weekly cycle has executed. Every figure the pipeline has
ever produced came from a mocked Microsoft Graph, and no approver has read the
review surface.

### E. Inbound filter policy — **shipped**
Extends the approvals gate from per-action to a standing filter on the return path.

**Acceptance criteria**
- E1. Sensitive updates, elevated risk, and missing context escalate rather than pass. ✅
- E2. **Adversarial (G4):** content crafted to look like an instruction to the
  harness is caught by the filter, not passed through framed-but-live. ✅
- E3. Fail-closed: unclassifiable content escalates. ✅
- E4. Framing preserved, not replaced. ✅
- E5. `content_filtered` `workflow_events` for both verdicts. ✅

Two chokepoints: `bridgeService.createTask` (content entering a person's machine —
a filtered `read` becomes approval-gated exactly like an `act`) and
`agentFactRequestService.answer` (a held answer, released or discarded by an
`inbound_content_review` approval). Not gated: the Teams stall notice on the
unreachable-harness branch of `escalate`, which reaches a human as a notice with
no decision surface.

---

## PHASE 3

### H. Review agent — recommendations — **shipped**
Planned for "only after ≥3 cycles of B's data exists". **No real cycle has ever run**,
so the machinery is built and exercised against synthetic histories written by B's real
emitters, and nothing it emits has been validated. See the boundary statement below.

**Acceptance criteria**
- H1. Recommendations are advisory and require human approval. ✅ raised through
  `approvalService` as a `workflow_recommendation` decided by the named pipeline
  owner; approving sets `accepted` and nothing else — no status means `applied`
  and no branch writes to a deliverable, fact, correction, or run. There is no
  create/accept/apply route.
- H2. **Recommendations name pipelines and steps, never individuals** — inherits
  B's structural constraint. ✅ four mechanisms: no free-text column at all (the
  sentence is rendered from a step key and integer counts), a closed observation
  allowlist admitting only numbers, a database blocklist on identifier-shaped
  keys, and a check constraint refusing any **seat-shaped subject**. The last is
  the interesting one — approval-seat latency is derivable and deliberately
  refused, because a deliverable names exactly one user per seat.
- H3. Reporting surface defaults to the pipeline owner, not up the org chart. ✅
  the deliverable's FIRST approver; the second (senior) seat sees nothing by
  default, and a pipeline with no resolvable owner raises nothing rather than
  escalating upward to find a reader.
- H4. Every recommendation cites the events supporting it. ✅ event ids **and** a
  reproducible query, with a check constraint refusing a recommendation that
  cites none.
- H5. Derived from real accumulated events through B's own query surface. ✅
  `metricsForPipeline` / `listMeasuredPipelines` on `workflowEventsService`; H
  opens no query of its own against `workflow_events`, so there is one place the
  person dimension could ever be added rather than two.

**Refused, on purpose:** approval-seat latency (identifies by construction), a
review-burden trend (no defensible threshold at three points; the metric is already
served per run by B), and "this step always needs a human" (tautological on a fact list
that declares its human facts). A plausible-looking recommendation with no evidential
basis is worse than an absent one.

**Never run:** no recommendation has ever been produced from real data. Every figure
that would feed one came from events written in tests, no timer has fired outside a
test, and no pipeline owner has read the surface. The quality of what this emits is
entirely unvalidated.

---

## Definition of done, per slice

1. RED output captured before implementation exists
2. All acceptance criteria met, each with a named test
3. All six cross-cutting gates pass
4. Full gate green with real numbers reported
5. Lore-format commit, `pnpm-lock.yaml` untouched [Superseded 2026-08-03: the lockfile is now tracked; CI owns it via the refresh-lockfile bot — see DEVELOPING.md]
6. What was **not** verified stated explicitly — the boundary between tested and
   merely wired

## Open questions — do not let these block Phase 0

- What exactly is the weekly artifact? (name, contents)
- Are the SharePoint worksheets structured or ad-hoc? Decides F4's difficulty and
  the fetch-vs-trigger ratio.
- Which HubSpot objects do the facts point at?

Phase 0 is independent of all three.
