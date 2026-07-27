# AgentDash Loop — Product Requirements (PRD)

| | |
|---|---|
| **Status** | Draft — for review |
| **Date** | 2026-06-21 |
| **Owner** | yt@d4d.group |
| **Codename** | `agentdash-loop` |
| **Type** | New v2 sub-project (product capability) |
| **Related** | [chat-substrate-design](2026-05-02-chat-substrate-design.md) · [cos-onboarding-conversation-design](2026-05-04-cos-onboarding-conversation-design.md) · dev-side prototype: `loops/` + `loops/ARCHITECTURE.md` |

---

## 1. TL;DR

AgentDash already runs agents autonomously (routines) and can prove their actions (governance gates + Clockchain attestation). What it **cannot** do is let those agents *compound*: today each agent works its own issues in isolation, with no shared memory, no cross-agent context, and a Chief of Staff that prioritizes FIFO.

`agentdash-loop` adds the missing keystone — a **shared, cross-loop signal substrate** — so independent agent loops read and write a common brain, and the CoS prioritizes from it. Critically, **everything the loops do is surfaced on the control plane (API + UI), which is the product** — the loops are just the engine. Provable autonomy is delivered as a **feature-flagged Clockchain partnership**. Together this turns "we run your agents" into "we run a company that gets smarter every day without you prompting it, and proves what it did."

**First slice (the one that makes every demo land):** a first-class `signals` entity + heartbeat wiring so agents read relevant signals before a run and emit signals after — *and the control-plane Signals API + view so you watch the signals appear.* All behind `AGENTDASH_LOOPS_ENABLED`.

---

## 1.5 Strategy & differentiation — why we win

AgentDash's position rests on four competencies that form a **flywheel**, not a feature list:

1. **Fully autonomous company** — the company runs without anyone clicking "go" (execution autonomy).
2. **Adjustable human involvement** — as much or as little; the *autonomy dial*.
3. **Frictionless onboarding** via the Chief of Staff agent — stand up a company in minutes.
4. **Compounding improvement** — picks up signals and runs loops that make the company better over time.

### Loop vs. heartbeat: engine and brain, not rivals

The apparent overlap between "loops" and AgentDash's "heartbeat" resolves cleanly: they are different layers.

- **Heartbeat = the engine.** Trigger + governed execution (routines wake agents, agents act, gates approve). Already production-grade.
- **Loop = the brain on top.** Shared memory + compounding + what-to-do-next. **The heartbeat IS the trigger half of a loop.**

> **A loop = a heartbeat routine (trigger) + a signal contract (read/write the shared brain) + a governed agent/role (execution) + CoS prioritization (what next).** Do NOT build a parallel loop system beside the heartbeat — add the *brain* (signals + smart CoS) to the existing *engine*. That is the "best of both worlds": keep the hard, already-built execution substrate; add the cheap-to-build intelligence layer.

### The closed cycle (this is the product)

```
CoS onboards the company (#3)
        │
        ▼
 ┌──► HEARTBEAT fires a loop ──► reads relevant SIGNALS (context)
 │           │
 │           ▼
 │   governed agent ACTS ──► writes new SIGNALS (learned)   ← every action attested
 │           │
 │           ▼
 │   CoS PRIORITIZES next cycle from the signal pool
 └───────────┘   (compounding, #4)

 Human dials involvement via governance gates (#2); watches on the control plane;
 the company runs itself (#1).
```

The four competencies map onto the cycle: **#1 = the engine runs · #3 = the ignition · #2 = the steering (gates) · #4 = the flywheel that makes it improve.** Today AgentDash has a strong engine + ignition, a half-built steering (CoS is FIFO), and no flywheel. **The flywheel (signals + smart CoS) is the keystone this PRD delivers.**

### Competitive landscape & moat

| Category | Examples | What they lack |
|---|---|---|
| Workflow automation | Zapier / n8n / Make + LLM | deterministic pipelines — not autonomous, never improve |
| Single "AI employees" | Lindy, 11x, Artisan, Cognosys | one agent, one job — **no shared org brain**; you steer each |
| Agent frameworks | CrewAI, LangGraph, AutoGPT | dev kits — you build & run it; no governance, no managed company |
| "AI org" demos | various | no governance, no provability, no compounding memory |

