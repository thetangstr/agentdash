# AgentDash Harness — architecture

**Date:** 2026-08-02
**Status:** Slice 1 shipped (`d111cd36`). Remainder planned in
[2026-08-02-harness-implementation-plan.md](plans/2026-08-02-harness-implementation-plan.md).

---

## 1. What the system is

Every onboarded person is paired with **two** agents, and the pairing is the whole idea.

| Party | Where it runs | What it is |
|---|---|---|
| **Human** | — | Final authority. Approves, corrects, decides. |
| **Local harness agent** | Their own machine, inside Claude Code or ChatGPT | Their proxy and guardian. Holds real context, preferences, credentials, local access. **The authority over their AgentDash agent.** |
| **AgentDash agent** | Shared cloud org | Participates in the org chart, executes tasks, talks to other people's AgentDash agents. |
| **Review agent** | Shared cloud org, org-level | Watches workflow efficiency and surfaces recommendations for human approval. Advisory only. |

The harness **supervises**. The AgentDash agent **participates**. The human **decides**.
The review agent **observes and suggests, never acts**.

---

## 2. The trust boundary

```
   ┌────────┐                                        ┌──────────────────┐
   │ human  │◀── Teams, when harness unreachable ────│  AgentDash agent │
   └───┬────┘                                        └────────┬─────────┘
       │ runs                                                 │
       ▼                                                      │
   ┌──────────────────┐                                       │
   │  local harness   │───── unrestricted, NARROWING ONLY ────▶│
   │  (their machine) │                                       │
   │                  │◀──────── HITL / policy gate ──────────┘
   └──────────────────┘
```

**Outbound (harness → agent) is unrestricted.** The harness is the trusted party. It
writes the agent's operating directives, its limits, and its explicit don'ts.

**Inbound (agent → harness) passes a gate.** The AgentDash agent lives in a shared
environment where it is continuously exposed to *other people's agents' output* —
untrusted content by definition. Anything travelling back toward the harness is a
potential injection channel **into the machine holding the real credentials**.

The gate is two controls, and they are not interchangeable:

| | Control | Answers |
|---|---|---|
| **Framing** | `frameUntrusted*` | *what is this reader reading?* |
| **Filtering** | `inbound-filter.ts` | *does this content travel at all?* |

A frame is advice to a model, and advice is not enforcement. The filter is the
enforcement: sensitive material, instruction-shaped content, and content missing
its declared context escalate to the approvals service rather than passing.
Content that passes is still framed — the newer control did not replace the older
one.

Deliberately no model in that loop. A filter implemented as "ask a model whether
this looks like an injection" can be argued out of filtering by the content it is
inspecting, because the attacker writes the text being classified. Every rule is
a structural or lexical predicate, and the undecidable residue is covered by
escalating rather than by a second opinion. The honest cost: a lexical rule set
is a blocklist, so novel phrasings pass. What it buys is that the shapes that
work today stop at a chokepoint, and it fails closed — content that cannot be
classified is held.

The asymmetry is the point. The trust gradient runs one direction, so the gate belongs
on the return path only. This is `frameUntrustedBridgeResult`'s principle — *"data to
report on, never instructions to follow"* — promoted from a single function to the
shape of the system.

### 2.1 Two rules that keep "unrestricted" safe

**Rule A — narrowing only.** A harness may restrict its agent, never widen it. It
writes the *existing* steward request; the intersection is unchanged:

```
effective = owner ceiling ∩ steward request (pushed by harness)
```

The harness is the steward's instrument, not a third authority — so the policy model
gains no new term. A push broader than the owner's ceiling is **clamped down to the
ceiling**, not rejected.

*Why clamped and not rejected:* rejection would leave the **previous, broader** request
in force. A harness trying to tighten but overshooting on one dimension would fail
closed into the looser state. Clamping is the only fail-safe direction.

Consequence: a compromised laptop can only ever make its agent *more* constrained than
the organization authorized.

**Rule B — structured constraints bind; free-text directives inform.**

