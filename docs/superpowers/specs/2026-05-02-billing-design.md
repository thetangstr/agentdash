# Subscription + billing — design spec

**Date:** 2026-05-02
**Status:** Approved-pending-review
**Target:** AgentDash v2

---

## 1. Goal

Wire real subscription billing into v2: Free tier with strict caps (1 human, 1 agent), Pro tier per-seat with a 14-day no-card trial, Stripe-backed checkout + portal + webhooks, lenient downgrade behavior. Replace v1's "Stripe-ready stub" with actual revenue plumbing.

---

## 2. Tier definitions

### Free tier
- **1 human user** (the creator).
- **1 agent** (the auto-provisioned Chief of Staff).
- All product features available except those gated by team size or agent count.
- No card required.
- Suitable for solo evaluation, demos, and self-hosted single-seat deployments.

### Pro tier
- **Unlimited humans** (subject to per-seat billing).
- **Unlimited agents.**
- All features.
- Per-seat monthly billing via Stripe.
- 14-day trial on activation, no card required at trial start.

### What Pro **does not** include
- Custom contracts, SSO, audit log, dedicated support — those are an "Enterprise" tier and out of scope for v1. Add when a customer asks. Per UPSTREAM-POLICY framing: don't build Enterprise infra speculatively.

---

## 3. Pricing

### Per-seat, billed monthly