No incumbent integrates **governed multi-agent execution + compounding shared memory + provable autonomy (Clockchain) + agent-led onboarding + an autonomy dial** as one product. Single features are copyable; the coherent flywheel is not. **The durable moat is the per-company signal brain as an accruing asset** — the longer a company runs, the richer its brain and the smarter its CoS, creating a data + switching-cost moat that single-agent and pure-automation products structurally cannot build (they have no shared, compounding memory). Loop engineering is what converts the heartbeat from a *feature* into a *moat*.

### Governed autonomy, not a black box

"Fully autonomous / minimal human" must not read as a scary black box. The loop layer is what makes minimal-human *safe*: the CoS uses the signal pool to **escalate only when it matters**, and governance gates are the dial. The pitch is **"governed autonomy you can prove, with a dial"** — not "we replace your team."

**Positioning:** *AgentDash — the autonomous company that runs itself, improves itself, and proves it. Onboard in minutes; dial the humans up or down.*

---

## 2. Problem & opportunity

### The reframe
The value of an agent company is not the model — it's the **loop engineering** around it: triggers + shared memory + compounding. Customers don't want one smart agent; they want a system that improves on its own. AgentDash's product story should be: **the operating system for compounding agent loops.**

### Where we are (grounded in the codebase, 2026-06)

| Loop-engineering ingredient | Status | Evidence |
|---|---|---|
| **Triggers** (autonomous wake-up) | ✅ production-ready | `packages/db/src/schema/routines.ts`, `server/src/services/routines.ts` (cron, concurrency, catch-up, idempotency) |
| **Governance / trust** | ✅ | approval gates (`verdicts.ts`, `verdict-approval-bridge.ts`); Clockchain attestation demonstrated by Atlas Wire / Meridian |
| **Shared signal brain** | ❌ missing | no `signals`/`insight`/`finding` table; agents write to issues only |
| **Cross-loop context injection** | ❌ missing | `heartbeat.ts` injects only the current issue + wake comment |
| **Intelligent prioritization (CoS)** | ❌ FIFO | `cos-verdict-orchestrator.ts` is round-robin, no semantic ranking |
| **Loop narrative feed** | ⚠️ audit-only | `activity_log.ts` is audit-grade, not a "what the loops accomplished" view |

We own the two **hardest** pieces (autonomous triggers, provable governance). The defensible keystone — the shared brain — is the smallest of the three missing rows to build and unblocks the other two.

### Why now
- We are positioning around deployment/inference SKUs and MSP launch; "compounding loops" is the differentiated story that justifies the platform vs. a thin agent wrapper.
- The dev-side `loops/` substrate (already merged into the MAW workflow) is a working reference of the exact data model — the design risk is largely retired; this PRD lifts it from markdown-in-git into product data.

---

## 3. Goals / non-goals

### Goals
1. Give every company a **shared, queryable signal substrate** any agent loop can read and write.
2. Make agent runs **context-aware**: inject relevant recent signals before a run; let agents emit signals after.
3. Upgrade the CoS from FIFO to **signal-driven prioritization**.
4. **Make the loops fully visible on the control plane** — the API + UI where humans and integrators see, query, and steer what the loops are doing. The loops are the engine; **the control plane is the product.** Every signal, every loop run, every CoS decision is a first-class control-plane resource.
5. Ship **packaged loop templates** (support, SEO, sales, ops) so a customer can "launch a company that does X."
6. Deliver attestation as a **Clockchain partnership**, feature-flagged per company/SKU.

### Non-goals (this sub-project)
- Building new third-party connectors (Intercom/Stripe/CMS) — tracked separately; loops are only as useful as their connectors, but connector breadth is its own roadmap.
- Replacing routines/heartbeat — we extend them, not rebuild.
- A vector/semantic index — signals start as relational + ripgrep-class search; derive an index later only if volume demands (see §11).
- Cross-**company** sharing — signals are strictly company-scoped (see §9 invariants).

---

## 4. Users & use cases

**Primary buyer/user:** a founder/operator who wants to "launch a company" of agents that run a function (support, growth, ops) with minimal prompting.

**Representative loops (templates we ship):**
- **Support loop** — wakes hourly, triages tickets, drafts replies, and files signals for recurring frictions/bugs.
- **SEO/content loop** — daily, researches topics, publishes pages, files signals when a page underconverts.
- **Sales/outreach loop** — files signals on objections and winning messaging.
- **Ops loop** — watches incidents/metrics, files signals, escalates.

