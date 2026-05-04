# Launch checklist

How to take AgentDash from a clean clone to your first paying customer. Read top-to-bottom; the steps are ordered by dependency.

The local-trusted dev experience (`pnpm dev` → `localhost:3100/cos`) needs none of this. Everything below is for a real cloud deployment with a real signed-up user paying through Stripe.

> **Cloud container vs bare-metal host.** This doc covers the **cloud container path** — Railway / Fly / Render running the [Dockerfile](../Dockerfile), env vars set through the platform's dashboard. If you're instead running on a bare-metal host you control directly (Mac mini on your LAN, a workstation behind Tailscale, an EC2/Lightsail VM you SSH into), `agentdash setup` is enough — one prompt (pick adapter) and safe defaults for everything else; the founding-user account is created on the dashboard's sign-up form (Better Auth), not in the CLI. The wizard auto-detects Tailscale and picks `bind=tailnet` if available, else falls back to loopback. The Stripe + Anthropic env vars (steps 3–4 below) still apply to the bare-metal path if you want billing + real Claude replies.

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
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `true` | Auto-applies pending Drizzle migrations on boot. Without it, the server interactively prompts (which fails in a headless container) and exits with `Refusing to start against a stale schema`. |

Without `BETTER_AUTH_SECRET` the server crashes on first start in authenticated mode. Without `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, the container exits the first time the schema is stale (every redeploy with new migrations).

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

## 4. Pick how the CoS replies (LLM dispatch)

CoS chat (`/cos`) routes replies through `server/src/services/dispatch-llm.ts` based on the `AGENTDASH_DEFAULT_ADAPTER` env var (which the wizard writes from the user's adapter pick). Three first-class paths:

| Adapter | What it spawns | Required env |
|---|---|---|
| `claude_api` *(default)* | Direct HTTP call to Anthropic's Messages API with prompt caching | `ANTHROPIC_API_KEY=sk-ant-…` |
| `claude_local` | Spawns `claude --print -` with conversation piped to stdin | the `claude` CLI on PATH; auth handled by `claude login` |
| `hermes_local` | Spawns `hermes chat -q "<prompt>" -Q` | the `hermes` CLI on PATH; Hermes manages its own auth via `hermes setup` |

Other adapter picks (`gemini_local`, `codex_local`, `opencode_local`, …) currently fall back to the `claude_api` path with a warning log; they get adapter coverage at agent-execution time, not at CoS-chat time. Without ANY of these, the dispatch falls back to a stub reply (`"Got it. (stub reply — set ANTHROPIC_API_KEY to wire real Claude)"`).

| Var | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` from console.anthropic.com (only needed for `claude_api` path or fallback) |
| `AGENTDASH_DEFAULT_ADAPTER` | `claude_api` / `claude_local` / `hermes_local` / `gemini_local` / `codex_local` / `opencode_local` / `acpx_local` / `cursor` (default `claude_api` if unset) |

Costs for the API path are minimal at chat scale — the system prompt is cached (`cache_control: ephemeral`), so each repeat turn within a conversation is ~10% the input cost of the first.

Real LLM-powered **agent execution** (the "hire an agent and have it actually do work" flow) is a separate path through the adapter system. CoS chat is the only LLM-call surface wired today.

---

## 4b. Email — welcome + password reset (Resend)

After sign-up the server fires a welcome email; on `POST /api/auth/request-password-reset` it sends a templated reset link. Both go through `server/src/auth/email.ts`, which is a fetch-based wrapper over Resend's REST API. With no key set the wrapper logs an info line and silently no-ops — sign-up still succeeds, the user just doesn't get the email.

| Var | Value | Default |
|---|---|---|
| `RESEND_API_KEY` | `re_…` from resend.com/api-keys | unset → no-op |
| `AGENTDASH_EMAIL_FROM` | `AgentDash <noreply@your-domain.com>` (verify the domain at resend.com/domains for production) | `AgentDash <onboarding@resend.dev>` |
| `AGENTDASH_EMAIL_REPLY_TO` | optional reply-to | unset |

Until you verify your own sending domain in Resend, the shared `onboarding@resend.dev` sender will only deliver to the email tied to your Resend account.

---

## 5. Deploy and smoke-test

After the container boots:

1. Visit `https://your-domain.com/` — should render the AgentDash marketing landing on cream surface.
2. Visit `/?mode=sign_up` — sign up with any email. Free-mail addresses (gmail / yahoo / outlook / hotmail / icloud) are accepted by default; if you want the legacy "corp email required" gate back, set `AGENTDASH_REQUIRE_CORP_EMAIL=true` (the middleware at [server/src/middleware/corp-email-signup-guard.ts](../server/src/middleware/corp-email-signup-guard.ts) is still wired — just disabled by default).
3. After sign-up, the orchestrator's `databaseHooks.user.create.after` hook auto-creates a fresh per-user workspace (no domain auto-merging — every user gets their own; cross-team membership happens via invite). You land at `/cos` with a CoS-led welcome conversation: 3 plain-text intro bubbles + 1 interview-question card.
4. Reply to the question — you should get a real reply within ~2s via whichever adapter `AGENTDASH_DEFAULT_ADAPTER` selects (Anthropic API, Claude Code CLI, Hermes CLI, …).
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
- v1's WelcomePage onboarding (replaced by `/cos` with a CoS-led welcome sequence + `interview_question_v1` card flow)
- Real LLM wired for agent **execution** (chat is wired through `dispatch-llm.ts`; agent runtimes still stub via the adapter shim — wire when you have a real customer ask)

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
PAPERCLIP_MIGRATION_AUTO_APPLY=true

# Optional: re-enable the corp-email signup gate (off by default since 2026-05-03)
# AGENTDASH_REQUIRE_CORP_EMAIL=true

# LLM (CoS chat dispatch)
ANTHROPIC_API_KEY=sk-ant-…
AGENTDASH_DEFAULT_ADAPTER=claude_api  # or claude_local / hermes_local / …

# Email (welcome + password reset, via Resend)
RESEND_API_KEY=re_…
AGENTDASH_EMAIL_FROM='AgentDash <noreply@your-domain.com>'  # verified at resend.com/domains
# AGENTDASH_EMAIL_REPLY_TO=support@your-domain.com           # optional

# Stripe (Pro tier)
STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRO_PRICE_ID=price_…
STRIPE_TRIAL_DAYS=14
BILLING_PUBLIC_BASE_URL=https://your-domain.com
```

That's it. With those env vars and a Postgres connection string, AgentDash launches.