- **Pro: $39 / human / month** (placeholder — pricing decision lives outside this spec; the spec just specifies the *mechanism*).
- The CoS agent is included in every seat. Direct-report agents are unmetered (they're the value, not the cost).
- Annual pricing not in v1 — billing is monthly only.

### Why per-seat (not flat-per-company)

A small team feels good about $39/seat × 3 = $117/mo. The same team feels priced-out by a $499/mo flat. Per-seat scales with the value (team size). It also lets us land a single-buyer Pro account ($39/mo) and grow it organically as they invite teammates — fits the multi-human-during-onboarding flow.

### What Stripe sees

One Stripe `Subscription` per company. The subscription has a single `Price` line with `recurring.interval=month` and `quantity=N` where N is the number of human users in the company. We update `quantity` via `subscriptions.update` whenever a user joins or leaves.

---

## 4. Trial

### 14-day Pro trial, no card required at start

When a Free user clicks "Upgrade to Pro" in the UI:
1. We create a Stripe `Customer` for the company (if not already present) and a `Subscription` with `trial_period_days=14` and `payment_settings.payment_method_collection=if_required`.
2. The company is **immediately upgraded to Pro entitlement** for the duration of the trial — no Free caps enforced.
3. They can invite teammates and hire agents. Stripe's `quantity` updates as users join.
4. On day 12, Stripe sends `customer.subscription.trial_will_end` (3 days before; we configure `trial_settings.end_behavior.missing_payment_method=cancel`). We send an in-app + email reminder asking them to add a card.
5. On day 14:
   - If a card was added: the trial ends, Stripe charges the prorated month, subscription status becomes `active`, no entitlement change.
   - If no card was added: the trial ends, subscription is automatically canceled by Stripe (per `missing_payment_method=cancel`), entitlement reverts to Free. We hit the **lenient downgrade** path (§ 6).

---

## 5. Entitlement model

### Single source of truth: `companies.plan_tier`

| Column | Values | Set by |
|---|---|---|
| `companies.plan_tier` | `free`, `pro_trial`, `pro_active`, `pro_canceled` | Stripe webhook handler (only) |
| `companies.plan_seats_paid` | integer (the Stripe `quantity`) | Stripe webhook handler |
| `companies.plan_period_end` | timestamptz | Stripe webhook handler |

Application code reads `plan_tier`. **Application code never writes it.** The Stripe webhook is the only writer; this guarantees a single mutation point and prevents drift between Stripe state and our DB.

### Caps enforced

- `pro_trial` and `pro_active`: no caps enforced.
- `free` and `pro_canceled`: caps enforced at write paths:
  - **Invite teammate** → if current human count ≥ 1 and tier is `free`/`pro_canceled`, return `402 Payment Required` with `code: "seat_cap_exceeded"`. UI surfaces an upgrade prompt.
  - **Hire agent** (any path: onboarding `agent/confirm`, MAW agent-hire, etc.) → if current agent count ≥ 1 and tier is `free`/`pro_canceled`, return `402` with `code: "agent_cap_exceeded"`.

### `requireTier` middleware

A small middleware that wraps any route requiring Pro:

```typescript
function requireTier(min: "free" | "pro"): RequestHandler;
```

Most product features are available on Free. Only the two write-path caps (invite, hire) call `requireTier` directly; the rest of the surface is open.

---

## 6. Downgrade behavior — lenient

When a Pro company drops back to `free` or `pro_canceled` (trial expired without card, customer canceled, payment failed):

1. **Existing data stays.** Humans, agents, conversations, history — all preserved. Nothing deleted.
2. **Existing humans keep access.** A 5-person Pro team that downgrades to Free still has 5 humans active in their workspace. They can chat with CoS and direct reports as before.
3. **Existing agents keep running.** Reese keeps doing outbound; the org chart is unchanged.
4. **Future writes are blocked at caps.**
   - Inviting a 6th human → 402.
   - Hiring a 2nd direct-report agent → 402.
5. **CoS posts a chat message** explaining the state: *"Your Pro subscription ended. Everyone keeps working, but new invites and new agents need an active subscription. [Reactivate Pro →]"*

This is intentionally generous. The spec values not-punishing-users over revenue extraction at the moment of churn.

### Why not strict (revoke access, pause agents)?

- Punishing users at the moment of churn is the worst time to be punishing — they're already disappointed. Lenient downgrade leaves the door open for re-upgrade.
- Strict downgrade adds significant complexity (what happens to in-flight work? to scheduled routines? to the chat thread?) and we don't need it for v1.

---

## 7. Stripe integration scope

### What Stripe owns
- The customer record.
- The subscription (with `trial_period_days`, `quantity`, status).
- The payment method.
- The invoice + receipt emails.
- The hosted checkout page.
- The hosted customer portal (manage card, see invoices, cancel).

### What we own
- Mapping `customerId` ↔ `companyId` (in DB).
- Updating `quantity` when humans join/leave.
- Reacting to webhooks to keep `companies.plan_tier` in sync.
- The "Upgrade to Pro" button in the UI that creates a checkout session.
- The "Manage subscription" button that creates a customer portal session.

### Webhook events handled

| Event | Action |
|---|---|
| `customer.subscription.created` | Set `plan_tier = pro_trial`; store `subscriptionId`, `customerId` on company; set `plan_period_end` |
| `customer.subscription.updated` | Re-derive tier from subscription `status`; update seat count from `quantity` |
| `customer.subscription.deleted` | Set `plan_tier = pro_canceled` (does not delete the subscription record on our side; we keep the audit) |
| `invoice.paid` | Log the invoice; bump `plan_period_end`; if previously `past_due`, return to `pro_active` |
| `invoice.payment_failed` | Log; do not change `plan_tier` until Stripe finalizes (i.e., `subscription.updated` will follow with `status: past_due` or `canceled`) |
| `customer.subscription.trial_will_end` | Send the 3-day trial-ending reminder (in-app + email) |

All other webhook event types are acknowledged with 200 and ignored.

### Webhook security

- Verify signature with `STRIPE_WEBHOOK_SECRET` on every request — reject 400 if invalid.
- Idempotency: use Stripe's `event.id` as a unique key in a `stripe_webhook_events` table (insert on receipt, primary-key conflict = already processed = no-op + 200).

### Environment + config

| Env var | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Server-side Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `STRIPE_PRO_PRICE_ID` | The Stripe `Price` row for the Pro per-seat plan |
| `STRIPE_TRIAL_DAYS` | Override the 14-day default if needed |
| `BILLING_PUBLIC_BASE_URL` | Callback domain for checkout success/cancel |

---

## 8. Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/billing/checkout-session` | Create a Stripe checkout session for the current company; return the `url` |
| `POST` | `/api/billing/portal-session` | Create a customer-portal session for the current company; return the `url` |
| `POST` | `/api/billing/webhook` | Stripe webhook receiver |
| `GET` | `/api/billing/status` | Return `{ tier, seatsPaid, periodEnd }` for the current company |

Authentication: checkout/portal/status require board user; webhook is public but signature-verified.

---

## 9. UI surfaces (v1, before redesign sub-project)

### "Upgrade to Pro" prompts
- In CoS chat, on `seat_cap_exceeded` or `agent_cap_exceeded` errors, render an inline card: *"You're on the Free tier. [Start Pro trial →]"*. Click → opens the checkout-session URL.
- In a `Settings → Billing` page (small, standalone): show current tier, seat count, period end, "Manage subscription" button (opens portal session), and "Start Pro trial" button if on Free.

### Trial countdown
- After Pro trial activation: a small dismissible banner at the top of the chat panel: *"Pro trial — 14 days left. [Add payment method]"*. Updates daily.

The full UI redesign (Claude design) sub-project will style these; v1 is functional only.

---

## 10. Architecture units

| Unit | Responsibility | Interface |
|---|---|---|
| `billing-service` | Create checkout sessions, portal sessions, status reads | `createCheckout(companyId)`, `createPortal(companyId)`, `getStatus(companyId)` |
| `stripe-webhook-handler` | Verify signature, route to event-specific handlers, idempotency | `handle(rawBody, signature): { processed: boolean }` |
| `entitlement-sync` | Per-event handlers that update `companies.plan_tier` and friends | `onSubscriptionCreated(sub)`, `onSubscriptionUpdated(sub)`, `onSubscriptionDeleted(sub)`, `onInvoicePaid(inv)` |
| `seat-quantity-syncer` | Listen for membership changes; update Stripe `quantity` | `onMembershipChanged(companyId)` |
| `requireTier` middleware | Express middleware that returns 402 when caps are hit | `requireTier(min: "free" | "pro")` |
| `billing-status-cards` (UI) | Inline upgrade prompts and trial countdown | React components |
| `BillingPage` (UI) | Settings → Billing page | Single page route |

---

## 11. Schema additions

```sql
ALTER TABLE companies
  ADD COLUMN plan_tier            VARCHAR(32) NOT NULL DEFAULT 'free',
  ADD COLUMN plan_seats_paid      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN plan_period_end      TIMESTAMPTZ,
  ADD COLUMN stripe_customer_id   VARCHAR(64),
  ADD COLUMN stripe_subscription_id VARCHAR(64);

CREATE INDEX companies_plan_tier_idx ON companies (plan_tier);

CREATE TABLE stripe_webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      VARCHAR(128) NOT NULL UNIQUE,  -- stripe's event.id
  event_type    VARCHAR(128) NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`stripe_webhook_events` is the idempotency ledger. The unique constraint on `event_id` is the safety net.

---

## 12. Failure paths

| Scenario | Behavior |
|---|---|
| Webhook signature invalid | 400, do not store, do not process |
| Webhook event type unhandled | 200, store in ledger (so we know we received it), no-op |
| Stripe API down when creating checkout | 503, surface "Try again in a moment" in UI; do not retry from server |
| Subscription update arrives before subscription create (clock skew) | The `entitlement-sync.onSubscriptionUpdated` handler is idempotent — if the company has no subscription yet, it sets the same fields create would |
| Webhook duplicates (Stripe retries) | `event_id` unique constraint causes insert to fail; handler treats as no-op + 200 |
| Trial expires + we miss the webhook | A daily reconciliation cron compares `companies.plan_period_end` against `now()`; for any tier=`pro_trial` past period_end, fetch Stripe subscription state and re-sync |
| User upgrades while another webhook is processing | Insert ordering is serialized by company FK; `plan_tier` reflects the latest event by `processed_at` |

---

## 13. Testing plan

### Unit
- `entitlement-sync` handlers: each event type produces the right DB delta on a canned Stripe payload. Idempotent on duplicate event_id.
- `requireTier` middleware: returns 402 with the right error code at each cap; passes through on Pro.
- `seat-quantity-syncer`: when membership goes from 3 → 4, fires `subscriptions.update` with `quantity: 4`.

### Integration
- Full flow: POST `/api/billing/checkout-session` returns a URL. Simulate Stripe webhook for `customer.subscription.created`. `companies.plan_tier` becomes `pro_trial`. POST a third invite — succeeds (Pro has no cap).
- Cancel flow: simulate `customer.subscription.deleted`. `plan_tier` becomes `pro_canceled`. POST a 6th invite — returns 402 with `seat_cap_exceeded`. Existing 5 humans still have access.

### E2E (manual or Playwright with Stripe CLI)
- Sign up, click Upgrade → land on Stripe checkout (use Stripe CLI `stripe trigger` to simulate). Verify post-checkout state.

---

## 14. Out of scope (deferred)

- **Annual billing.** Monthly only in v1.
- **Multiple Pro tiers** (Pro Plus, Pro Team, etc.). One Pro is enough until pricing is contested.
- **Custom contracts / Enterprise.** Add when a customer asks.
- **In-product upgrade UX beyond chat cards + Settings page.** The redesign sub-project handles polish.
- **Refunds, prorations on plan changes.** Stripe handles this; we trust their math.
- **Invoicing for non-credit-card customers.** Stripe handles invoicing; not a custom flow.
- **Per-deployment ("self-hosted") billing.** Free is local-trusted; Pro requires the SaaS deployment. Self-hosted Pro pricing is a future question.

---

## 15. Decision log

| Decision | Choice | Source |
|---|---|---|
| Tier structure | Free + Pro (no Enterprise) | Brainstorm Q1 (option A — accepted by deferral) |
| What Pro unlocks | Multi-human invites + agent count cap lifted | Brainstorm Q2 (option B) |
| Pricing model | Per-seat, monthly | Default in spec, accepted |
| Trial | 14 days, no card at start, Stripe-managed `trial_period_days` | Default in spec, accepted |
| Stripe integration scope | Checkout + portal + 6 webhook events | Default in spec, accepted |
| Downgrade behavior | Lenient (existing access preserved, future writes capped) | Default in spec, accepted |
| Caps on Free | 1 human, 1 agent (CoS only) | Tier definitions § 2 |
| `plan_tier` writer | Stripe webhook only (single mutation point) | Default in spec |