**The compounding moment (the demo):** the support loop files a "users keep asking to export data" friction signal → the CoS surfaces it and queues work → the product/eng loop picks it up → a follow-up signal confirms the fix reduced tickets. The human watched it happen in the cockpit and never wrote a prompt.

---

## 5. The capability

Five reinforcing components. They map 1:1 onto the missing rows in §2.

```
        ┌─────────────────────────────────────────────────────┐
        │                  Company (tenant)                    │
        │                                                      │
   ┌────┴────┐   reads/writes   ┌──────────────┐   reads      │
   │ Support │ ───────────────▶ │              │ ◀─────────── │  ┌─────────┐
   │  loop   │                  │   SIGNALS    │              │  │   CoS   │
   ├─────────┤   reads/writes   │  (shared     │   prioritizes│  │ (smart  │
   │   SEO   │ ───────────────▶ │   brain)     │ ◀─────────── │  │ routing)│
   │  loop   │                  │              │              │  └────┬────┘
   ├─────────┤   reads/writes   │ deduped,     │              │       │ assigns
   │  Sales  │ ───────────────▶ │ freq-counted │              │       ▼
   │  loop   │                  └──────┬───────┘              │   issues/work
   └─────────┘                         │ feeds                │
        ▲                              ▼                      │
        │ heartbeat injects   ┌────────────────────┐         │
        └────── context ──────│   CONTROL PLANE    │ (the     │
                              │ (API + UI: signals,│  product)│
                              │  loops, CoS, feed) │         │
                              └────────────────────┘         │
        └──── all actions attested via Clockchain (flagged) ──┘
```

1. **Signals** — the shared, company-scoped artifact store (§7.1).
2. **Heartbeat read/write wiring** — context injection + an emit-signal agent tool (§7.2).
3. **CoS prioritization from the signal pool** (§7.3).
4. **Control-plane visibility** — the API + UI where everything the loops do is seen, queried, and steered. **This is the meat of the app**, not a dashboard bolted on the side (§7.4).
5. **Loop templates** — charter + routine + connectors + signal contract (§7.5).
6. **Clockchain attestation** — a partnership, feature-flagged (§8).

> Framing: the loops are the *engine*; the control plane is the *product*. A signal nobody can see on the control plane has no value. Every component below lands a control-plane surface in the same slice it ships — visibility is never deferred to "later."

---

## 6. UX surface (summary)

- **Signals view** (per company): a filterable list of signal cards — category, frequency badge, status, source links, the loops it feeds. Click → detail with body + timeline + linked issues/PRs.
- **CoS narrative**: the CoS chat/feed explains *why* it's prioritizing ("3 export-friction signals this week → queued AGE-456").
- **Loop cockpit**: one row per active loop (domain) — last run, what it picked up, signals produced, current focus. The "is it working / what needs me" glance.
- **Onboarding tie-in**: during CoS onboarding, selecting a loop template scaffolds the routine + its signal contract.

Detailed mocks deferred to a design spec; this PRD fixes the information architecture, not pixels.

---

## 7. Detailed requirements

### 7.1 Signals (the shared brain) — data model

A new company-scoped entity. Mirrors the proven `loops/signals` schema (see `loops/signals/README.md`), promoted to product data.

New table `signals` (`packages/db/src/schema/signals.ts`, exported from `schema/index.ts` per the schema-export golden rule):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `companyId` | uuid fk → companies | **company-scoped; indexed** |
| `category` | enum | `feedback \| idea \| friction \| observation` |
| `title` | text | short statement |
| `body` | text | what + why it matters |
| `frequency` | int | count of sightings; bumped on recurrence (dedup, not new row) |
| `sources` | jsonb | links: issue ids, PR urls, ticket ids, agent run ids |
| `domain` | jsonb (string[]) | which loop(s) this feeds — a list, never a folder |
| `status` | enum | `open \| triaged \| actioned \| closed` |
| `createdByAgentId` | uuid fk → agents (nullable) | which loop/agent emitted it |
| `dedupeKey` | text | normalized key for recurrence matching (indexed, unique per company) |
| `createdAt` / `updatedAt` | timestamptz | |

Companion table `signal_events` (the append-only timeline; `frequency` = count): `id, signalId, occurredAt, source, note`.

