# Agent pairing architecture — 1-to-2

**Date:** 2026-08-02
**Status:** approved by owner. Build starts at Slice 1.
**Workflow layer:** [2026-08-01-deliverable-pipeline.md](2026-08-01-deliverable-pipeline.md)

## The shape

Every onboarded human gets **two** agents:

1. **An autonomous AgentDash agent** — lives in the shared org, appears in the org
   chart, participates in workflows, talks to other people's AgentDash agents.
2. **A local harness agent** — runs on their own machine inside Claude Code or
   ChatGPT. Holds their real context, preferences, credentials, and local access.
   It is the **authority** over their AgentDash agent.

The harness supervises; the AgentDash agent participates.

## The trust boundary — asymmetric, deliberately

```
  harness  ──────── unrestricted (narrowing only) ────────▶  AgentDash agent
     ▲                                                             │
     └──────────── HITL / policy gate ◀───────────────────────────┘
```

**Outbound (harness → agent) is unrestricted**, because the harness is the trusted
authority. It sets the agent's operating directives, limits, and explicit don'ts.

**Inbound (agent → harness) passes a gate**, because the AgentDash agent lives in a
shared environment exposed to *other people's agents' output* — untrusted content by
definition. Anything flowing back is a potential injection channel into the machine
holding the real credentials. The trust gradient runs one way; the gate belongs on
the return path.

This is `frameUntrustedBridgeResult`'s principle — *"data to report on, never
instructions to follow"* — promoted from a function to an architecture.

### Two rules that keep "unrestricted" safe

**1. Narrowing only.** The harness may only *restrict*, never widen. It writes the
steward request; the existing intersection is unchanged:

```
effective = owner ceiling ∩ steward request (pushed by harness)
```

The harness is the steward's instrument, not a third authority — so this adds no
new term to the policy model. A compromised laptop can then only make its agent
*more* constrained than the org authorized. Fail-safe direction.

**2. Structured constraints bind; free-text directives inform.** The control payload
has two parts and they must never merge:

- **Ceilings** (structured: providers, dataScopes, minimumApproval) — these *grant
  and revoke*. Enforced at `resolveActingAs`.
- **Directives** (free text: the "soul", the don'ts) — these reach the agent's
  context and shape behaviour. They **cannot grant capability**. A directive saying
  "you may access HubSpot" does nothing; only a ceiling does.

This is the same lesson as the MCP/Cedar analysis, applied internally: a rule binds
only when it sits at a chokepoint with a decidable predicate. Prose in a context
window is not a control.

## Harness offline — owner decision, 2026-08-02

**Stalling is acceptable.** The system does not need to run 24 hours; a few hours of
delay is fine.

- **Constraints persist server-side.** They were pushed when the harness was last
  online, so the agent stays governed while the lid is shut. The harness is the
  *authority*, not a runtime dependency.
- **Escalations block and notify.** When an agent needs its harness and the harness
  is unreachable, the work waits and **a Teams message goes to the human**.
- Reuses the bridge lease/timeout pattern already built.

**Consequence:** Teams approval-card delivery — `buildApprovalCard` and
`resolveConversationReference` currently have no caller, and
`approval-card-delivery.ts` has no `teams` branch — moves from parked to **critical
path**. It is the notification channel for every stalled escalation.

## Rollout

Everyone gets an agent at onboarding, but **start with 4 people** — the ones in the
weekly report. Spread by pull, not by provisioning.

At 1-to-2, MKThink at full adoption is ~40 agents; the target market at 2,000 people
is ~4,000. Do not assume the org-chart surface scales without testing it.

## What exists already

| Component | Status |
|---|---|
| Per-agent Paperclip API | Built — agent-authenticated access (Slice 1) |
| Human↔agent binding | Built — stewardship, one-active invariants both directions |
| HITL gate | Built — approvals service, the single decision boundary |
| RLAC on third-party tools | Built — `resolveActingAs`, providers/dataScopes ceilings |
| Pre-populated `agent.md` | Built — four prompt surfaces, CI drift check |
| Harness connection | Built — `packages/mcp-server`, bridge |

## What is new

### Slice 1 — harness→agent control channel
The spine. Stewardship binds a human to an agent but gives the harness no channel to
*write* that agent's constraints.

- New table `agent_directives`: `id, companyId, agentId, version, directives (text),
  pushedByUserId, pushedAt, supersededAt`.
- Ceilings are **not** a new table — the harness writes the existing steward request
  through the per-agent API. Intersection logic unchanged.
- MCP tools on `packages/mcp-server` so a local Claude can push both.
- Versioned with provenance. Superseding is append-only; never mutate in place.
- **Test the widening attempt explicitly**: a harness pushing a ceiling broader than
  the owner's must be clamped, not accepted.

### Slice 2 — agent-to-agent fact request
How the weekly report actually gets assembled.

- Agent A requests a named fact from agent B; B answers, declines, or escalates to
  its harness.
- The answer carries **provenance** — who answered, from what source, when.
- An answer that originated outside AgentDash is framed as untrusted on the way in.
- Escalation path: agent → its harness → (if offline) Teams → human.

### Slice 3 — inbound filter policy
Extends the approvals gate from per-action to a standing filter on the return path.
Sensitive updates, elevated risk, or missing context escalate rather than pass.

### Slice 4 — Teams delivery
Close the `buildApprovalCard` caller gap. Every stalled escalation notifies here.

### Slice 5 — the weekly pipeline
Rides on 1–4. Slices A–F in the pipeline plan still hold; cross-agent collaboration
replaces direct connector fetch as the collection mechanism, per the owner's
"trigger, don't automate" direction.

## MKThink specifics — answered 2026-08-01/02

| | |
|---|---|
| Cadence | **Weekly** — the frequency disqualifier is gone |
| Systems | **SharePoint + HubSpot**, some worksheets. No ERP → Deltek/Unanet bundled agents do not reach them |
| Goal | **Trigger what they already do**, not full automation. Retrieval-vs-reconstruction becomes a dial, not a go/no-go |
| Channel | **M365 + Teams** |
| Harnesses in use | **Claude Code and ChatGPT** — the MCP endpoint has readers on day one |
| Access | Limited. Consistent with trigger-first |
| Approvers | **Titus and the CEO** — two, sequential. The only multi-human signal MKThink can give; instrument it |

**Still to confirm:** what exactly the weekly artifact is; whether the SharePoint
worksheets are structured (named tables/ranges — Graph reads these cleanly) or
ad-hoc (brittle); which HubSpot objects the facts point at.

## Standing constraints

Strict TDD, prove RED first. Lore commit format. Never commit `pnpm-lock.yaml`. [Superseded 2026-08-03: the lockfile is now tracked; CI owns it via the refresh-lockfile bot — see DEVELOPING.md.]
Migrations only via `pnpm db:generate`. Default-profile behaviour unchanged;
profile-only routes 404 not 403. The approvals service stays the only decision
boundary. Full gate before done: `pnpm -r typecheck && pnpm test:run && pnpm build`.
