# AgentDash Launch Checklist — 2026-06-28

Single source of truth for taking AgentDash from "live SaaS, no billing" to a real, paid, marketable launch. Grounded in an audit of the live Railway deployment on 2026-06-28.

Companion to [doc/LAUNCH.md](../LAUNCH.md) (the env-var runbook). This doc is the **status + ownership tracker**; LAUNCH.md is the **how-to**. Mirror this into Linear (a "Launch" project) once the Linear MCP is re-authorized.

**Legend:** ✅ done · 🟡 partial / needs input · ⬜ not started · 🔒 blocked
**Owner:** `you` = founder action (keys, accounts, content, decisions) · `eng` = code/infra (Claude/MAW)

---

## Live deployment snapshot (2026-06-28)

- **URL:** https://web-production-33a3b6.up.railway.app (Railway, service `web`, project `agentdash`)
- **Mode:** `authenticated` + `public` exposure · **DB:** Railway managed Postgres (`postgres.railway.internal`, persistent) · **Migrations:** auto-apply on boot
- **LLM:** MiniMax-M3 (`AGENTDASH_DEFAULT_ADAPTER` + `MINIMAX_API_KEY` set)
- **Auth:** better-auth email/password live; Google/Microsoft SSO built but dark (no creds)
- **Billing:** OFF (`STRIPE_SECRET_KEY` unset → Free tier only, caps bypassed)
- **Email:** OFF (`RESEND_API_KEY` unset → welcome + password-reset emails silently no-op)
- **Error tracking:** OFF (`SENTRY_DSN` unset)
- **Domain:** Railway subdomain only (no custom domain)

---

## Critical path to first paying customer (ordered)

1. Custom domain + DNS + TLS (B1–B3)
2. Transactional email — Resend (A3) ← **password reset is silently broken without this**
3. Postgres backups verified (B4)
4. Stripe Pro tier wired + tested end-to-end (A2)
5. Cloud preflight green + error tracking on (A6, A7)
6. Legal: ToS + Privacy live (C5)
7. Pricing page + investor page content filled (C2, C3)
8. Auto-deploy CI/CD so merges ship safely (D2)

---

## A. Technical readiness