**Requirements**
- R1. CRUD service `signalsService(db)` following the repo service pattern; all reads/writes assert company access.
- R2. **Dedup on write**: an emit with a matching `dedupeKey` bumps `frequency` + appends a `signal_events` row instead of inserting a new signal. Dedup key derivation is deterministic (category + normalized title/area).
- R3. Query API: list/filter by `category`, `status`, `domain`, recency; full-text-ish search over title/body.
- R4. Constants in `packages/shared/src/constants.ts` (`SIGNAL_CATEGORIES`, `SIGNAL_STATUSES`) + Zod validators in `packages/shared`.
- R5. Migration via `pnpm db:generate`; `pnpm -r typecheck` clean.

### 7.2 Heartbeat read/write wiring

The single highest-leverage change. Today `heartbeat.ts` injects only the current issue + wake comment.

**Requirements**
- R6. **Read (context injection):** before an agent run, fetch the top-N relevant recent signals for the agent's `domain`(s) (recency + frequency weighted) and inject a compact digest into the run context. N and token budget configurable; degrade gracefully (no signals → no-op).
- R7. **Write (emit tool):** expose an `emit_signal` capability to the agent (tool/endpoint) so a loop can file a `friction/idea/observation` it noticed while doing its task. Emits go through the dedup path (R2) and are attributed to the agent (`createdByAgentId`).
- R8. Emitting a signal writes an `activity_log` entry **and** is attestable (see §8) — every autonomous write is provable.
- R9. Backward compatible: companies/agents with no signals behave exactly as today.

### 7.3 CoS prioritization from the pool

Upgrade `cos-verdict-orchestrator.ts` (and CoS proactive surfaces) from FIFO to signal-aware.

**Requirements**
- R10. The CoS reads the open/triaged signal pool and ranks what to work on by a transparent score (frequency × recency × domain priority), not arrival order.
- R11. The CoS can **promote a signal to work**: open/queue a Linear issue (or assign an existing agent task) and link it to the signal (`sources`), moving the signal `open → triaged → actioned`.
- R12. The CoS narrates its reasoning in human-readable form (cockpit + chat): "why this, why now."
- R13. Signal status closes when the linked work ships and (optionally) a confirming signal arrives (the compounding loop).

### 7.4 Control-plane visibility (the meat of the app)

The loops run autonomously, but **the product is the control plane** — the API + UI where a human
or integrator sees, queries, and steers everything the loops do. A signal that isn't visible on
the control plane may as well not exist. This is not a reporting dashboard; it is the primary value
surface, and it ships **in the same slice as the capability it exposes** (never deferred).

Two layers, both required:

**A. Control-plane API** (the integrator contract — REST under `/api`, board-key bearer auth, same
service/route patterns as the rest of the control plane):
- R14. **Signals API** — list/filter/search, get-detail (body + timeline + linked work), and the
  state transitions (`open→triaged→actioned→closed`). Company-scoped; `assertCompanyAccess` on
  every route.
- R15. **Loops API** — list active loops (routines framed as loops) with last-run, signals
  produced/consumed, current focus, status; get loop detail.
- R16. **Loop activity feed API** — a "what the loops did" narrative derived from `activity_log` +
  `signal_events`, distinct from the raw audit log. Pageable, filterable by loop/domain.
- R17. These resources are first-class control-plane citizens (documented in the control-plane API
  surface), so external integrators and our own UI consume the *same* contract.

**B. Control-plane UI** (built on the API above):
- R18. **Signals view + detail** — filterable list with frequency/status badges; detail shows
  body, timeline, source links, and the loops it feeds.
- R19. **Loop cockpit** — per-loop row: last run, signals in/out, current focus, status; the
  "is it working / what needs me" glance.
- R20. **CoS narrative panel** — the CoS explains *why* it prioritized what it did (ties to §7.3).
- R21. All views company-scoped, respecting existing auth/roles; degrade cleanly when the loop
  feature flag is off.

### 7.5 Loop templates

Packaged, sellable loops.

**Requirements**
- R22. A loop template = `{ charter (goal), routine (cadence), required connectors, signal contract (which categories/domains it reads + writes) }`.
- R23. Ship at least one end-to-end template (recommend **support loop**) wired to a real connector path; the others can be stubs/coming-soon initially.
- R24. CoS onboarding can instantiate a template: create the routine + register its signal contract + note missing connectors/credentials.
- R25. Templates are additive layers (`// AgentDash:` marked), not modifications to Paperclip core.

---

## 8. Trust & attestation — Clockchain partnership (feature-flagged)

