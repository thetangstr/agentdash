# Deployment & Inference SKUs — Strategy + Goals

**Date:** 2026-06-08
**Status:** Active strategy. North-star doc; individual milestones link to their own implementation plans.
**Owner decision context:** see "Decisions locked" below (captured from the 2026-06-08 strategy discussion).

---

## Goal (north star)

Ship AgentDash as **two SKUs from one codebase**:

1. **Cloud (managed)** — we host *and* provide inference. Customer just logs in. Inference is our COGS, billed **usage-based** with margin via an aggregator (OpenRouter / Fireworks AI).
2. **On-prem (self-managed / BYO)** — customer hosts *and* brings their own tokens/keys. We sell a license + support; inference cost is entirely theirs.

A single product trunk produces both; the difference is packaging (key ownership, billing, exposure), not a fork.

---

## Decisions locked (2026-06-08)

| Decision | Choice | Implication |
|---|---|---|
| Which SKU first | **Both in parallel** | One trunk, two packaging configs. Requires trunk reconciliation (G0) before "one codebase" is true. |
| Cloud inference strategy | **Usage-based via aggregators** — explore **OpenRouter** + **Fireworks AI** | Need an OpenAI-compatible adapter (G1). Aggregators are the metering + resale primitive; no subscription-ToS risk. |
| Current mini pilot | **Treat the Mac mini as the on-prem reference install** | Mini (`hermes_local`, their box) already validates the on-prem SKU. It is NOT the cloud SKU. |

### Why usage-based aggregators (not subscriptions)
- **API / usage-based** = the only path licensed to resell. Aggregators (OpenRouter, Fireworks) are built for apps, return per-request `usage` (OpenRouter returns actual `usage.cost`), and give a single billing relationship across many models.
- **Personal subscription plans** (Claude Pro/Max, what `hermes_local` rides on the mini) are flat-but-cheap-feeling **but** Anthropic's terms are individual-use only — backing a multi-tenant SaaS with them is a ToS/ban risk. Fine for a single-operator on-prem box; **not** for cloud.

---

## Implementation status (2026-06-08, branch `feat/inference-skus`)

G1–G5 are **code-complete and committed** (full regression green: all-package typecheck, server 1992 tests pass / 0 fail, full build). G0's trunk question was resolved by **default to `main`** (it holds the billing substrate); the mini stays the on-prem deploy target, full reconciliation still pending.

| Milestone | Shipped |
|---|---|
| **G1** | `openai_compat` adapter (`server/src/services/openai-compat-llm.ts`) + dispatch wiring; OpenRouter/Fireworks via env; 10 tests |
| **G3** | CoS chat metered to `cost_events` (optional `meter` threaded replier→dispatch, non-fatal); tests |
| **G4** | `usage-billing.ts` (COGS×markup, token-price floor, Stripe meter reporter) + `GET /api/billing/usage`; 11 tests |
| **G2** | ed25519 license verify + opt-in `requireLicense` + on-prem markup-off; `scripts/mint-license.mjs`; on-prem guide; 12 tests |
| **G5** | `scripts/cloud-preflight.mjs` go-live gate (fails closed on unsafe public config) + key-secret hardening docs; 9 tests |

**Still human-gated (cannot be done in code):** issue an OpenRouter/Fireworks key and run the live mini CoS check (G1); create the Stripe Billing Meter + metered price (G4); provision a license keypair for real on-prem customers (G2); set the public domain/cert and run `cloud-preflight.mjs` against prod env (G5); and the eventual `main` ↔ mini trunk reconciliation (G0).

---

## Open decision (blocks G0, therefore most code)

**Which codebase is the product trunk: `main`, or the mini's divergent line?**

- The billing/metering substrate (`cost_events`, `costService`, Stripe per-seat) lives in **`main`**.
- The mini runs a **divergent line** (`feat/cos-minimax-adapter-deploy` lineage, ~9k lines / 106 files ahead — run-ledger / harness-readiness features) currently deployed at SHA `ab48dc14f`.
- "Both SKUs from one codebase" is only true once one is declared canonical and the other is merged in. **This must be answered before G2–G5 get detailed plans** (file paths and substrate availability differ between the two lines).

---

## What already exists (reuse, don't rebuild)

| Capability | Where | Notes |
|---|---|---|
| Adapter pattern + deployment modes | `server/src/services/dispatch-llm.ts`, deployment-mode env | Both SKUs are a packaging concern, not a rebuild. |
| Per-company token+cost ledger | `packages/db/src/schema/cost_events.ts` | `inputTokens` / `cachedInputTokens` / `outputTokens` / `costCents` / `provider` / `biller` / `billingType` / `model`. The usage-billing substrate. |
| Cost service (write + aggregate + budget hooks) | `server/src/services/costs.ts` | `insert(costEvents)`, monthly-spend window, budget hooks. Consumed by `user-profiles` dashboards. |
| Stripe per-seat billing | `server/src/routes/billing.ts` | Free / Pro tiers. `stripe@^22`. No metered/usage records yet. |
| On-prem deployment | Mac mini | BYO host + `hermes_local` inference — the on-prem SKU, already running. |

