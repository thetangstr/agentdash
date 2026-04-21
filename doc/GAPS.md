# AgentDash — Production Gaps

Living document of what's stubbed, missing, or unfinished on the path to a paying-customer release.
Last updated: 2026-04-20.

Categories: **P0** = blocks revenue / launch · **P1** = needed soon · **P2** = nice-to-have.

---

## Billing & Subscription (P0)

**Status:** ✅ Phase 1 ("Monetization Unlock") landed in `feat/v1-completion-phase-1`. Stripe wired end-to-end (provider, webhooks, audit log, self-serve upgrade). Setup steps: `doc/STRIPE-SETUP.md`. Implementation plan: `.omc/plans/2026-04-20-monetization-unlock-impl.md`.

| Surface | Status | Location |
|---|---|---|
| Three-tier matrix (free/pro/enterprise) limits + features | ✅ Real | `packages/shared/src/entitlements.ts` |
| `companyPlan` table with stripe + status columns | ✅ Real | `packages/db/src/schema/plans.ts` |
| `requireTier` middleware (returns 402) | ✅ Real | `server/src/middleware/require-tier.ts` |
| GET/PATCH `/entitlements` (now exposes billing state) | ✅ Real | `server/src/routes/entitlements.ts` |
| Billing UI (tier + limits + portal + renewal date) | ✅ Real | `ui/src/pages/Billing.tsx` |
| `BillingProvider` interface | ✅ Real | `packages/billing/src/index.ts` |
| `StubBillingProvider` (dev fallback) | ✅ Real | `packages/billing/src/index.ts` |
| `StripeBillingProvider` | ✅ Real | `packages/billing/src/stripe-provider.ts` |
| `createBillingProvider()` factory (env-driven) | ✅ Real | `packages/billing/src/index.ts` |
| Checkout session endpoint | ✅ Real | `server/src/routes/billing.ts` |
| Customer portal session endpoint | ✅ Real | `server/src/routes/billing.ts` |
| Stripe webhook handler (6 event types) | ✅ Real | `server/src/services/billing.ts` |
| `billing_events` audit + idempotency table | ✅ Real | `packages/db/src/schema/billing_events.ts` |
| Self-serve "Upgrade" flow → Stripe Checkout | ✅ Real | `ui/src/components/UpgradeDialog.tsx` |
| "Manage Subscription" → Stripe Customer Portal | ✅ Real | `ui/src/pages/Billing.tsx` |
| Marketing site at `agentdash.com` (pricing + signup CTA) | ✅ Real (deploy pending) | `marketing/` |
| Stripe products + price IDs created in Dashboard | ⚠️ Manual setup | see `doc/STRIPE-SETUP.md` |
| Webhook endpoint registered in Stripe Dashboard | ⚠️ Manual setup | see `doc/STRIPE-SETUP.md` |
| Marketing site deployed to Vercel | ⚠️ Pending | `marketing/` |
| Usage metering / overage tracking | ❌ Phase 2+ | — |
| Invoice / receipt rendering | ❌ Phase 2+ (use Stripe-hosted) | — |
| Dunning / payment retry flow | ⚠️ Stripe handles automatically | — |
| Annual pricing | ❌ Open question (monthly only today) | — |

---

## Distribution / Packaging (P0)

**Status:** Direction chosen — stacked-lane architecture (hosted SaaS + self-host runner + BYOC). See `.omc/specs/deep-interview-agentdash-gtm-tech-deployment.md` for full spec.

**Architecture (decided 2026-04-20):**
- **Lane 1 — Hosted (per-tenant cloud workspace):** Coder / Daytona / Fargate gives each customer a Linux container; CLIs run server-side with BYOK API keys. Zero install for customer.
- **Lane 2 — Self-host runner:** Tiny `agentdash-runner` daemon on customer hardware, tunnels to hosted control-plane.
- **Lane 3 — BYOC:** Terraform module deploys full AgentDash into customer's AWS account.
- All three share one REST API, one CLI, one UI shell, one tier model. **No feature compromise between lanes.**

**Dropped:** Mac mini-only appliance, browser-only thin client, source-hiding via Electron wrapping.

**Build sequence (6 months, ~30–35 engineer-weeks):**
1. **Phase 1 (wks 1–6):** Stripe wiring + marketing site + self-serve signup — unlocks first paying customer
2. **Phase 2 (wks 7–18):** Hosted lane (workspace provisioner, BYOK vault, lifecycle)
3. **Phase 3 (wks 19–22):** Self-host runner daemon
4. **Phase 4 (wks 23–26):** BYOC Terraform module

See spec for full acceptance criteria and open decisions (workspace platform, runner language, marketing stack, etc.).

---

## Auth & Identity (P1)

- No SSO (SAML / OIDC) — board sessions only
- No SCIM provisioning
- No org-level audit log export
- 2FA / WebAuthn not wired
- Password reset flow uses dev-mode link logging

---

## Observability (P1)

- Activity log table exists; no aggregated dashboard
- No usage metering for billing inputs (action count, agent-hour)
- No error tracking integration (Sentry/Datadog)
- No structured tracing for agent runs across adapter boundaries

---

## Operations (P1)

- No managed Postgres connection (embedded only for dev)
- No backup / restore tooling for company data
- No tenant-isolation hardening for shared deployment mode
- Migration rollback not exercised in CI

---

## Source Code Protection (open design question)

See companion answer in chat thread. TL;DR options + tradeoffs to be documented here once we pick a distribution model.

---

## How to use this doc

- Add a row when you discover a stub / TODO / "Phase N" marker
- Update status when work lands; don't delete — strike through and note PR
- Link out to GitHub issues / Linear tickets once filed
