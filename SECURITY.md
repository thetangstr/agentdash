# Security Policy

AgentDash is built on [Paperclip](https://github.com/paperclipai/paperclip). This
policy covers how to report vulnerabilities and how to harden a production
deployment.

## Supported Versions

Security fixes target the latest `main`. We do not backport to older tags —
deploy from a recent `main` to stay covered.

## Reporting a Vulnerability

Please report security vulnerabilities through GitHub's Security Advisory feature:
[https://github.com/paperclipai/paperclip/security/advisories/new](https://github.com/paperclipai/paperclip/security/advisories/new)

Do not open public issues for security vulnerabilities.

### Responsible disclosure

- Report privately first and give us a reasonable window to ship a fix before
  any public disclosure.
- Include enough detail to reproduce: affected endpoint/component, steps, and
  impact.
- Do not run testing against deployments you do not own, exfiltrate data beyond
  what is needed to demonstrate the issue, or degrade service for other users.
- We will acknowledge the report, keep you updated on remediation, and credit
  you on request once a fix is released.

## Production Hardening Checklist

- **Deployment mode.** Run production in `authenticated` mode
  (`PAPERCLIP_DEPLOYMENT_MODE=authenticated`). `local_trusted` is for a single
  founding user on loopback and intentionally relaxes auth, rate limiting, and
  CORS. The two modes are defined in `packages/shared/src/constants.ts`
  (`DEPLOYMENT_MODES`).
- **Exposure.** Set `PAPERCLIP_DEPLOYMENT_EXPOSURE` deliberately. `private`
  enables the private-hostname guard (`server/src/middleware/private-hostname-guard.ts`);
  only use `public` for internet-facing instances, which require a public base
  URL.
- **Secrets via env / secrets manager.** Never commit secrets. Provide
  `BETTER_AUTH_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, etc. through environment variables or a secrets
  manager. `.env.example` lists the variables; `.env` files are git-ignored.
- **`BETTER_AUTH_SECRET` entropy.** Required in authenticated mode — server
  startup throws if it is unset (`server/src/auth/better-auth.ts`). Use a long,
  high-entropy random value (e.g. `openssl rand -base64 32`). Do **not** ship the
  dev placeholder `paperclip-dev-secret`. This secret also signs agent JWTs
  (`server/src/agent-auth-jwt.ts`), so rotating it invalidates existing sessions
  and agent tokens.
- **HTTPS.** Terminate TLS in front of the server and set `PAPERCLIP_PUBLIC_URL`
  (or `BETTER_AUTH_URL`) to the `https://` origin so auth cookies and reset
  links use a secure origin.
- **Rate limiting.** Tiered limits live in `server/src/middleware/rate-limit.ts`
  (auth, billing, invite, and default API tiers, 15-minute windows). They are
  active in authenticated mode and disabled in `local_trusted` and tests. Keep
  them on in production; tune via the `AGENTDASH_RATE_LIMIT_*_MAX` env vars
  rather than disabling.
- **Webhook signature verification.** Stripe webhooks are verified with
  `stripe.webhooks.constructEvent` in `server/src/routes/billing.ts`. When
  `STRIPE_SECRET_KEY` is set, startup requires a non-empty
  `STRIPE_WEBHOOK_SECRET` (`server/src/app.ts`) — an empty secret would accept
  forged events.
- **Plugin UI CORS.** The plugin static-asset route serves a permissive
  `Access-Control-Allow-Origin: *` only in `local_trusted`. In authenticated
  mode it restricts to the instance's own origin plus the
  `AGENTDASH_PLUGIN_UI_ALLOWED_ORIGINS` allowlist and never reflects an
  arbitrary `Origin` (`server/src/routes/plugin-ui-static.ts`).
- **Company scoping.** Every API route is company-scoped; preserve those
  boundaries when extending routes/services.

## Where Security-Relevant Code Lives

| Area | Location |
|------|----------|
| Auth / actor resolution | `server/src/middleware/auth.ts`, `server/src/auth/better-auth.ts` |
| Agent JWT signing | `server/src/agent-auth-jwt.ts` |
| Rate limiting | `server/src/middleware/rate-limit.ts` |
| Private-hostname guard | `server/src/middleware/private-hostname-guard.ts` |
| Board-mutation guard | `server/src/middleware/board-mutation-guard.ts` |
| Corp-email signup guard | `server/src/middleware/corp-email-signup-guard.ts` |
| Stripe webhook verification | `server/src/routes/billing.ts` |
| Plugin UI CORS / static serving | `server/src/routes/plugin-ui-static.ts` |
| Deployment-mode / public-URL config | `server/src/config.ts`, `packages/shared/src/constants.ts` |