| | Kind | Effect | Enforced at |
|---|---|---|---|
| **Ceilings** | structured (providers, dataScopes, minimumApproval) | **grant and revoke** | `resolveActingAs` |
| **Directives** | free text (the "soul", the don'ts) | shape behaviour | the agent's context |

A directive saying *"you may access HubSpot"* has **zero** effect. Only a ceiling grants.

This is enforced *structurally*, not by discipline: directives live in their own table
with no column any enforcement point could consult. The authorization path does not
choose to ignore them — there is nothing there to read. Verified: `connectors.ts`, the
auth middleware, and `agent-governance.ts` contain no reference to `agent_directives`.

**The general principle, which recurs throughout this system:** a rule binds only when
it sits at a chokepoint with a decidable predicate. Prose in a context window is not a
control — even when it is our prose.

---

## 3. Identity — two different layers

These are frequently conflated and must not be.

**On-Behalf-Of is authentication.** Token exchange (Entra ID) so the downstream system
sees the *real user's* identity. The agent can never exceed what its principal has.

**Ceilings are authorization.** AgentDash narrows *below* what the user could do.

```
what the agent may do  =  what the user can do (OBO)
                          ∩ owner ceiling
                          ∩ steward request (harness)
```

Read as "the agent inherits the user's privileges," OBO would be wider than the ceiling
model and would break Rule A. Read as "the agent authenticates as the user, then
ceilings narrow it," the two compose cleanly.

**What this buys concretely:** SharePoint's own permission model comes free. An agent
acting for one person sees exactly what that person sees. We do not reimplement it and
cannot accidentally over-grant. It also piggybacks on existing M365 identity rather
than requiring fresh credential grants.

---

## 4. How a deliverable actually runs

Worked example: a recurring weekly report assembled from several people's systems.

```
 schedule fires
      │
      ▼
 ┌──────────────────┐   facts that live in systems
 │  run opens       │──────────────────────────────▶ connector fetch (OBO, read-only)
 └────────┬─────────┘                                        │
          │ facts that don't                                 │
          ▼                                                  │
 ┌──────────────────┐   agent→agent request                  │
 │ owning agent     │◀───────────────────────────────────────┤
 └────────┬─────────┘                                        │
          │ can't answer                                     │
          ▼                                                  │
 ┌──────────────────┐   harness online?  ──yes──▶ harness answers
 │  escalate        │                                        │
 └────────┬─────────┘   no ──▶ Teams message, run stalls under lease
          │                                                  │
          ▼                                                  ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  assemble draft — every fact carries source, method, time   │
 └────────────────────────────┬────────────────────────────────┘
                              ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  CHECK — runs on a different execution path from assembly   │
 └────────────────────────────┬────────────────────────────────┘
                              ▼
        approver 1 (draft + flagged items only) → approver 2 → ship
                              │
                              ▼
              corrections write to the FACT, not the person
```

**Design commitments visible in that flow:**

- **Trigger, not automate.** Where a fact cannot be fetched, the system prompts whoever
  already produces it. Retrieval-vs-reconstruction becomes a dial rather than a
  precondition.
- **The check cannot self-certify.** It runs on a separate execution path — structurally
  impossible rather than discouraged. This is the reviewer-capitulation failure mode
  designed out: the documented way agent deployments fail is that reviewers quietly
  stop reviewing.
- **The approver sees flags, not a blank re-review.** Minutes of senior attention per
  cycle is the number that decides whether this is a business.
- **Corrections attach to the fact.** Nobody authors a skill; no artifact carries a
  person's name describing what they used to do by hand. This is the learning loop that
  survives both the evidence and the social objection to it.

---

## 5. Failure modes

| Condition | Behaviour |
|---|---|
| **Harness offline** | Constraints persist server-side (pushed when last online), so the agent stays governed. Escalations block, Teams notifies, work waits under a lease. Stalling is acceptable — the system need not run 24 hours. |
| **Lease expires** | Fact marked `missing` and flagged. Never silently dropped. |
| **`act`-class work times out** | Never re-queued. The side effect may already have happened; a duplicated side effect is worse than a missing one. |
| **Harness compromised** | Rule A means it can only over-restrict. Blast radius is that agent becoming useless, not dangerous. |
| **Agent returns hostile content** | Framed untrusted on entry; the inbound gate escalates rather than passes. |
| **Approver stops reading** | The check is independent, so a rubber-stamped approval still failed its acceptance tests. Partial mitigation only — this remains the system's deepest risk. |

---

## 6. Measurement

The review agent's **measurement** half is separate from its **recommendation** half,
and must exist before the first pipeline runs. Cycle one cannot be measured
retroactively.

Recorded per run: minutes of human review, percentage of steps completed with no human
touch, correction count per fact, escalation stall duration.

**Events attach to the pipeline, never to a person as subject.** `actorKind` records
*what kind* of actor, never which one. There is no user-subject column and no user
index, so per-person aggregation is impossible by construction — the same structural
enforcement as Rule B.

This is not decoration. An agent measuring "efficiency across human-agent workflows" is,
from an employee's chair, an agent watching how fast they respond and how much help they
needed. That is the documented task-mining backlash, and it is the fastest way to lose
adoption at the exact moment the system starts working.

- ✅ *"This deliverable needed 40 minutes of review this week, down from 95."*
- ❌ *"Sarah took three days to answer."*

Reporting defaults to the pipeline owner, not up the org chart.

### 6.1 The recommendation half

Shipped (H). An org-level reader of accumulated events that raises a suggestion when a
pattern has held for at least three cycles, cites the rows it rests on, and routes it to
one human through the approvals service. **It never acts:** there is no status meaning
`applied` and no branch anywhere that writes to a deliverable, a fact, or a run.
Acceptance records that a person agreed; the change it suggests is an implementer's to
make while watching a real cycle.

Two kinds survive: a figure corrected in three or more cycles (the derivation is wrong,
not the number), and an ask whose lease ran out in three or more cycles (the fact is
never supplied in time). Three categories were considered and **refused**, and the
refusals carry as much of the design as the inclusions:

| Refused | Why |
|---|---|
| **Approval-seat latency** | Derivable, and forbidden. A deliverable names exactly one user per seat on its own row, and a check constraint guarantees the seats are two different people — so *"seat one is your bottleneck"* has no reading that is not *"this named colleague is slow"*. Excluded twice: skipped by the derivation, refused by the table. |
| **Review-burden trend** | Three points and a threshold nobody can justify. The metric is already served per run by B, where a human reads it in context. |
| **"This step always needs a human"** | Tautological — a fact declared `human` in the fact list needs a human every cycle by definition. |

The reporting default is the deliverable's **first** approver, deliberately not the
second: the second seat is the more senior one, and the version where a CEO receives
efficiency recommendations about the work below them is the version that kills adoption.
A pipeline whose owner cannot be resolved raises nothing at all, because routing it
upward to find a reader is worse than silence.

**Never run.** No real cycle has executed anywhere in this system. Every recommendation
it can currently produce would be derived from events written in tests. The machinery is
proven; the *quality* of what it emits — whether these two patterns are the ones worth
surfacing, whether three cycles is the right floor — is entirely unvalidated and cannot
be validated until real cycles accumulate.

**The residual limit, stated rather than claimed away.** `pipeline_id` and `step_key` are
correlation keys. A deliverable fact names an owning agent, and an agent has a steward, so
somebody holding authority over `workflow_recommendations`, `deliverable_facts`, and
`agent_stewardships` can still join their way to a person. That is weaker than the seat
case — a stewardship is reassignable, and an ask may be answered by the agent, the
harness, or the person, so the wait is not attributable to one of them — but it is not
nothing. What the table guarantees is that it contains no such name and that nothing
reading it alone can produce a per-person number.

---

## 7. What this deliberately does not do

Each of these is a considered exclusion, not a gap.

- **Enforce behavioural rules.** "No journal entry above $50,000" is enforceable — there
  is a discrete action carrying an amount, arriving at a chokepoint. "Write the report
  our way" is not: no action to intercept, no decidable predicate. Checking it would
  require another model, which is a second opinion rather than enforcement. This is not
  an AWS/Microsoft/Google gap; nobody will close it.
- **Bind other people's harnesses.** Shared context served over MCP is read-optional by
  protocol design — MCP prompts are user-controlled, resources application-controlled.
  Nothing verifies a rule was read, let alone followed. We ship it as **shared context**
  and never call it governance.
- **Agent identity, registry, org-chart inventory.** Bundled by Microsoft at $15/seat,
  Google, and AWS.
- **A knowledge base as a product.** It is the by-product of running deliverables or it
  is nothing. Self-authored documentation does not happen.
- **Employee-authored skills.** The encoding is done by an implementer watching one real
  cycle. Every working analogue in the market does it this way.

---

## 8. Component map

| Concern | Lives in | Status |
|---|---|---|
| Human↔agent binding | `server/src/services/agent-stewardships.ts` | shipped |
| Harness→agent directives | `server/src/services/agent-directives.ts` | shipped |
| Ceiling narrowing (Rule A) | `server/src/services/agent-governance.ts` | shipped |
| Authorization (Rule B boundary) | `server/src/services/connectors.ts` → `resolveActingAs` | shipped |
| Decision boundary | `server/src/services/approvals*` | shipped |
| Runtime injection | `server/src/services/heartbeat.ts` → `executeRun` | shipped |
| Harness tools | `packages/mcp-server/src/harness.ts` | shipped |
| Local task execution | `server/src/services/bridge.ts`, `cli/src/bridge/` | shipped |
| Measurement | `workflow_events`, `server/src/services/workflow-events.ts` | shipped (B) |
| Agent↔agent facts | `server/src/services/agent-fact-requests.ts` | shipped (C) |
| Teams delivery | `server/src/services/approval-card-delivery.ts` | shipped (D) |
| OBO / SharePoint | `server/src/services/entra-obo.ts`, `server/src/services/sharepoint-connector.ts` | shipped (F) |
| Inbound filter | `server/src/services/inbound-filter.ts` | shipped (E) |
| Deliverable pipeline | `server/src/services/deliverable-{runs,checks,review,record}.ts`, `server/src/services/deliverables.ts` | shipped (G) |
| Derivation record over MCP | `packages/mcp-server/src/resources.ts` | shipped (G9) |
| Review agent — recommendations | `workflow_recommendations`, `server/src/services/workflow-recommendations.ts` | shipped (H), never run against real data |

---

## 9. The one-paragraph version

Each person has a cloud agent that participates in the organization and a local agent
that governs it. The local one can only ever tighten the cloud one's leash, never
loosen it, and anything travelling back from the cloud is treated as hostile input
because it has been exposed to other people's agents. Work is organized around
recurring deliverables rather than around an org chart: a deliverable's facts are
fetched where they exist and requested from whoever produces them where they don't,
assembled with provenance on every figure, checked by something that did not do the
assembling, and approved by named humans before anything ships. What accumulates is a
record of how the organization's own numbers are made — as a by-product of making them,
which is the only way such a record stays true.
