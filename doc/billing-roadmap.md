# Billing & subscription roadmap

**Status:** Backend ~95% complete · Frontend ~30% complete · Customer cannot self-serve buy today
**Last updated:** 2026-05-12
**Owner:** TBD
**Source spec:** [`docs/superpowers/specs/2026-05-02-billing-design.md`](../docs/superpowers/specs/2026-05-02-billing-design.md)

---

## TL;DR

The Stripe plumbing — webhooks, tier model, seat sync, trial reconcile cron, requireTier middleware, BillingPage component — has all shipped (PRs #150, #197–#203, #244). **The frontend is missing every connecting piece** between the user and that plumbing: the billing page is orphaned (no sidebar link), three pre-built UI components are never mounted, and downgrade / payment-failure events fire on the server but produce no in-product notification. Net effect: **a paying customer cannot find the billing page to start a trial, and an existing customer cannot tell when their card has failed.**

This doc sequences the 8 open billing FRs into a path to "billing is shippable to first paying customer."

## What ships today

### ✅ Backend (95%)

| Capability | Status | Source |
|---|---|---|
| Tier model: `free` / `pro_trial` / `pro_active` / `pro_canceled` / `pro_past_due` | Complete | PR #198, #201 |
| 14-day Pro trial via Stripe `trial_period_days` | Complete | PR #198 |
| 4 routes: `POST /checkout-session`, `POST /portal-session`, `GET /status`, `POST /webhook` | Complete | `server/src/routes/billing.ts` |
| Stripe webhook signature enforcement | Complete | PR #202 |
| Webhook idempotency ledger (`stripe_webhook_events`) | Complete | PR #198 |
| `requireTier` middleware on invite + agent-hire | Complete | PR #198 |
| `seatQuantitySyncer` wired to membership-change paths (3 callsites) | Complete | `server/src/routes/access.ts` |
| `billingReconcile` cron for missed trial expirations (hourly) | Complete | PR #198 |
| Webhook handlers for `subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `trial_will_end`, `past_due` | Complete | PR #201 |
| Lenient downgrade — data preservation | Complete | PR #198 |
| `BillingPage.tsx` component | Built (orphaned) | `ui/src/pages/BillingPage.tsx` |
| `TrialBanner.tsx` component | Built (never mounted) | `ui/src/components/TrialBanner.tsx` |
| `UpgradePromptCard.tsx` component | Built (never mounted) | `ui/src/components/UpgradePromptCard.tsx` |

### ❌ What's missing

8 open issues. **Two clusters**: (a) **discoverability + UI mount**, (b) **state-transition notifications**.

## The 8 open FRs

| # | Title | Severity | Cluster | Effort |
|---|---|---|---|---|
| [#248](https://github.com/thetangstr/agentdash/issues/248) | BillingPage at `/billing` is orphaned — no sidebar / settings link | **HIGH** | Discoverability | XS (~30 min) |
| [#208](https://github.com/thetangstr/agentdash/issues/208) | TrialBanner built but never mounted | MED | UI mount | XS |
| [#224](https://github.com/thetangstr/agentdash/issues/224) | UpgradePromptCard built but never mounted | MED | UI mount | S |
| [#250](https://github.com/thetangstr/agentdash/issues/250) | `pro_past_due` tier has no UI surface | MED | UI mount | S |
| [#251](https://github.com/thetangstr/agentdash/issues/251) | BillingPage ignores `?session=success/cancel` checkout callback | MED | UI polish | XS |
| [#211](https://github.com/thetangstr/agentdash/issues/211) | `trial_will_end` webhook only logs to activity — no in-app + email reminder | MED | Notifications | S |
| [#249](https://github.com/thetangstr/agentdash/issues/249) | No CoS chat-message on Pro→Free downgrade (spec §6.5) | MED | Notifications | M |
| [#169](https://github.com/thetangstr/agentdash/issues/169) | `onInvoicePaid` no-op — local billing state not refreshed on successful payment | MED | Notifications | S |

**Total estimate:** ~1–2 dev-days as a single focused PR-week. Could ship the entire billing UI cluster in one milestone.

## Dependency graph

```
                                #248 (sidebar link)
                                ─────────────────────
                                  ↓ unblocks every
                                  ↓ other UI gap by
                                  ↓ making the page
                                  ↓ reachable
                ┌─────────────────┴──────────────────┐
                ↓                                    ↓
        #251 (checkout callback)             #208 (TrialBanner mount)
        ─────────────────────────            ────────────────────────
        ↓ webhook race UX                    ↓ tied to #211 (reminder copy
        ↓ — pairs naturally with             ↓ stays consistent across
        ↓ a successful upgrade               ↓ banner + email)
        ↓                                    ↓
        ─────────────────────────            ────────────────────────
                                                        ↓
                                                #224 (UpgradePromptCard mount)
                                                ──────────────────────────────
                                                ↓ inline cap-exceeded errors;
                                                ↓ unblocks Free→Pro chat-driven
                                                ↓ conversion from inside CoS
                                                ↓
                                                ──────────────────────────────
                                                        ↓
                                                #250 (pro_past_due UI)
                                                ───────────────────────
                                                ↓ requires #208 (banner
                                                ↓ infra) AND #224 (cap-error
                                                ↓ copy variants)
                                                ↓
                                                ───────────────────────
                                                        ↓
                                #249 (CoS downgrade chat)        #211 (trial reminder)
                                ──────────────────────────       ──────────────────────
                                ↓ requires #248 deep-link        ↓ in-app reminder
                                ↓ for the [Reactivate Pro →]     ↓ uses #208 banner +
                                ↓ button to land somewhere       ↓ adds email channel
                                ↓                                ↓
                                ──────────────────────────       ──────────────────────
                                                        ↓
                                                #169 (onInvoicePaid no-op)
                                                ──────────────────────────
                                                ↓ pure backend; can land
                                                ↓ in parallel any time
