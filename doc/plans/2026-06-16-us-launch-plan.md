# AgentDash — US Launch Plan (hosting, pricing, packaging)

**Date:** 2026-06-16
**Inputs:** `/last30days` market research on AI-agent pricing + deployment (2026), the existing two-SKU + agent-run-metering direction (AGE-119, `project_deployment_inference_skus`), the Paperclip upstream digest (345 behind), and the live mini deployment learnings.

---

## 1. Positioning

AgentDash = a **CoS-led, multi-human AI workspace**: you hire a Chief of Staff agent, it breaks goals into work, hires/【runs】 specialist agents, and every consequential action gets a **court-grade Clockchain receipt**. The wedge vs. generic agent platforms is *governance + verifiability* (who did what, when, provably) layered on a real multi-human workspace — not "another agent framework."

Atlas Wire (world-events newsroom) and Meridian Pay (verifiable disbursements) are the two reference demos that prove the substrate.

---

## 2. Pricing — the decision

The 2026 market has converged (research): **hybrid wins, pure-seat and pure-transaction both lose.** 43% of SaaS already hybrid → 61% by year-end; hybrid firms post ~38% higher NRR. Salesforce reverted to seat-anchored "for predictability"; Intercom/Fin/HubSpot moved to per-resolution ($0.50–0.99); Copilot's usage-only switch drew backlash; buyers' #1 fear is runaway/surprise bills.

**AgentDash pricing = hybrid, two layers:**

1. **Platform fee per human seat** (CoS + teammates) — predictable, simple budgeting, anchors the relationship. Free tier (1 human + 1 agent), Pro per-seat.
2. **Metered agent-runs as the usage layer** — sold as **allowance + overage**, never an open meter. We already defined `agent-run` as a billable unit (AGE-119); that is the right metered primitive. Each tier includes a monthly agent-run allowance; overage at a published per-run rate.