This is the wedge the loop-engineering pattern doesn't have: customers can let loops act
autonomously **and cryptographically prove what they did**. We deliver it as a **formal partnership
with Clockchain** (the integration already proven by Atlas Wire and Meridian), surfaced on the
control plane and gated behind a feature flag so it's a deliberate, sellable capability — on for
the SKUs/customers that want provable autonomy, invisible to those that don't.

**Partnership framing**
- R26. Attestation is built **with Clockchain as a named partner**, not a generic internal feature:
  co-branded in the UI/control plane ("Attested via Clockchain"), and a candidate joint
  go-to-market story ("provable autonomous agents"). Reuse the existing Clockchain attestation path
  (MCP-based, as Atlas Wire / Meridian do); do **not** invent a parallel mechanism.
- R27. Every autonomous **signal emit** and every **CoS promotion-to-work** can produce an
  attestable action record, exposed on the control plane (the action's attestation receipt/link is
  a control-plane field, per §7.4).

**Feature flag**
- R28. Attestation is behind a dedicated flag (`AGENTDASH_ATTESTATION_ENABLED`, resolvable
  per-company/per-SKU). When **off**: loops, signals, CoS, and the control-plane views all work
  fully — there is simply no attestation record or receipt. Attestation must **never** be on the
  critical path of a loop run (a Clockchain outage degrades to "unattested," never to a failed or
  blocked run — consistent with the heartbeat-safety invariant in §9).
- R29. The flag is independent of the master loop flag (§9.1): a company can run loops without
  attestation, but not attestation without loops.

---

## 9. Invariants & constraints

- **Company-scoping is absolute.** No signal is ever readable across companies. Enforce in service + route (assertCompanyAccess) and by index.
- **Heartbeat safety.** Per the live-mini incident history, context injection must be cheap and must not change spawn behavior or crash the run on missing data. Ship behind a flag; load-test on a non-production instance before the mini.
- **No LLM for mechanical data.** Frequency/recurrence counting and metrics are deterministic code, not model calls (the "collectors write data; agents write knowledge" rule).
- **Additive layers.** New files over edits to Paperclip core, for upstream-merge compatibility.
- **Testing.** Never use the `claude`/`claude_local` adapter for localhost testing (use `minimax` or the Mac mini per project directive). Full MAW regression + e2e before any handoff.

### 9.1 Feature flags

The whole sub-project ships behind flags so it can land incrementally and be sold per SKU.

| Flag | Scope | Off behavior |
|---|---|---|
| `AGENTDASH_LOOPS_ENABLED` | master, per-company/SKU | No signals emitted/injected, loop control-plane resources hidden; product behaves exactly as today. |
| `AGENTDASH_ATTESTATION_ENABLED` | per-company/SKU (depends on loops) | Loops + control plane work fully; no Clockchain attestation record/receipt (§8 R28). |

- R30. Both flags resolve through the existing config/flag mechanism, default **off** in production until each slice is verified on a non-production instance (heartbeat-safety invariant).
- R31. Control-plane API and UI must degrade cleanly when a flag is off (no errors; resources simply absent/empty).

---

## 10. Phasing & milestones

Each slice is independently shippable and demoable — and **each lands its control-plane surface
(API + UI) in the same slice**, because the control plane is the product (§7.4). All slices ship
behind `AGENTDASH_LOOPS_ENABLED` (§9.1).

| Slice | Scope | Control-plane surface (the meat) | Demo payoff | Size |
|---|---|---|---|---|
| **S1 — Signals + heartbeat read/write** | §7.1 entity + §7.2 R6–R9 | Signals API + Signals view/detail (§7.4 R14, R18) | Agents notice things and inherit context — and you *see the signals appear* on the control plane | M |
| **S2 — CoS prioritization** | §7.3 R10–R13 | CoS narrative panel + signal→work links (§7.4 R20) | CoS surfaces "3 users hit X → I queued a fix" instead of FIFO, visibly, on the control plane | M |
| **S3 — Loop cockpit & feed** | §7.4 R15–R17, R19 | Loops API + activity-feed API + loop cockpit UI | Human watches loops compound; "what needs me" glance | M |
| **S4 — Templates + Clockchain partnership** | §7.5 R22–R25 + §8 R26–R29 (`AGENTDASH_ATTESTATION_ENABLED`) | "Attested via Clockchain" receipts on signal/CoS actions; template instantiation in onboarding | "Launch a company that runs a provable support loop" — the sellable story | L |

