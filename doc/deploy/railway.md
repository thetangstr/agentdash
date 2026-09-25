# Deploy AgentDash as a hosted SaaS on Railway

A single Railway service running the repo [`Dockerfile`](../../Dockerfile) +
a Railway-managed Postgres gives you a public sign-up URL. This is the
**cloud-managed SKU**: real sign-in, the sign-up → CoS → first-hire → invite
onboarding, multi-tenant. Billing starts **off** (Free-tier, caps bypassed);
wire Stripe later per [LAUNCH.md](../LAUNCH.md).

The repo ships [`railway.json`](../../railway.json) (Dockerfile build +
`/api/health` healthcheck) and [`.env.railway.example`](../../.env.railway.example)
(the variable template). You supply a Railway account, a `BETTER_AUTH_SECRET`,
and one LLM key.

---

## 1. Create the project + Postgres

**Dashboard (simplest):**
1. <https://railway.app/new> → **Deploy from GitHub repo** → pick
   `thetangstr/agentdash` (it's public). Railway detects `railway.json` +
   the Dockerfile.
2. In the project, **+ New → Database → PostgreSQL**.

**Or CLI:**
```sh
npm i -g @railway/cli
railway login
railway init                       # create/select a project
railway add --database postgres    # managed Postgres plugin
```

## 2. Set the environment variables

Copy [`.env.railway.example`](../../.env.railway.example) into the service's
**Variables → Raw Editor**, then replace every `CHANGEME`:

- `BETTER_AUTH_SECRET` — generate once: `openssl rand -hex 32`. **Required**;
  the server crashes on boot without it. Don't rotate it casually (logs everyone out).
- `DATABASE_URL` — keep the literal `${{Postgres.DATABASE_URL}}`; Railway
  resolves it to the Postgres plugin's connection string.
- `ANTHROPIC_API_KEY` (or an `OPENAI_COMPAT_*` set) — **required for real CoS
  replies**. Without an LLM key the CoS returns a stub reply and the cloud
  preflight (step 5) fails closed.
- `PAPERCLIP_MIGRATION_AUTO_APPLY=true` — required; otherwise the container
  exits whenever a release adds migrations.
- **No billing:** leave `STRIPE_SECRET_KEY` **unset** — tier caps are then
  bypassed (Free-tier usable). Do **not** set `AGENTDASH_BILLING_DISABLED` on a
  public deploy: the cloud preflight (step 5) rejects it as a dev bypass and
  fails closed.
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` — required for an internet-facing deploy
  (the preflight warns if it's missing).

- **Hosted-box boot guard (#726):** `AGENTDASH_DEPLOYMENT_KIND=hosted` marks a
  hosted agentdash.cloud box. With it set, the server refuses to start unless
  `PAPERCLIP_DEPLOYMENT_MODE=authenticated`; `PAPERCLIP_PUBLIC_URL` and the auth
  base URL (`PAPERCLIP_AUTH_PUBLIC_BASE_URL`) are `https://`;
  `AGENTDASH_HERMES_MANAGED_PROFILES=true`; sign-up is gated
  (`AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true` with `AGENTDASH_INVITE_CODES`, or
  `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`); every invite code is real (not
  `CHANGEME...`, 12 characters or more; `openssl rand -hex 12`);
  `AGENTDASH_INVITE_VALIDATION` is not `off` while
  `AGENTDASH_SELF_SERVE_BOOTSTRAP=true`; and a Microsoft SSO app is pinned to
  one tenant (or `AGENTDASH_HOSTED_ALLOW_MULTI_TENANT_MICROSOFT=true`). The
  template's invite code is a placeholder on purpose, so the first deploy
  fails until you replace it. The boot log names each missing setting. On a
  hosted box, Google and Microsoft sign-in only sign in existing users; new
  people sign up by email with an invite code, and MCP sign-up needs the same
  code. Check the flag took with
  `curl -s https://your-app.up.railway.app/api/health` and look for
  `"hostedBox": true`. `local_trusted` stays the right mode for a founder's own
  machine; the flag is only for hosted boxes.

Leave `PAPERCLIP_AUTH_PUBLIC_BASE_URL` / `BILLING_PUBLIC_BASE_URL` as the
placeholder for the first deploy — you fix them in step 4 once the domain exists.

## 3. First deploy

Railway builds the Dockerfile and boots the service. The first build takes a
few minutes (multi-stage `pnpm install` + build).

```sh
railway up        # if using the CLI; the dashboard deploys on git push / connect
```

`docker-entrypoint.sh` + `PAPERCLIP_MIGRATION_AUTO_APPLY=true` apply migrations
on boot. Watch **Deploy logs** until the `/api/health` healthcheck goes green.

## 4. Wire the public domain

1. Service → **Settings → Networking → Generate Domain** → you get
   `your-app.up.railway.app`.
2. Update **both** `PAPERCLIP_AUTH_PUBLIC_BASE_URL` and
   `BILLING_PUBLIC_BASE_URL` to `https://your-app.up.railway.app`.
3. Redeploy (Railway redeploys on variable change). The auth callback origin +
   hostname allow-list now match the real domain. (Custom domain later: add it
   in the same panel and update these two vars.)

## 5. Cloud preflight (fail-closed safety check)

Before sharing the link, verify the public config is safe. From a checkout with
the same env (or `railway run`):

```sh
node scripts/cloud-preflight.mjs   # exits non-zero on any error
```

It fails on: wrong auth mode, weak/missing `BETTER_AUTH_SECRET`, missing DB,
non-https base URL, an LLM adapter with no key (→ stub replies), or a dev bypass
like `AGENTDASH_RATE_LIMIT_DISABLED=true` left on.

## 6. Smoke-test the sign-up

Open `https://your-app.up.railway.app` → sign up → you should land in the CoS
chat. Send a message; with the LLM key set you get a real reply (not the stub).
Hiring agents + inviting teammates work with caps bypassed.

---

## Notes

- **Port/host:** handled automatically — the Dockerfile sets `HOST=0.0.0.0` and
  the server honors Railway's injected `$PORT`.
- **Auto-deploy on merge to `main` (hosted product):** the repo's
  [Deploy workflow](../../.github/workflows/deploy.yml) runs on every push to
  `main` and deploys to the production Railway service `web`
  (`https://web-production-33a3b6.up.railway.app`) via
  `railway up --service web --ci`, then smoke-tests the live URL. The workflow
  is **inert until the `RAILWAY_TOKEN` repo secret is set** (a Railway *project*
  token scoped to service `web`): without it, it logs "not configured" and exits
  green without deploying. Removing the secret later reverts to that
  inert-by-default state — that is the documented disable path. See
  [LAUNCH.md §4b](../LAUNCH.md#4b-the-hosted-production-deploy-story-what-happens-on-merge)
  for the full deploy story (Vercel UI + `/api/*` rewrite; customer instances
  stay on the manual OTA updater regardless).
- **Rollback:** Railway keeps the previous deployment. Roll back with one click
  in the Railway dashboard — service → **Deployments** → pick the previous
  deployment → **Redeploy**. Migrations are applied forward on boot; if a
  rollback crosses a schema change, check
  `PAPERCLIP_MIGRATION_AUTO_APPLY` behavior before re-pointing traffic.
- **Manual redeploy:** `railway up` (or trigger in the dashboard) still works
  for out-of-band hotfixes; migrations auto-apply. Keep `BETTER_AUTH_SECRET`
  stable across deploys.
- **Enabling billing later:** set `STRIPE_SECRET_KEY` + the Stripe vars from
  [LAUNCH.md](../LAUNCH.md) (this turns caps on). Re-run the preflight.
- **Cost:** one container + Postgres. Scale the service resources in Railway as
  pilot usage grows.