```

### Concrete ordering (recommended)

**Wave 1 — Make billing reachable (1 PR, ~2 hours):**
1. **#248** — sidebar link + settings tab → BillingPage. Without this, every other UI fix is invisible.

**Wave 2 — Mount the orphaned components (1 PR, ~1 day):**
2. **#208** — Mount TrialBanner at top of CoS conversation when `tier === pro_trial`
3. **#224** — Mount UpgradePromptCard inline on `seat_cap_exceeded` / `agent_cap_exceeded` errors in the chat composer + new-agent dialog
4. **#250** — Add `pro_past_due` rendering to TrialBanner + BillingPage + UpgradePromptCard variants
5. **#251** — Read `?session=success/cancel` query param, show toast, retry status fetch through webhook race

**Wave 3 — Wire state-transition notifications (1 PR, ~1 day):**
6. **#249** — On `pro_active` → `pro_canceled` (and `→ pro_past_due`), have CoS post a downgrade chat message with deep link to /billing
7. **#211** — On `trial_will_end` webhook, fan out in-app notification (using same notification infra CoS uses for proactive cards) + Resend email

**Wave 4 — Cleanup (parallelizable):**
8. **#169** — Wire `onInvoicePaid` to refresh local billing state, invalidate `billingApi.status` cache on the WS bus

## Acceptance criteria for "billing is shippable to first paying customer"

A first-time user must be able to, end-to-end, **without typing any URLs or contacting support**:

- [ ] Discover the billing page from the sidebar (#248)
- [ ] See their current plan + trial countdown anywhere they spend time (#208)
- [ ] Hit a cap → see a friendly upgrade CTA inline in CoS chat (#224)
- [ ] Click "Start Pro trial" → complete Stripe checkout → see a success toast and instant tier update (#251)
- [ ] Day 11 of trial → receive a reminder email AND see an in-app banner asking to add a card (#211, #208)
- [ ] Card fails → see a CoS chat message + banner explaining what happened and how to fix it (#249, #250)
- [ ] Fix card → next webhook bumps tier back to `pro_active`, banner clears, no manual reload required (#169)

When all 8 issues land, that flow works. Today, none of those steps work end-to-end.

## What's intentionally NOT in scope

These are deferred per the spec or by judgment; **do not file new issues** unless requirements change:

- **Annual billing.** Spec §14 — monthly only in v1.
- **Multiple Pro tiers** (Pro Plus, Pro Team). Spec §14 — one Pro is enough until pricing is contested.
- **Custom contracts / Enterprise** (SSO, audit log, dedicated support). Spec §2.
- **Refunds / prorations on plan changes.** Stripe handles this; we trust their math.
- **In-app invoice list.** Stripe customer portal owns invoice display per spec §7.
- **Cancel-from-inside-app button.** Stripe portal owns the cancel flow per spec §7.
- **Self-hosted Pro pricing.** Free is local-trusted; Pro requires SaaS deployment.
- **Per-seat pricing for agents.** Direct-report agents are unmetered (the value, not the cost) per spec §3.

## Risks & open questions

1. **Stripe webhook race on checkout success.** Even with #251's retry-on-stale, there's a ~1-3s window where the user sees Free tier after Stripe redirects them post-trial-activation. The retry hides it most of the time, but on slow webhook delivery the user may see a brief flicker. Acceptable for v1; revisit if support tickets surface it.
2. **Past-due UX timeline is forgiving.** Stripe retries failed payments 4× over 21 days before final cancellation. During that window the user is in `pro_past_due` and capped on writes. A user with a stale card may experience 3 weeks of confusing "everything works except invite/hire" if they don't read banners. Mitigation: aggressive in-app banner (#250) + email cadence (#211 follow-up).
3. **Multi-human company billing.** Per-seat sync via `seatQuantitySyncer` is wired, but no UI shows "your team is N humans, billed at $39 × N = $X/mo." Worth adding to BillingPage in Wave 2 if we have spare capacity (currently uncovered by any open FR).
4. **Stripe portal returns user to current path, not /billing.** Verify the portal session's `return_url` lands sensibly; not currently covered by any open FR.

## Related docs

- [`docs/superpowers/specs/2026-05-02-billing-design.md`](../docs/superpowers/specs/2026-05-02-billing-design.md) — the canonical billing spec
- [`doc/UPSTREAM-POLICY.md`](./UPSTREAM-POLICY.md) — billing is 100% AgentDash, not inherited
- [`doc/LAUNCH.md`](./LAUNCH.md) — Stripe env-var setup for first paying customer
- [`CLAUDE.md`](../CLAUDE.md) — billing bypass `AGENTDASH_BILLING_DISABLED=true` for dev
