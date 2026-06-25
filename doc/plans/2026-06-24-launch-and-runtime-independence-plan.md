# AgentDash — Launch & Runtime-Independence Plan

Date: 2026-06-24
Status: Draft for approval
Owner: yt
Context source: strategy + adapter-debugging session 2026-06-24 (last30days market research + live mini diagnosis)

---

## 1. Goal (north star)

**Launch AgentDash as a reliable, low-friction "try-before-you-pay" AI-agent workspace that a managed-service / agency shop can sign up for and get value from in minutes — with a runtime we own (no customer token or binary wrangling) and pricing that starts hybrid and evolves to outcome-based.**

"Launched" means a brand-new external user can:
1. Sign up with no credit card, land in a workspace, and chat with a CoS.
2. See a **populated** demo/starter company (not a blank room) and hire a working agent.
3. Have that agent **run reliably** with zero adapter/token setup on their part.
4. Hit a natural Free→Pro boundary and convert via the existing 14-day trial.

Defensibility: the agent loop accrues outcome signal, which (a) improves the product and (b) unlocks outcome-based pricing nobody else can credibly offer.

---

## 2. Strategic decisions locked this session

| Question | Decision |
|---|---|
| Vertical variants vs general platform | **One horizontal platform** (CoS-led multi-human workspace). Verticals are *templates / starter companies* + GTM wedges, **not** forked codebases. |
| Beachhead vertical | **MSP / agency operations** (work shape fits agents; mini MSP-launch already exists). Land one painful workflow (e.g. tier-1 ticket triage), not rip-and-replace. |
| "Run an MSP exclusively on AgentDash"? | No. MSPs are *customers*; AgentDash is the platform. Dogfood an internal MSP demo company for seed data. |
| Deployment | **Two SKUs.** Lead cloud-managed (PMF/SMB speed); on-prem/BYO as the enterprise/regulated unlock (data residency is the #1 enterprise driver). |
| Pricing | **Hybrid now → outcome-based later.** Per-human-seat base + usage-based inference pass-through; evolve to per-outcome as the loop measures outcomes. (Per-seat alone is dying: 21%→15% in 12mo; hybrid is the 41% plurality.) |
| Runtime independence | **Own the loop + own model access.** Build a managed inference gateway (kills token setup) and a first-party native adapter (kills the external-binary dependency). Keep Hermes/Claude/Codex as opt-in. |
| Multi-LLM | Not a deciding factor — Hermes *and* a gateway-backed native adapter both do it. Decide on control/install, not model coverage. |

Market backing (last30days, 2026-06-24): 2026 is the year vertical agents overtake horizontal SaaS, but the winning shape is "horizontal substrate + vertical wedge"; hybrid deployment scores highest with enterprises (4.2/5 vs self-hosted 3.8 vs SaaS 3.0); hybrid pricing is the plurality and outcome-based is real but concentrated in support.

---

## 3. The core risk and the insight

The launch lives or dies on **default-agent reliability**, and today's runtime is fragile.

Live diagnosis on the mini (instance B, work DB):
- Hermes works (3,646 successful runs; round-trip probe returns correct answer) **but ~16–33%/day `adapter_failed`**.
- **None of the failures are "Hermes is buggy."** They are integration/credential/environment:
  - provider/agent auth (expired Codex token; agent API key not resolving; "carry the API secret key"),
  - binary not resolvable (~734: "missing command" / "failed to start hermes"),
  - model config drift (~823: "configured model unavailable"),
  - runaway timeouts (30-min yak-shaves hitting the 1800s limit), made dangerous by `cwd = the live source tree` (an agent edited live `auth.ts`).

**Insight:** every dominant failure class is exactly what an owned gateway + native loop + sandboxed workspace eliminates. We're not fighting a flaky Hermes; we're fighting the brittleness of depending on an external binary + customer tokens + an unsandboxed workspace.

---

## 4. Plan by phase

GTM (MSP wedge) runs in parallel with the technical phases.

### Phase 0 — Stabilize & decide (now)
- [x] Clean stray agent edits from live `auth.ts`; remove `/tmp` forged-JWT artifacts. (done)
- [x] Confirm `x-agent-key` auth fix already on `main`; reaper false-positive already mitigated on `main` via pid-recording. (done)
- [ ] Forward-port the **preflight round-trip probe** to `main`'s `registry.ts` (small PR; main only has static checks).
- [x] **Hermes-usage audit — DONE (2026-06-24).** Decisive finding: agents do ~all work by calling the AgentDash REST API via `curl` through Hermes's generic `terminal` tool, NOT via Hermes-native coding tools. AgentDash configures **no toolsets** (the "messaging" warning was a stray manual config). No file-edit/shell/coding dependency for shipped archetypes (CoS is explicitly forbidden from coding; shell is used only as an HTTP client). No Hermes-proprietary dependency (skills sync is generic + UI-only; no self-evolving loop; the heartbeat loop is AgentDash's; sessions/resume is generic + trivial). Default first-hire adapter is actually `claude_local`, not Hermes. **Verdict: native adapter = SMALL for CoS/triage/analyst/support (the launch case); LARGE only for true coding agents, which no shipped archetype needs.**
- [ ] Sandbox agent `cwd` so runs can never edit the live source tree again.