| # | Item | Status | Owner | Notes |
|---|---|---|---|---|
| A1 | Auth (email/password) | ✅ | eng | Live via better-auth, stored in app Postgres. |
| A1b | SSO (Google + Microsoft) | 🟡 | you | Code shipped dark (#433). To enable: set `GOOGLE_*` / `MICROSOFT_*` + register callback URIs. Parked per your call. |
| A2 | Stripe Pro tier (paid) | ⬜ | you+eng | Code exists (`/api/billing/*`). Need: create Product/Price, webhook endpoint, set `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRO_PRICE_ID` / `STRIPE_TRIAL_DAYS` / `BILLING_PUBLIC_BASE_URL`. Then test checkout → trial → `pro_trial` flip. **Until done, no revenue path.** |
| A3 | Transactional email (Resend) | ⬜ | you+eng | `RESEND_API_KEY` + `AGENTDASH_EMAIL_FROM` unset → **password reset & welcome emails silently no-op.** Verify a sending domain at resend.com. High priority — broken self-serve recovery today. |
| A4 | LLM for CoS chat | ✅ | eng | MiniMax-M3 live. Decide if MiniMax is the launch model or swap to `claude_api` / `openai_compat` (Cloud SKU metering). |
| A4b | LLM for agent *execution* | 🟡 | eng | CoS chat is wired; real agent-execution LLM is still adapter-stubbed by design. Wire when a customer needs agents to actually run work (not just CoS chat + trial deliverables). |
| A5 | Abuse / DDoS protection | ✅ | eng | Shipped + verified live (#431): per-IP cap, global spend breaker, kill-switch, trust-proxy. |
| A6 | Cloud preflight green | ⬜ | eng | Run `node scripts/cloud-preflight.mjs` against prod env; fail-closed on unsafe config. Re-run after A2/A3. |
| A7 | Error tracking (Sentry) | ⬜ | you+eng | Optional but recommended for launch. Set `SENTRY_DSN` (built-in, no dep). Captures 5xx + unhandled errors. |
| A8 | Rate limiting on (not disabled) | ✅ | eng | Default API + auth + trial limiters active; `AGENTDASH_RATE_LIMIT_DISABLED` not set. |
| A9 | Trial / first-run experience | ✅ | eng | Test Drive (no-signup autonomous company), nav/persistence hardening (#432), templates — all live + verified. |
| A10 | Secrets hygiene | 🟡 | you | `BETTER_AUTH_SECRET` set (don't rotate — logs everyone out). Consider rotating the cloud MiniMax key to isolate it from the mini. Confirm no dev bypasses in prod env. |
| A11 | Data backup/restore drill | ⬜ | eng | See B4 — backups + a test restore before real customer data. |

## B. Hosting & domain

| # | Item | Status | Owner | Notes |
|---|---|---|---|---|
| B1 | Buy/choose the domain | ⬜ | you | Pick the launch domain (e.g. agentdash.ai / .com). **Decision needed — tell me the domain.** |
| B2 | Point DNS at Railway + add custom domain | ⬜ | you+eng | Railway → service → Settings → Custom Domain → add `app.<domain>` (and/or apex), then create the CNAME/A record at your registrar. |
| B3 | TLS + canonical URL env | ⬜ | eng | Railway auto-provisions TLS for custom domains. Then update `PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BILLING_PUBLIC_BASE_URL`, and `PAPERCLIP_PUBLIC_URL` to the custom domain (also the OAuth redirect URIs if SSO is on). |
| B4 | Postgres backups / PITR | ⬜ | you+eng | **Confirm Railway Postgres backups are enabled** for the plan. Run one test restore. #1 data-safety item before real customers. |
| B5 | Scaling / resource limits | 🟡 | eng | Current Railway plan fine for launch. Watch the Postgres connection pool + web service memory under load. DB is a drop-in `DATABASE_URL` swap (Neon/RDS) if outgrown. |
| B6 | Uptime monitoring | ⬜ | you+eng | Add an external uptime check on `/` + a `/health`-style probe. Pair with Sentry (A7). |
| B7 | Custom-domain email (DKIM/SPF) | ⬜ | you | Tied to A3 — verify the sending domain in Resend (DKIM/SPF DNS records) so mail isn't spoofable/spam. |

## C. GTM / launch

| # | Item | Status | Owner | Notes |
|---|---|---|---|---|
| C1 | Positioning / ICP | 🟡 | you | MSP wedge + autonomous-company thesis exist in the plans. Lock the one-line positioning + the launch ICP. |
| C2 | Marketing landing / pricing page | 🟡 | you+eng | Trial landing (`/trial`) is strong. Need a clear **pricing page** (Free vs Pro) once A2 is wired. |
| C3 | Investor page content | 🟡 | you | Page live at `/investors` (#434/#435). Fill placeholders: traction, team, the ask, contact. No fabricated data. |
| C4 | Google for Startups application | ⬜ | you | The `/investors` page supports it. Decide credits track vs equity-free; submit with company details. |
| C5 | Legal — ToS + Privacy Policy | ⬜ | you | **Required before taking payment / real users.** Generate (Termly/iubenda or counsel) and link in footer + signup. |
| C6 | Analytics / product metrics | ⬜ | you+eng | Add privacy-respecting analytics (signups, trial→company, activation). Drives the investor traction slots (C3). |
| C7 | Launch comms | ⬜ | you | Waitlist/announce plan, design-partner outreach (MSP), Show HN / LinkedIn / direct outreach. |
| C8 | Support channel | ⬜ | you | A real contact/support inbox (ties to A3 `AGENTDASH_EMAIL_REPLY_TO` + the investor-page contact slot). |

## D. CI/CD + MAW

| # | Item | Status | Owner | Notes |
|---|---|---|---|---|
| D1 | PR gates (MAW) | ✅ | eng | `pr.yml`: policy (PR-template + lockfile + Dockerfile), verify (typecheck/test/build/canary), launch-signoff, dependency-audit (blocking HIGH/CRITICAL), e2e. Plus agents-md-drift, hermes-pr-audit, hermes-prompt-drift, docker, audit. |
| D2 | **Auto-deploy on merge to main** | ⬜→🟡 | eng+you | **The gap.** Deploys are manual (`railway up`). Adding `deploy.yml` (this PR): main → Railway build + post-deploy smoke test, gated on a `RAILWAY_TOKEN` repo secret (inert until you add it). Closes the TPM-merge → ship loop. |
| D3 | e2e flake | ✅ | eng | Already mitigated in `pr.yml` (Akamai mirror + `--no-shell` + retry + browser cache). Occasional cache-miss seeding still possible; admin-bypass only when the install genuinely flakes. |
| D4 | MAW agent commands | ✅ | eng | `.claude/commands/{pm,builder,tester,tpm,admin,workon}.md`. TPM = sole merge authority. Linear team `AgentDash`, prefix `AGE`. |
| D5 | admin.md env placeholders | ⬜ | eng | `admin.md` still has `TODO_SET_*` for staging/prod URLs. Fill with the Railway prod URL (+ custom domain when B2 lands) so `/admin health` works. |
| D6 | Staging environment | 🟡 | you+eng | No staging today (every main merge → prod via D2). Optional: a Railway staging env for risky changes. Acceptable to launch without; revisit post-launch. |

---

## Open decisions for you

1. **Domain** — what's the launch domain? (gates B1–B3, OAuth redirects, email)
2. **Launch model** — stay on MiniMax, or move CoS/agents to Claude / a metered Cloud-SKU provider?
3. **Pricing** — confirm Free (1 human + 1 agent) vs Pro ($/seat/mo + 14-day trial) numbers for A2 + the pricing page.
4. **Billing timing** — launch free-only first, or wire Stripe before any public push?
5. **Auto-deploy** — approve `deploy.yml` auto-shipping main to prod (with smoke test), or keep deploys manual for now?
