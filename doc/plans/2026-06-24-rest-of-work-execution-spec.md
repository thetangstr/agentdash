# Execution Spec — Rest of Work to Launch (Runtime Independence + Trial + Pricing + GTM)

Date: 2026-06-24
Status: Spec for approval
Reads with:
- `doc/plans/2026-06-24-launch-and-runtime-independence-plan.md` (goal + phases + decisions)
- `doc/plans/2026-06-24-gateway-and-native-adapter-design.md` (gateway + native adapter design)

This is the holistic build spec for everything between today and launch: each workstream's scope, deliverables, **acceptance criteria (how we measure success)**, and **testing steps**, plus the cross-cutting test strategy, launch-level success metrics, sequencing, and the definition of "launched."

---

## 0. Workstream map

| # | Workstream | Phase | Status | Gates the launch? |
|---|---|---|---|---|
| W0 | Phase-0 closeouts (preflight probe, sandbox cwd, commit live fixes) | P0 | partly done | yes (reliability) |
| W1 | Inference gateway — finish + wire in | P1 | MVP in review (#411) | yes (foundation) |
| W2 | `agentdash_native` adapter | P3 | designed | yes (the runtime) |
| W3 | Trial experience (demo data, free tier) | P2 | scaffolding exists | yes (the funnel) |
| W4 | Pricing (hybrid → outcome) | P4 | hybrid scaffolding exists | partial (hybrid yes, outcome later) |
| W5 | GTM / MSP wedge | parallel | decided | yes (who we sell to) |
| W6 | Reliability & ops (mini cutover, EPIPE guard, preflight gating) | P0/ongoing | partly done | yes (don't crash prod) |

Single guiding metric for the technical launch: **default-agent `adapter_failed` rate < 5% in production**, observable in the in-product **Company Settings → Health** panel (HarnessHealthPanel + TaskOutcomeQualityPanel — already shipped).

---

## W0 — Phase-0 closeouts

**Scope:** stop the bleeding and lock in what already works on the mini.

**Deliverables**
- Forward-port the **preflight round-trip probe** to `main`'s `registry.ts` (main only has static checks; the probe actually runs a 1-turn completion).
- **Sandbox agent `cwd`** so runs can never edit the live deployment source (the Laura incident). Point runs at a per-run/per-workspace dir, not the checkout.
- Confirm the reaper + `x-agent-key` fixes are durable on `main` (they are — verified 2026-06-24); the mini inherits them on cutover (W6).

**Acceptance criteria**
- `process_lost` false-positives stay ~0 (already true: 1 in 8 days on the mini).
- A live agent run cannot modify any file under the deployment checkout (verified by diffing the checkout before/after a run).
- Preflight probe returns `fail` for a misconfigured adapter and `pass` for a working one.

**Testing steps**
- Unit: preflight probe test (mock a passing vs failing completion) — mirror the existing static-check tests in `registry` test files.
- Live (mini, instance B): run one controlled agent; assert `git status` in the deployment checkout is unchanged after the run.
- Regression gate (below) before merge.

---

## W1 — Inference gateway (finish + wire in)

MVP shipped in **#411** (`server/src/services/inference-gateway.ts`, 16 tests). Remaining to make it real:

**Deliverables**
1. **Config wiring:** surface `AGENTDASH_GATEWAY_*` through `Config` (`server/src/config.ts`) and per-company BYO key through the existing secrets service (`resolveExecutionRunAdapterConfig` path).
2. **Metering → billing:** call `recordGatewayUsage()` from the run-completion path and persist via `costService.createEvent` (costEvents) so gateway spend shows in cost dashboards and feeds the usage-based SKU.
3. **Wire existing adapters (optional bridge):** point Hermes/claude_local provider config at the gateway → **retire cc-switch**.
4. **Hardening (post-launch):** thin self-hosted proxy for per-company budgets, provider fallback, rate-limit handling.

**Acceptance criteria**
- An agent run completes with **no customer-provided provider token** (gateway holds the key).
- Per-run cost appears in `costEvents` with correct provider/model/tokens.
- cc-switch removed from the mini runtime with no regression in run success.
- Switching a model is a config change (no code change).

**Testing steps**
- Unit (done): `inference-gateway.test.ts` (resolution, override, cost math).
- Integration: a heartbeat-run test that stubs the gateway client and asserts a `costEvents` row is written with the computed cost.
- Live (mini, instance B): set `AGENTDASH_GATEWAY_*`, run one agent through the gateway, confirm success + a cost row; confirm the agent's adapterConfig carries **no** provider key.
- Regression gate before merge.

---

## W2 — `agentdash_native` adapter (the runtime)

Per the design doc Part B; the audit confirmed a **small** lift (agents already act purely via the REST API).

**Deliverables**
- `server/src/adapters/native/index.ts`: `ServerAdapterModule` (`type: "agentdash_native"`, `supportsLocalAgentJwt: true`), registered in `builtin-adapter-types.ts` + `registry.ts`.
- In-process loop (Claude Agent SDK / OpenAI Agents SDK) via `resolveGatewayAccess()`.
- ~10 typed tools wrapping `/api` (list/get/update/create issue, post/read comment, set_dod, write_verdict, create_interaction, get_quota), authed with `ctx.authToken` (`x-agent-key`) + `ctx.runId` (`X-Paperclip-Run-Id`).
- Reliability budgets: max turns, wall-clock timeout well under 1800s, per-tool-call cap.
- `testEnvironment` (gateway reachable + key present), `sessionCodec` (own resume id), result mapping to `AdapterExecutionResult`.
- **No fs/shell tools** → live-source mutation impossible by construction.

**Acceptance criteria**
- Native adapter completes the standard CoS/triage loop (read issue → reason → post comment / update status / write verdict) end-to-end.
- `adapter_failed` rate **< 5%** over a 100-run sample, **≥** current Hermes success.
- Zero external binary / venv / token; install footprint = the server only.
- Cannot read/write the filesystem or spawn a shell (asserted).

**Testing steps**
- Unit: each tool's request shaping (headers, path, body) against a mocked fetch; result mapping (usage→costUsd, sessionParams).
- Integration: a fake model loop driving 2-3 tool calls against a test API server; assert correct issue/comment mutations and a clean `AdapterExecutionResult`.
- Adversarial: assert the adapter exposes no fs/shell tool and that a model attempt to "edit a file" has no tool to do so.
- Live A/B (mini, instance B): run the native adapter **side-by-side** with Hermes on the same backlog; compare success rate, latency, and cost over ≥100 runs. Flip the new-hire default only when native ≥ Hermes and < 5% failed.
- Regression gate before merge; targeted Playwright spec if any UI surfaces adapter choice.

---

## W3 — Trial experience (the funnel)

Scaffolding exists (14-day no-card trial, Free tier, ungated signup→CoS→first hire). Close the gaps.

**Deliverables**
- **Demo seed data:** a populated MSP starter company (dogfood) so a trial isn't a blank room — seeded issues, a CoS + 2-3 agents (paused/idle, not heartbeat-active), example DoD/verdicts. Reuse the company-creator skill.
- **Richer Free tier:** raise caps from 1 human + 1 agent to e.g. 2 humans + 3 agents (tune in `tier-policy.ts`) so the multi-human/roster value is felt before the wall.
- (Optional) unauthenticated read-only "watch a live demo company" view for marketing.

**Acceptance criteria**
- A brand-new signup reaches a working, populated workspace and a successful first agent run in **< 10 minutes**, no card.
- Free-tier caps enforce the new limits (402 at the boundary) and the trial→Pro upgrade path works.
- Demo company is view-meaningful without any heartbeat-active agents (no crash risk).

**Testing steps**
- Unit: `tier-policy` cap tests updated for new limits.
- E2E (Playwright, `tests/e2e/*`): signup → CoS chat → hire agent → see populated workspace; and the Free→trial→Pro cap-boundary flow. Add specs for the new limits.
- Live (throwaway/dev instance, NOT the live mini): provision the demo company; verify seed renders and a single agent run succeeds.
- Manual TTFV stopwatch run from a clean account.

---

## W4 — Pricing (hybrid → outcome)

**Deliverables**
- **Launch (hybrid):** per-human-seat base + usage-based inference passthrough (gateway metering from W1). Stripe tiers configured.
- **Outcome instrumentation:** emit per-run/per-issue outcome events (shipped issue / resolved ticket / completed objective) from the verdict + issue-status paths.
- **Outcome-based tiers (post-launch):** price per accepted outcome once telemetry is trusted.

**Acceptance criteria**
- A trial converts to a hybrid Pro plan with seat + metered usage billed correctly (reconciles with `costEvents`).
- Outcome events are emitted and queryable (count of accepted DoD/verdicts per period) — the basis for the TaskOutcomeQuality panel already shipped.

**Testing steps**
- Unit: billing math (seat + usage) and outcome-event emission on verdict transitions.
- Integration: Stripe test-mode checkout → trial → upgrade; assert metered usage line items.
- Manual: end-to-end billing dry run in Stripe test mode.

---

## W5 — GTM / MSP wedge (parallel, non-code)

**Deliverables**
- Pick the **single beachhead workflow** (recommended: tier-1 ticket triage) that the demo + marketing lead with.
- MSP positioning + the demo MSP company (shared with W3 seed data).
- One reference design partner / pilot.

**Acceptance criteria**
- A 5-minute demo shows the beachhead workflow end-to-end on the seeded MSP company.
- At least one pilot MSP runs the workflow on real (or realistic) tickets.

**Testing steps**
- Dogfood the demo workflow weekly; track whether the seeded agents produce acceptable verdicts (TaskOutcomeQuality panel).

---

## W6 — Reliability & ops

**Deliverables**
- **Mini cutover** to `main`/`age/atlas-wire-overlay` (runbook exists) so the live box runs the committed reaper/x-agent-key fixes + the gateway, retiring the uncommitted live edits.
- **EPIPE guard:** wrap the adapter-spawn child-stdin write / add a socket 'error' handler so a dead child can never crash-loop the server (long-standing bug). N/A for the native adapter (no child) but needed while external CLIs remain.
- Optionally enable `AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true` once the round-trip probe is on main.

**Acceptance criteria**
- No server crash-loop is possible from a failed adapter spawn (verified by a forced-dead-child test).
- The mini runs a tagged `main`-based SHA with all fixes; `process_lost` and EPIPE both absent over a week.

**Testing steps**
- Unit: EPIPE guard test (write to a closed stream → handled, no throw).
- Live: staged mini cutover per the runbook with the readiness proof; watch `heartbeat_runs` for 48h.

---

## Cross-cutting test strategy

**Mandatory regression gate (every PR, per CLAUDE.md):**
```
pnpm -r typecheck && pnpm test:run && pnpm build
```
plus relevant `tests/e2e/*.spec.ts` Playwright specs for UI-touching changes. Report pass counts and name any flake (the `e2e` Playwright-install flake is known infra).

**Test layering**
- **Unit** — pure logic (gateway resolution/cost, tool request shaping, tier caps, billing math). Fast, no DB/network.
- **Integration** — service + DB (costEvents writes, outcome events, heartbeat run lifecycle) with the embedded PG.
- **E2E** — Playwright multiuser specs for signup→trial→hire→run and cap boundaries.
- **Adversarial** — native adapter has no fs/shell; refute "agent can edit source."
- **Live-on-mini protocol (the only place real agent execution is validated):**
  - Use **instance B** (`:3200`, private) or a throwaway instance — **never** seed heartbeat-active agents on the public instance A.
  - Keep agents `paused`/`idle` unless running a single controlled test; re-pause after.
  - Use the **gateway/MiniMax path**, never `claude_local` on localhost (credit-safety rule).
  - Read results from `heartbeat_runs` (status/error_code by adapter) and the Health panel.

**MAW**: feature work (W2, W3, W4) runs through the Builder→Tester gate; XS/S auto-ship after local test, M+ needs human verification.

---

## Launch-level success metrics (with targets + measurement)

| Metric | Target | How measured |
|---|---|---|
| Default-agent reliability | `adapter_failed` < 5% | `heartbeat_runs` by adapter; Health panel |
| Time-to-first-value (new trial) | < 10 min | Manual stopwatch + signup→first-successful-run timestamp |
| Customer-managed tokens (cloud) | 0 | adapterConfig audit; gateway holds keys |
| Live-source mutation by agents | impossible | adversarial test + checkout diff after runs |
| Server crash-loops from adapters | 0 | EPIPE guard test + a week of uptime |
| Trial→Pro conversion | instrumented (baseline then improve) | Stripe + cohort tracking |
| Outcome telemetry | emitted & queryable | accepted DoD/verdict counts; TaskOutcomeQuality panel |

---

## Sequencing & dependencies

```
W0 (closeouts) ──┐
W1 (gateway) ────┼──> W2 (native adapter) ──> flip default ──┐
                 │                                            ├──> W3 (trial) ──> LAUNCH
W6 (EPIPE/cutover)┘                                           │
W4 (pricing hybrid) ─────────────────────────────────────────┘  (outcome tiers post-launch)
W5 (GTM/MSP) runs in parallel; shares the demo company with W3
```

Critical path: **W1 → W2 → W3**. W0/W6 protect production alongside. W4-hybrid and W5 proceed in parallel; W4-outcome is post-launch.

Milestones:
- **M1 (foundation):** W1 merged + wired (gateway used, cc-switch retired). 
- **M2 (runtime):** W2 native adapter passes A/B on instance B; default flipped.
- **M3 (funnel):** W3 trial < 10 min TTFV on a clean account.
- **M4 (launch):** all launch metrics green; mini on `main` SHA; pricing live.

---

## Definition of "launched" (exit checklist)
- [ ] New user signs up (no card) → populated MSP starter workspace → successful first agent run in < 10 min.
- [ ] Default agent is `agentdash_native`, zero customer tokens, < 5% adapter_failed in production.
- [ ] No agent can mutate platform source; no adapter can crash-loop the server.
- [ ] Hybrid pricing live; usage reconciles with `costEvents`; outcome telemetry emitting.
- [ ] Mini runs a `main`-based SHA with all fixes; Health panel green.
- [ ] One MSP pilot running the beachhead workflow.
```