### Phase 1 — Managed inference gateway (the foundation)
- [ ] **Managed inference gateway** (path-independent, highest leverage, do first): all model calls route through an AgentDash-operated gateway (OpenRouter/Fireworks + your keys), metered = usage-based-inference SKU. Customer sets no tokens. On-prem = BYO key into the same interface. Provider-swappable behind the gateway. Both Hermes (today) and the native adapter (next) point at it.
- Exit criteria: existing agents run with zero customer-managed tokens (gateway holds keys); cc-switch retired.

> **Re-sequenced after the audit:** "managed Hermes (bundle a pinned binary)" is **demoted** from a planned bridge to a *fallback*. Since the native adapter is a SMALL lift for the launch case, we go gateway → native adapter directly and keep the already-working Hermes running side-by-side as the proven fallback during cutover. A productized "managed Hermes" install is only worth building if/when we ship true **coding** agents (case b), which the MSP launch does not need.

### Phase 2 — Trial experience (try without paying)
Most scaffolding already exists (14-day no-card trial, Free tier, ungated signup→CoS→first hire).
- [ ] **Demo seed data**: ship a populated MSP starter company (dogfood) so trials aren't a blank room — biggest "wow" gap.
- [ ] **Richer Free tier** (e.g. 2 humans + 3 agents) so users feel the multi-human/roster value before the wall (today's 1+1 is too thin).
- [ ] (Optional) unauthenticated read-only "watch a live demo company" view for marketing.
- Depends on Phase 1 (reliable default agent) — a trial with a failing agent is worse than no trial.
- Exit criteria: external user → value in <10 min, default agent reliable, natural Free→Pro boundary.

### Phase 3 — Native adapter (the durable default) — confirmed SMALL, runs right after Phase 1
The audit confirmed this is the primary path, not a far-future item. Build it directly after the gateway; run it side-by-side with the still-working Hermes, then cut over.
- [ ] Build `agentdash_native` as a `ServerAdapterModule` (register in `registry.ts` alongside the others), `supportsLocalAgentJwt: true`.
- [ ] In-process agent loop (Claude Agent SDK / OpenAI Agents SDK) calling models through the Phase-1 gateway; read the prompt heartbeat already builds from `ctx.context.paperclipIssue` / `paperclipWakeComment`.
- [ ] **A small native tool set wrapping the existing REST API** (replaces the curl-in-terminal pattern): `list_issues`, `get_issue`, `update_issue`, `create_issue` (with DoD), `post_comment`, `read_comment`, `set_dod`, `write_verdict`, `create_interaction`, `get_quota` (+ connector sends if needed). Each calls `/api/...` with `x-agent-key: ctx.authToken` and `X-Paperclip-Run-Id: ctx.runId` — no new auth (middleware already accepts the per-run JWT).
- [ ] Map results to `AdapterExecutionResult` (summary, usage tokens, costUsd, sessionParams for resume, resultJson) so heartbeat metering/auto-comment works unchanged.
- [ ] Make it the **default** for new agents (CoS/triage/analyst/support = the launch case); keep Hermes/Claude/Codex as opt-in BYO harnesses; keep Hermes as proven fallback during cutover.
- Out of scope for launch: file-edit/shell/git/worktree (case b, coding agents) — opt-in later via a harness adapter.
- Exit criteria: native adapter is the default, zero-install, reliability ≥ current Hermes (≥ its ~67–84% success, target <5% adapter_failed).

### Phase 4 — Pricing evolution
- [ ] Launch with **hybrid**: per-human-seat base + usage-based inference pass-through (already planned).
- [ ] Instrument the loop for **outcome telemetry** (shipped issue / resolved ticket / completed objective).
- [ ] Introduce **outcome-based** tiers as the signal matures — the "we price on outcomes because our loop proves them" wedge.

---

## 5. Open decisions / inputs needed

1. ~~Native-adapter lift~~ — **RESOLVED 2026-06-24: SMALL for the launch case.** Native adapter is now the primary runtime path (Phase 3 right after the gateway), not a far-future item; managed-Hermes-bundle is demoted to fallback/coding-only.
2. **Mini cutover to `main`/overlay** — the mini lags `main`; cutover brings the committed fixes but is a tracked op (runbook exists). Sequence vs. launch?
3. **Beachhead workflow** — which single MSP workflow leads the demo + GTM (ticket triage is the current best guess).
4. **Free-tier limits** — exact humans/agents and trial length for the public try-it experience.

---

## 6. Success metrics (launch readiness)

- Default agent `adapter_failed` rate <5% in production.
- Time-to-first-value for a new trial user <10 min.
- Zero customer-managed tokens or binaries on the cloud SKU.
- Free→Pro trial conversion measurable and instrumented.
- No agent can mutate platform source (sandboxed workspace verified).

---

## Immediate next actions (this week)
1. ~~Hermes-usage audit~~ — **DONE.** Native adapter is SMALL for the launch case.
2. **Managed inference gateway design** — now the lead item (starts Phase 1; both runtimes depend on it).
3. **Native adapter spec** — `agentdash_native` ServerAdapterModule + the ~10 REST-API tools (Phase 3; small, the durable default).
4. Preflight-probe PR to `main` + sandbox agent cwd (close Phase 0).