### What is NOT wired yet
- **Chat path is not metered.** `dispatch-llm.ts` only emits a debug byte-counter (`AGENTDASH_TOKEN_BUDGET_LOG`); `cost_events` is written for agent *runs*, not CoS chat.
- **No OpenAI-compatible adapter.** Every adapter (`claude_api`, `minimax`) is Anthropic `/v1/messages`. OpenRouter/Fireworks speak OpenAI `/chat/completions`.
- **No usage-based Stripe billing.** Only per-seat.
- **No license gate** for the on-prem SKU.

---

## Milestones (goals)

Each goal is independently shippable and testable. Detailed plans live in `docs/superpowers/plans/` and are linked when written.

### G0 — Declare and reconcile the product trunk *(prerequisite)*
- **Outcome:** one canonical trunk; the other line merged in (or explicitly retired).
- **Acceptance:** `cost_events` + `costService` + chosen runtime features all present on a single branch that the mini can deploy without regressing its divergent features.
- **Blocked on:** the open decision above.

### G1 — Shared OpenAI-compatible LLM adapter *(buildable now; trunk-independent)*
- **Outcome:** `AGENTDASH_DEFAULT_ADAPTER=openai_compat` routes CoS replies through any OpenAI-compatible provider (OpenRouter default; Fireworks/Together/Groq via base-URL swap).
- **Acceptance:** keyed → real reply from the provider; unkeyed → stub; bad response → falls back to `claude_api`. Unit tests green; typecheck + build pass.
- **Plan:** [`docs/superpowers/plans/2026-06-08-openai-compatible-llm-adapter.md`](../docs/superpowers/plans/2026-06-08-openai-compatible-llm-adapter.md)

### G2 — On-prem SKU packaging
- **Outcome:** a sellable BYO build — license gate + BYO-key onboarding + a hardened on-prem deploy guide (the mini path, generalized).
- **Acceptance:** a clean install with a customer-supplied adapter+key reaches a real CoS reply; license gate blocks an unlicensed instance; no inference markup billing path active.
- **Blocked on:** G0 (trunk), benefits from G1 (adapter choice for on-prem customers).

### G3 — Meter the chat path
- **Outcome:** every `dispatchLLM` call writes a `cost_events` row (provider, model, tokens, `costCents`) — chat included, not just agent runs.
- **Acceptance:** sending a CoS message produces a `cost_events` row with non-zero token counts; OpenRouter's returned `usage.cost` lands in `costCents`.
- **Blocked on:** G0 (substrate location), G1 (adapter surfaces `usage`).

### G4 — Cloud SKU: usage-based Stripe billing
- **Outcome:** aggregate `cost_events` → Stripe usage records (or metered invoice line) → bill `costCents × markup`.
- **Acceptance:** a month of metered usage produces a correct Stripe usage record reflecting cost + configured markup; reconciles to the `cost_events` total.
- **Blocked on:** G3 (metering), G0.

### G5 — Cloud SKU: key management + exposure hardening + go-live
- **Outcome:** provider key is a server-side secret the customer never sees; `EXPOSURE=public` hardening; public HTTPS domain; cloud go-live smoke test (per `doc/LAUNCH.md`).
- **Acceptance:** sign-up → `/cos` → real reply → metered → billed, on a public URL, with the key never exposed client-side.
- **Blocked on:** G1, G3, G4, G0.

---

## Sequencing

```
G0 (trunk)  ──┬──>  G2 (on-prem SKU)            ──>  on-prem GA
              │
G1 (adapter) ─┼──>  G3 (meter) ──> G4 (usage billing) ──> G5 (cloud hardening) ──> cloud GA
              │
   (G1 is shared by both SKUs and is buildable before G0 resolves)
```

**Recommended order:** start G1 now (shared, well-scoped, trunk-independent). Resolve G0 in parallel. Then G2 (on-prem, closest to done) and the G3→G4→G5 cloud chain.

---

## Out of scope (for these SKUs)
- Real LLM wired for agent **execution** (separate adapter path; chat is the only LLM surface today — see `doc/LAUNCH.md` §6).
- Smart model routing beyond what the aggregator provides natively.
- The dropped-v2 features (CRM, Policy Engine, etc.) per `doc/UPSTREAM-POLICY.md`.