**Token economics:** **bundled inference by default** (margin + zero-setup for the non-technical CoS buyer; usage-based inference already routes through OpenRouter/Fireworks), with **BYOK/BYOT as an enterprise/power-user toggle** (research: BYOK only wins above ~1k calls/mo and is otherwise a margin trap; offer it, don't default to it).

**Do NOT:** price per-agent-seat (caps the very scaling we want), or ship an uncapped meter (kills trust).

---

## 3. Packaging — SKUs

| SKU | Hosting | Inference | Audience | Price shape |
|-----|---------|-----------|----------|-------------|
| **Free** | Managed cloud | Bundled (small allowance) | Try-it, founders | $0 · 1 human + 1 agent, 14-day no-card trial of Pro |
| **Pro** | Managed cloud | Bundled (seat allowance + overage) | Teams | Per-seat/mo + agent-run allowance, overage rate |
| **Enterprise** | **BYOC / on-prem** (self-serve) | BYOK or bundled | Regulated / data-residency | Platform license + support; customer owns inference + infra |

This matches the approved two-SKU plan (cloud managed vs on-prem BYO), sharpened with the hybrid pricing + a Free funnel.

---

## 4. Deployment architecture

Research: the SaaS-vs-self-host binary is dead; every leader ships **BYOC** (vendor runs the control plane, customer data/workloads stay in the customer's cloud), and **self-serve BYOC without an enterprise sales call is the 2026 standard**. n8n proves "free self-host is a funnel, not cannibalization."

- **Managed cloud (default):** AgentDash control plane + UI hosted by us; bundled inference. Fastest path; where most revenue is.
- **Self-host / BYOC (Enterprise):** Docker today (already running on the mini), **Kubernetes next** — and upstream already shipped a **self-hostable Kubernetes sandbox provider** (`#5790` + `#7938` + `#7934`, the plugin-kubernetes 3-stage series) plus agent-runtime sandbox images. That is the cleanest foundation for the self-host SKU's isolated agent execution. Adopt it for the Enterprise SKU rather than building from scratch.
- **Isolation:** for running agent-generated code at scale, microVM/pod isolation is the bar (upstream K8s sandbox provides this).

---

## 5. Security must-dos before any public exposure

Going to market = going public, which changes the threat model from the current private tailnet box:

- **Re-enable the rate limiter** (currently disabled on the mini for tailnet use) — set a high `AGENTDASH_RATE_LIMIT_API_MAX`, keep auth/billing/invite limits. Also fix the latent bug where the limiter sits above the `/api` prefix so its `/health` skip never matches (cherry-pick-worthy cleanup).
- **Set `PAPERCLIP_ALLOWED_HOSTNAMES`** to the public host(s).
- **Adopt upstream tenant-isolation security work** (high priority for multi-customer cloud):
  - `bb7978327` — redact passwords/tokens from HTTP error logs (we handle live tokens; do this first).
  - `70357b961` — per-company JWT signing keys (multi-tenant isolation).
  - `05bcd3ce8` — plugin tables get `company_id` FK (tenant isolation).
- **Billing enforcement on:** set `STRIPE_SECRET_KEY` so caps are enforced (Free 1+1, Pro per-seat) — currently bypassed on the mini.

---

## 6. Upstream to adopt (from the 345-behind digest)

Cherry-pick rubric per `doc/UPSTREAM-POLICY.md` (inherited subsystem · bounded · concrete reason).

**Top picks — security + stability (do for launch):**
- `bb7978327` fix(logger): redact passwords/tokens from HTTP error logs — **security, do first.**
- `70357b961` + `05bcd3ce8` per-company JWT keys + plugin tenant FK — **multi-tenant isolation for managed cloud.**
- Heartbeat lock-stability cluster (we've had EPIPE/crash-loop pain): `deef1f479` (release lock on cross-agent reassignment), `d2ef76771` (clear orphan locks on finalize), `d782c4cd5` (prevent zombie run coalescing + startup reap before timer), `f3db7b88e` (clear stale checkoutRunId + sweeper), `058381349` (don't reuse sessionId across adapter swap). **Verify conflicts** — `heartbeat.ts` is heavily AgentDash-modified.
- `3701be76f` read-only agent config/skill endpoints shouldn't require `agents:create`; `d7f2f8832` board-member visibility parity; `e1e2cef92` array-form `?status=` filter crash fix — bounded authz/bug fixes.

**Feature to adopt for the self-host SKU:**
- `05ab45225` / `4ad94d0bd` / `398d74609` — self-hostable Kubernetes sandbox provider + runtime images. Foundation for Enterprise BYOC.

**Maybe / watch:** model-selector additions (`393e6f5e6` Fable 5/Mythos 5, `9a48d9210` GPT-5.5), `823c2b115` external adapter overrides.

**Skip:** UI-only (theme/scroll), Railway/gosu/docker-pkg specifics, codex/gemini polish unless we lean on those adapters.

---

## 7. Phased roadmap

**Phase 0 — Harden the managed path (now):** re-enable rate limit (fixed properly), allowed hostnames, Stripe caps on, adopt the 3 security cherry-picks. Pick a public deploy target (Tailscale Funnel for first external pilots → Cloudflare Tunnel on a clockchain subdomain → real cloud).

**Phase 1 — Pricing + billing live:** wire the hybrid model (per-seat platform fee + agent-run allowance/overage) on Stripe; bundled inference metering through OpenRouter/Fireworks; publish tiers. Free → Pro 14-day no-card trial.

**Phase 2 — Managed-cloud GA:** onboarding (sign-up → CoS chat → first hire → invite teammates) on the public managed deployment; the two demos (Atlas Wire, Meridian) as the proof/landing.

**Phase 3 — Enterprise self-host/BYOC:** adopt the upstream K8s sandbox provider; ship self-serve BYOC (Docker → Helm/K8s), BYOK toggle, data-residency story. Target regulated buyers who need the Clockchain receipts for compliance.

---

## 8. Open decisions (need a call)

1. **Agent-run vs per-outcome as the metered unit** — "agent-run" is simplest and already built; "per task completed/per receipt" aligns tighter with the outcome-pricing trend but is harder to meter fairly. Recommend: start with agent-run allowance+overage; revisit per-outcome for specific high-value workflows.
2. **Public host for first external access** — Tailscale Funnel (fastest) vs Cloudflare Tunnel on `app.clockchain.network` vs full cloud deploy. Recommend Funnel for pilots, Cloudflare for the demo/sales motion.
3. **Free-tier inference allowance size** — generous enough to convert, small enough to bound cost. Needs a number once Stripe metering is live.
4. **Heartbeat cherry-picks** — worth the conflict risk on our modified `heartbeat.ts`? Recommend yes, given our crash-loop history, but behind a careful conflict review.