**Recommended first build: S1.** It's the smallest slice that flips the product narrative from "agents do tasks" to "agents compound," and it's the foundation the other three stand on.

---

## 11. Success metrics

- **Leading (mechanism works):** signals emitted/week per company; % of agent runs that inject ≥1 signal; dedup hit-rate (recurrence captured, not duplicated).
- **Compounding:** % of shipped work that originated from a signal filed by a *different* loop (cross-loop pollination — the core thesis).
- **CoS quality:** human override rate on CoS prioritization (lower = more trusted).
- **Business:** template activations; "compounding loops" cited in won deals; time-to-first-compounding-moment in onboarding.

---

## 12. Risks & open questions

- **R: Dedup quality.** Bad `dedupeKey` derivation either fragments (misses recurrence) or over-merges (collapses distinct signals). *Mitigation:* start conservative (category + area), measure dedup hit-rate, iterate; allow manual merge/split in cockpit.
- **R: Heartbeat regression.** Context injection on a hot path. *Mitigation:* flag-gated, token-budgeted, load-tested off-prod first.
- **R: Signal noise.** Agents emit low-value signals that drown the pool. *Mitigation:* frequency/recency ranking surfaces what matters; CoS + human can close/snooze; consider an emit quality bar.
- **Q:** Should `signals` reuse or stay distinct from the chat-substrate typed cards ([chat-substrate-design](2026-05-02-chat-substrate-design.md))? *Lean:* distinct entity, but a signal can be surfaced as a card. Resolve in eng design.
- **Q:** Do we need a `task`/work kind, or is Linear `AGE-*` the work home for product loops as it is for the dev loop? *Lean:* Linear/issues are the work home; signals link to them.
- **Q:** Attestation granularity — every emit, or only CoS promotions? *Lean:* configurable; default attest promotions.

---

## 13. Out of scope / future

- Connector marketplace breadth (separate roadmap).
- Vector/semantic retrieval over signals (add only past ~10⁴ signals/company).
- Cross-company benchmarking on *anonymized* signal patterns (a future data product — explicitly not in scope, and gated by the company-scoping invariant).
- A reconcile/consolidation daemon for dedup at scale.

---

## 14. Appendix — mapping to existing code & the dev-side prototype

| Need | Existing anchor | Action |
|---|---|---|
| Signal entity | `packages/db/src/schema/*` + `schema/index.ts` | new `signals.ts` + `signal_events.ts` |
| Service/route pattern | repo service/route conventions | `signalsService(db)` + `signalRoutes(db)` |
| Triggers | `routines.ts`, `routineTriggers.ts` | reuse for loop cadence |
| Context assembly | `server/src/services/heartbeat.ts` | inject signal digest; add emit path |
| Private agent state | `agent_runtime_state.ts` | unchanged (signals are the *shared* layer it lacks) |
| CoS routing | `cos-verdict-orchestrator.ts`, `cos-proactive.ts` | add signal-aware ranking + promote-to-work |
| Narrative | `activity_log.ts`, `activity.ts` | derive loop feed (don't overload audit log) |
| **Control-plane API (the product)** | `/api` REST routes, board-key bearer auth, service/route patterns (the integrator contract) | new first-class `signals` / `loops` / loop-activity-feed resources |
| **Control-plane UI** | `ui/` (React/Vite), company-scoped views | signals view/detail, loop cockpit, CoS narrative panel |
| Attestation (Clockchain **partnership**) | Clockchain MCP integration (Atlas Wire / Meridian) | reuse path for emit/promotion receipts; co-branded; behind `AGENTDASH_ATTESTATION_ENABLED` |
| Feature flags | existing config/flag mechanism | `AGENTDASH_LOOPS_ENABLED`, `AGENTDASH_ATTESTATION_ENABLED` |
| **Reference data model** | **`loops/ARCHITECTURE.md`, `loops/signals/README.md`** | **the product schema lifts this model; design risk already retired** |

> The dev-side `loops/` substrate (markdown-in-git, merged into the MAW workflow) is the working prototype of this exact model. `agentdash-loop` is the same model promoted to multi-tenant product data (DB + API + UI), governed and attested.

---

### Next step
Decompose into MAW `AGE-*` issues — recommend S1 first: `signals` schema + service + the heartbeat read/write wiring, flag-gated, with tests. Say the word and I'll draft the issues sized for `/workon`.
