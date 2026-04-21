# Stripe Setup

Step-by-step guide to wire AgentDash to a real Stripe account. Until these steps are done, the billing layer falls back to `StubBillingProvider` and all checkout calls return `{status:"stubbed"}`.

## 1. Create Stripe products and prices

In the Stripe Dashboard (Test mode first):

1. **Products → + Add product**
   - **AgentDash Pro** — recurring, $99 / month — copy the price ID (`price_xxx`)
   - **AgentDash Enterprise** — recurring, $499 / month — copy the price ID

   These prices match the seed values in `packages/db/src/migrations/0072_seed_plans.sql`. Update the seed if you change the pricing.

2. **Customer portal** → Configure → enable subscription cancellation, plan switching, and payment-method update. Set return URL to `${APP_URL}/billing`.

## 2. Configure webhook

1. **Developers → Webhooks → + Add endpoint**
2. Endpoint URL: `https://<your-app-domain>/api/billing/webhook`
3. Events to send (subscribe to all six):
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `checkout.session.completed`
4. After creating, reveal and copy the **Signing secret** (`whsec_...`).

## 3. Server environment variables

Set on the deployment platform (Railway, Vercel, Fly, etc.):

| Variable | Example | Required |
|----------|---------|----------|
| `STRIPE_SECRET_KEY` | `sk_live_...` (or `sk_test_...`) | Yes |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Yes (prod) |
| `STRIPE_PRICE_MAP` | `{"price_pro_xxx":"pro","price_ent_xxx":"enterprise"}` | Yes |
| `STRIPE_CHECKOUT_SUCCESS_URL` | `https://<your-app-domain>/billing?checkout=success` | No (defaults to `http://localhost:3100/billing?checkout=success`) |
| `STRIPE_CHECKOUT_CANCEL_URL` | `https://<your-app-domain>/billing?checkout=cancel` | No |
| `STRIPE_PORTAL_RETURN_URL` | `https://<your-app-domain>/billing` | No |

Without `STRIPE_SECRET_KEY`, `createBillingProvider()` returns `StubBillingProvider`. This is the desired behavior for local dev.

## 4. Local dev with Stripe CLI

```sh
brew install stripe/stripe-cli/stripe
stripe login
# Forward webhooks to your local server
stripe listen --forward-to localhost:3100/api/billing/webhook
# In another terminal, trigger a test event
stripe trigger checkout.session.completed
```

Set `STRIPE_SECRET_KEY=sk_test_...` and `STRIPE_WEBHOOK_SECRET=whsec_...` (the CLI prints the secret after `stripe listen`) in `.env.local`.

## 5. Smoke test the upgrade flow

1. Sign up / log in to the dashboard as a free-tier user.
2. Go to **Settings → Billing**.
3. Click **Upgrade to Pro**.
4. You should be redirected to Stripe Checkout. Use card `4242 4242 4242 4242` (any future expiry, any CVC).
5. After payment, Stripe redirects back to `/billing?checkout=success`.
6. The webhook fires; `companyPlan.planId` should now be `pro`, `subscriptionStatus = 'active'`, and `currentPeriodEnd` set.
7. Click **Manage Subscription** → opens Stripe Customer Portal.

## 6. Going live

1. Repeat steps 1-3 in Stripe live mode.
2. Set `STRIPE_SECRET_KEY=sk_live_...` and the live webhook secret.
3. Verify the live webhook endpoint receives events (Stripe Dashboard → Webhooks → endpoint → Recent deliveries).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Checkout returns `{status:"stubbed"}` | `STRIPE_SECRET_KEY` not set, or factory returned StubBillingProvider |
| Webhook returns 400 "Invalid signature" | `STRIPE_WEBHOOK_SECRET` mismatch — re-copy from Stripe Dashboard |
| Tier doesn't update after checkout | `STRIPE_PRICE_MAP` doesn't include the price ID the customer purchased |
| `billing_events` table empty | Webhook not reaching the server — check Stripe delivery logs and reverse-proxy |
| 402 from `requireTier` middleware after upgrade | Cache stale — refresh; or `companyPlan.planId` not updated (check webhook logs) |
