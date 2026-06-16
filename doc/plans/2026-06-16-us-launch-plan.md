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

### 4a. The access/exposure ladder (external-service requests fold in here)

"Give person X access" and "how do we host/deploy" are the **same ladder** — each rung is how an external party reaches an AgentDash instance, in increasing reach/control. External-access requests are served by picking the right rung, not by a separate mechanism.

| Rung | Mechanism | Reach | Use it for | Guardrails |
|------|-----------|-------|------------|------------|
| 0 | Tailnet-only (`tailscale serve`) | People on our tailnet | Internal dev / our own use | Tailnet ACLs |
| 1 | **Tailscale Funnel** (`tailscale funnel`) | Anyone with the URL | Quick external pilots, one-off viewers, demos | Login-gated + per-company membership + rate limit + `PAPERCLIP_ALLOWED_HOSTNAMES` |
| 2 | Cloudflare Tunnel + Access on a `*.clockchain.network` subdomain | Public, custom domain | Ongoing customer-facing access, per-person email allowlist in front of app auth | CF Access OTP + app auth + WAF |
| 3 | Managed cloud deploy | Public SaaS | GA managed SKU (Free/Pro) | Full prod hardening + Stripe caps |
| 4 | BYOC / on-prem (Docker → K8s sandbox provider) | Customer's own cloud | Enterprise / regulated | Customer-owned infra; we ship control plane |

**Current state (2026-06-16):** Rung 1 is **live** — the mini is funneled at `https://mac-mini.tail112187.ts.net/` for external pilots (login-gated, rate limit re-enabled at `API_MAX=10000`, hostname allow-listed). This is the pilot path; Rung 2 (Cloudflare on a clockchain subdomain) is the next step for anything customer-facing, and Rungs 3–4 are the GA SKUs. **An external-access request = "which rung, and add their membership," nothing bespoke.**

**Instance separation (2026-06-16):** the mini now runs **two** instances — `:3100` PUBLIC (funnel) with the demo companies (Atlas Wire + Meridian Pay), and `:3200` PRIVATE (tailnet-only) with the 8 internal/work companies. This is the concrete first instance of the strategy: **demos on a public instance, real work on a private one** — which generalizes to "managed cloud (customers) vs private/BYOC (us / enterprise)."

### 4b. Access & identity (how people get into an instance)

Reaching an instance (rungs above) is separate from getting *in*. Identity = **an account + a per-company membership**; a signup with no membership sees nothing (the gate). Roles: `owner`, `admin`, `operator`, **`viewer` (read-only)**, `member`.

Three grant paths (all end with the recipient setting their own password — we never mint shared passwords):
- **Invite by email (product way, default):** board user → `POST /api/onboarding/invites {companyId, emails[], autoApprove:true}` → Resend sends `/invite/<token>` → recipient signs up → auto-member. Scales, audited.
- **Manual membership:** recipient self-signs-up → we add a `company_memberships` row.
- **Shared `viewer` account:** read-only guest on a demo company for hand-out demos.

**Demo guidance:** invite demo lookers as **`viewer`** (read-only — can't mutate the live demo); reserve `member`/`admin` for real collaborators. For the broadest, zero-login demo, point people at the static `clockchain-research /atlas-wire` site; the live funnel instance is for hands-on access. This invite + role-gated membership model **is** the identity layer of the managed SKU.

---

## 5. Security must-dos before any public exposure

Going to market = going public, which changes the threat model from the current private tailnet box:

- **Rate limiter — DONE for the Rung-1 funnel** (re-enabled at `AGENTDASH_RATE_LIMIT_API_MAX=10000`, auth/billing/invite limits intact). Still TODO: fix the latent bug where the limiter sits above the `/api` prefix so its `/health` skip never matches (small code PR).
- **`PAPERCLIP_ALLOWED_HOSTNAMES` — DONE** for the funnel host (`mac-mini.tail112187.ts.net` added).
- **Adopt upstream tenant-isolation security work** (high priority for multi-customer cloud):
  - `bb7978327` redact tokens from logs + `70357b961` per-company JWT keys — **DONE, in PR #403.**
  - `05bcd3ce8` plugin `company_id` FK tenant isolation — **deferred** (migration/`NULLS NOT DISTINCT` index reconciliation on our line; see PR #403 description). Do before multi-customer GA.
- **Billing enforcement on:** set `STRIPE_SECRET_KEY` so caps are enforced (Free 1+1, Pro per-seat) — currently bypassed on the mini. Required before Rung 3 (managed GA).

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
