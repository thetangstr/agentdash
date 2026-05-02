# Launch checklist

How to take AgentDash from a clean clone to your first paying customer. Read top-to-bottom; the steps are ordered by dependency.

The local-trusted dev experience (`pnpm dev` → `localhost:3100/cos`) needs none of this. Everything below is for a real cloud deployment with a real signed-up user paying through Stripe.

---

## 1. Pick a cloud host and provision Postgres

The repo's [Dockerfile](../Dockerfile) is the source of truth for the runtime. Production assumes you supply an external Postgres via `DATABASE_URL` — the embedded Postgres is a dev convenience and is not appropriate for cloud deployment. Pick any of:

- **Railway** — easy, has a one-click managed Postgres add-on. Point at the Dockerfile, attach Postgres, set env vars below.
- **Fly.io** — `fly launch` will detect the Dockerfile. Use Fly Postgres or any external provider.
- **Render** — paste the Dockerfile in, attach Render Postgres.
- **Anywhere else** — same pattern. The container exposes port 3100; point your platform's HTTPS terminator at it.

**Required infra:**
- 1 container running the AgentDash Dockerfile
- 1 managed Postgres database (any version Drizzle supports — Postgres 14+)
- A public HTTPS URL for the container (will become `PAPERCLIP_AUTH_PUBLIC_BASE_URL` and `BILLING_PUBLIC_BASE_URL`)

---

## 2. Set the deployment-mode env vars

These flip the server out of `local_trusted` (no auth) into real auth-required mode.

| Var | Value | Why |
|---|---|---|
| `PAPERCLIP_DEPLOYMENT_MODE` | `authenticated` | Stops auto-promoting the synthetic local-board user; forces real sign-in. |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `public` | Tells the server it's reachable from the public internet (loosens loopback-only checks; tightens the hostname allow-list). |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | `https://your-domain.com` | The canonical public URL of the app. Used as the auth callback origin and to build the hostname allow-list. |
| `BETTER_AUTH_SECRET` | a 32+ char random string (`openssl rand -hex 32`) | Signs Better Auth session JWTs. **Don't lose it** — rotating it logs everyone out. |
| `DATABASE_URL` | `postgres://user:pass@host:5432/agentdash` | Your managed Postgres connection string. |

Without `BETTER_AUTH_SECRET` the server crashes on first start in authenticated mode.

---

## 3. Set up Stripe (Pro tier)

The billing code already lives at [server/src/routes/billing.ts](../server/src/routes/billing.ts) and mounts at `/api/billing/*`. You need to provision the Stripe side and hand the keys to the server.

**In the Stripe dashboard:**

1. Create a **Product** named "AgentDash Pro".
2. Add a recurring **Price** ($X/seat/month — your call). Copy the price ID (`price_...`).
3. Configure a **Webhook endpoint**:
   - URL: `https://your-domain.com/api/billing/webhook`
   - Events to send: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.payment_failed`
   - Copy the signing secret (`whsec_...`).
4. Get your **secret key** from Developers → API keys (`sk_live_...` for production, `sk_test_...` for staging).

**Set on the container:**

| Var | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…` if you're staging) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 3 |
| `STRIPE_PRO_PRICE_ID` | `price_…` from step 2 |
| `STRIPE_TRIAL_DAYS` | `14` (or whatever you negotiate per customer) |
| `BILLING_PUBLIC_BASE_URL` | `https://your-domain.com` (where Stripe redirects after checkout) |

**Tier semantics today** (enforced by [server/src/middleware/require-tier.ts](../server/src/middleware/require-tier.ts)):
- **Free:** 1 human + 1 agent (CoS only)
- **Pro:** unlimited humans + agents

When `STRIPE_SECRET_KEY` is unset the server falls back to a stub that returns 503 on checkout/portal/webhook, and `requireTier` bypasses caps entirely so dev still works.

---

## 4. Set the LLM key

CoS chat (`/cos`) uses Claude. Without the key, the server returns a stub reply.

| Var | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` from console.anthropic.com |

Costs are minimal at chat scale — the system prompt is cached (`cache_control: ephemeral`), so each repeat turn within a conversation is ~10% the input cost of the first.

Real LLM-powered **agent execution** (the "hire an agent and have it actually do work" flow) is a separate path through the adapter system and is **not** wired in v2 yet. The CoS chat is the only Claude-call surface today.

---

## 5. Deploy and smoke-test

After the container boots:

1. Visit `https://your-domain.com/` — should render the AgentDash marketing landing on cream surface.
2. Visit `/auth?mode=sign_up` — sign up with a real corporate email. (Free-mail addresses like gmail.com / yahoo.com are blocked at signup time on Pro per [server/src/middleware/corp-email-signup-guard.ts](../server/src/middleware/corp-email-signup-guard.ts) — that's deliberate, not a bug. Use a domain you own.)
3. After verifying the email, you should land in the dashboard with a workspace named after your email domain.
4. Click into `/cos` and send a message — you should get a real Claude reply within ~2s.
5. Try `/{prefix}/billing` and click upgrade — Stripe Checkout should open with the 14-day trial. Use a real card (Stripe handles fraud protection).
6. Watch the container logs while the webhook fires after card-on-file — you should see `customer.subscription.created` processed and the company's `planTier` flip to `pro_trial` in the DB.

If any of those steps fail, check the container logs and the [server/src/services/companies.ts](../server/src/services/companies.ts) projection for the row state.

---

## 6. Things deliberately out of scope for v2 launch

If you find these missing, it's not an oversight — they were dropped from v2 by design (see [doc/UPSTREAM-POLICY.md](UPSTREAM-POLICY.md)):

- CRM / HubSpot integration
- Action Proposals + Policy Engine
- Pipeline Orchestrator, Budget+Capacity, Skills Registry workflow
- Smart Model Routing
- v1's WelcomePage onboarding (replaced by `/cos` + `OnboardingRoutePage`)
- Real LLM wired for agent **execution** (chat is wired; agent runtimes still stub via the adapter shim — wire when you have a real customer ask)

---

## TL;DR env-var matrix

```sh
# Deployment
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://your-domain.com

# Auth + DB
BETTER_AUTH_SECRET=<openssl rand -hex 32>
DATABASE_URL=postgres://user:pass@host:5432/agentdash

# LLM
ANTHROPIC_API_KEY=sk-ant-…

# Stripe (Pro tier)
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRO_PRICE_ID=price_…
STRIPE_TRIAL_DAYS=14
BILLING_PUBLIC_BASE_URL=https://your-domain.com
```

That's it. With those eight vars and a Postgres connection string, AgentDash launches.
