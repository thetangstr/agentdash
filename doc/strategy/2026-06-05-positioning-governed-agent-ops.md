# Positioning: The Governed Workspace for Regulated Agent Ops

**Date:** 2026-06-05
**Status:** Draft positioning thesis for review
**Grounded in:** internal agent-factory competitive research (7-layer dashboard, WACT vertical ranking, 386K-record PMF scorecard) cross-checked against a live market scan (HN/X, May 2026). The two corroborate to the same load-bearing stat: only ~14.4% of agents reach production with full security approval.

---

## The bet, in one line

Don't try to win "agent orchestration." Own **one layer — governance/trust-safety** — inside a no-lock-in multi-human workspace, aimed at **one vertical shape — regulated, high-volume back-office intake/case-processing where you augment, never replace.** Wrap the commoditizing layers (serving, protocol); don't fight them.

## Why a layer, not the whole stack

The orchestration stack is converging into ~7 layers, and most are either won or commoditizing:

- **Inference / serving — commoditizing, capital-heavy. Do not compete.** This is where fast-serving vendors live (Fireworks, Groq, Cerebras, DeepInfra, OpenRouter), alongside hyperscaler custom silicon (custom AI chips growing ~44.6%/yr vs ~16.1% for GPUs). When a serving vendor says "we figured out orchestration," they mean runtime *on their inference*, and their incentive is to maximize agent token usage — the structural opposite of gating it. Our gateway should **wrap these providers and enforce policy per step**, not compete with them.
- **Protocol (MCP / A2A / AP2) — converging under Linux Foundation (A2A 150+ orgs, MCP ~97M downloads). Ship as table stakes; don't try to own it.**
- **Agent primitives (Claude/OpenAI/Google SDKs) — mainstream, parity. Wrap, don't compete** (portable agent manifest across SDKs).
- **Trust & Safety / Governance — the open wedge.** Most underinvested layer: ~88% of orgs have agent security incidents, but only ~6% of security budgets target agentic AI. Incumbents (Latitude, Langfuse, Braintrust, Arize, LangSmith) each own a *partial* loop — fragmentation = capturable. In the internal PMF scorecard, governance covers **~34% of all 133 catalogued problems at the highest pillar score**, and **4 of the top-10 pains are governance** (EU AI Act, healthcare vibe-coding, prompt injection, shadow AI).
- **Eval / production-gap — the natural adjacent pillar.** "Demo ≠ prod" and agent quality decay are why pilots die; governance + eval = "trust-safety + eval-to-prod regression gates," which the internal brief names the open wedge.

**Net:** the defensible layer is governance, because the labs and serving vendors won't build it (it throttles the usage they monetize), and the eval/observability players only own slices of it.

## The honest tension: builder vs governance

The single loudest market signal is **framework fatigue** (the #1 pain by upvote weight → a visual builder with no lock-in) — bigger than any single governance pain. AgentDash today sits at the **builder + governance seam**: a multi-human Chief-of-Staff workspace *with* governance (approval gates, budgets, audit, activity log).

Resolution: **lead with governance as the wedge, inside a builder-shaped workspace.** "Another agent builder" competes with everyone. "The governed workspace where a regulated team can actually put agents into production with humans in the loop and an audit trail" competes with almost no one. The builder gets them in the door (no-lock-in); governance is why they can't leave and why it's defensible.

## The vertical

Internal opportunity ranking (WACT):

1. **Public Sector Intake & Case-Processing** ("reduce incomplete submissions, cut backlog, *without replacing your system of record or automating final adjudication*")
2. E-Commerce Post-Purchase Support
3. Insurance Claims Operations
4. Logistics & Supply-Chain Exception Management
5. Healthcare Revenue Cycle Administration

The ranking matters less than the **shared shape** of the top tier: **regulated, high-volume back-office intake/case-processing where you augment, don't replace.** That shape is governance-native — human-in-the-loop and audit aren't upsells, they're legally required (EU AI Act). Pick a vertical where governance is mandatory and the wedge sells itself. **Public Sector or Insurance claims are the cleanest beachheads;** Healthcare RCM connects directly to the "vibe-coded healthcare apps" pain.

## Who are our customers

**Not** "teams running agents" (that's the whole market and it's Microsoft/OpenAI/Google's to lose). The ICP is **ops teams in regulated, high-stakes back-office workflows — government intake, insurance claims, healthcare admin — who are blocked from production by the governance gap.** They have the three things a wedge needs:

- **Acute pain** — ~85% of catalogued problems are High/Critical severity.
- **A compliance mandate that forces the buy** — EU AI Act enforcement is among the top overall pains.
- **Budget** — these are cost-center backlogs with real headcount; the SMB/mid-market sweet spot (~$50-500/seat/mo) fits per-seat pricing.

They don't want a better model or faster inference (serving vendors already give them that). They want **to be allowed to ship.**

## Positioning statement (draft)

> **AgentDash is the governed workspace for regulated agent operations.** Teams in public-sector intake, insurance claims, and healthcare admin run multiple AI agents (any model, any vendor) on real back-office case work — with humans in the loop, hard budget and approval gates, and an immutable audit trail built in from day one. We don't replace your system of record and we don't automate final decisions; we clear the backlog and keep every action accountable, so you can actually put agents into production instead of leaving them stuck in pilot.

## Anti-pitch (what we are NOT)

- Not an inference/serving platform — we run on top of the serving vendors (wrap, route, govern).
- Not another framework or agent builder — no lock-in; bring your SDK/agents.
- Not a horizontal "AI employee for everyone" — we are vertical, regulated, governance-first.
- Not a dashboard/observability tool — we *enforce* before the tool call, not just *watch* after.

## Open questions to pressure-test before committing

1. **Is governance durable against the labs absorbing it?** Google shipped SPIFFE-aligned Agent Identity (May 2026); both hyperscalers stop at the **tenant edge** — cross-tenant identity + multi-vendor + multi-human is the part they won't build. Confirm that gap is real and lasting.
2. **Does the current build match this?** Today AgentDash is a general CoS workspace. The pivot is repositioning (governance gates/budgets/audit move from "feature" to "headline") + choosing one regulated vertical as the design-partner beachhead — not a rewrite.
3. **Beachhead proof:** does the live design-partner convert a 2nd/3rd paying seat because governance + multi-human CoS is load-bearing, not nice-to-have? That is the real PMF signal (AgentDash currently has ~zero organic public footprint, so PMF is a design-partner story, not market-pull yet).
