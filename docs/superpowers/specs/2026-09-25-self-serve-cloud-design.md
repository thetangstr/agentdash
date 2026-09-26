# Self-serve cloud: sign up at agentdash.cloud, get your own box automatically

**Status:** approved by the founder on 2026-09-25 (§10). Issues filed with the `self-serve-cloud` label.
**Date:** 2026-09-25
**Decision being implemented (founder, 2026-09-25):** launch in the cloud "like how Muse does it". A person signs up at agentdash.cloud and gets their own AgentDash box with no manual step. **Option A: one box per customer, provisioned automatically.** Option B (one shared app with sandboxed agent runs) is the post-launch direction, and nothing here may block it.
**Launch:** 2026-10-28. **Budget:** about 1 to 2 weeks of build, alongside assistant MCP M4 and M5.

**This supersedes MVL 1.0 decision D1** ("invite-only, an operator provisions each box by hand", `doc/plans/2026-09-24-mvl-1.0.md` §8) and moves the SaaS discovery's Phase 2 (#623 §5, "automated provisioning and control plane") ahead of launch. Everything else in the MVL plan stands: default profile only, Hermes only, the built Free and Pro plans, no box fee.

---

## 0. The answer in one screen

- **Control plane:** a new small Node service, `cloud-control`, in its own Railway project inside a **dedicated Railway Pro workspace** that holds only customer boxes. It owns accounts, boxes, provisioning jobs and the self-hosted invite validator. www stays on Vercel with a new `/start` page; Vercel rewrites `/api/cloud/*` and `/api/invites/validate` to it (§3.1).
- **Provisioning:** `provision-box.sh` ported to a TypeScript module on the Railway GraphQL API, idempotent and resumable from a Postgres job table, with the same secret rules. Image-only, so it depends on #732 (a GHCR image per stable tag): about 1 to 2 minutes per box instead of 14 (§3.3).
- **Domains:** an edge router on Railway behind **one wildcard**. Railway issues the wildcard certificate itself through a **static CNAME** of `_acme-challenge` to `authorize.railwaydns.net`, so GoDaddy needs **three records, once, and no API** (§4). A Cloudflare Worker is the alternative if DNS ever moves.
- **Claim:** a single-use code, bound to the verified email and baked into the box before its first deploy. The box accepts it only while it has zero users, so it dies on use with no restart (§3.5).
- **Journey:** about 3 minutes of waiting, 15 to 20 minutes end to end to a connected Muse (§1).
- **Cost:** $6 to $7 a month per idle box (measured), $10 to $20 with agents, about $1.50 suspended. Railway **Pro** is required (100 projects per workspace, snapshots). One paid seat covers about four abandoned Free signups (§5.3).
- **Findings that change existing plans:** Stripe allows **16 webhook endpoints per account**, so #722's endpoint per box breaks at box 17; the control plane fans events out (§3.7). Let's Encrypt caps new certificates per registered domain per week (50 at the time of writing), which rules out a certificate per box (§4.2).
- **10-28:** holds for self-serve **behind waitlist-and-approve with a daily cap**, if a Claude lane owns the control plane. Fully open signup: about 11-04 (§9.3).

---

## 1. The customer journey, with timings

| # | Step | What happens | Time |
|---|---|---|---|
| 1 | Land on `www.agentdash.cloud` | "Start free" goes to `/start` | |
| 2 | Sign up at `/start` | Email, workspace name (becomes the slug, checked live), Turnstile, terms. `POST /api/cloud/signup`, rewritten to the control plane | 30 s |
| 3 | Verify email | Single-use magic link, 30 minutes. The click proves the email and opens the progress page with a short-lived control-plane session | their inbox |
| 4 | "Creating your workspace" | The provisioning job runs (§3.3); the page polls `GET /api/cloud/boxes/mine` and shows each step | **1.5 to 3 min** from a GHCR image |
| 5 | Ready | **Open my workspace** appears; the same claim link is emailed as a backup, valid 7 days | instant |
| 6 | Account on the box | `https://<slug>.agentdash.cloud/claim#code=…`: the new page reads the code from the fragment (never logged or sent as a referrer), shows the verified email read-only, takes name and password, and posts `sign-up/email` with `inviteCode` (§3.5) | 1 min |
| 7 | CoS onboarding at `/cos` | The founder creates the company; self-serve bootstrap makes them instance admin (#746); one company per box (#739) | 5 to 10 min |
| 8 | Hermes provider key | Z.AI, OpenRouter, Anthropic or OpenAI, written to the managed Hermes template profile on the Volume (#725) | 1 to 2 min |
| 9 | Connect Muse | Custom connector: host `https://<slug>.agentdash.cloud`, client ID `muse`. Muse finds the protected-resource metadata, signs in on the box, the consent screen names Muse and `agent.meta.ai`, the founder picks the company. Each box is its own OAuth issuer (#688) | 2 min |
| | **Total** | | **15 to 20 min**, about 3 of them waiting on us |

After step 6 the control plane sees the claim on the box's health and queues close-signup (§3.5). The box starts on Free (2 agents on hosted boxes); the first hire past the CoS or the first teammate invite opens the 14-day no-card Pro trial inside the box (MVL §6).

**What the person can see go wrong:** slug taken, or email disposable or rate-limited (refused at step 2); slow provisioning (after 5 minutes the page says so and promises the email); failure after retries ("we're on it", ops alerted, the slug is kept); waitlist on (step 4 becomes "You're on the list"). **Coming back:** `/find` mails links to that email's boxes; www's "Sign in" goes there.

---

## 2. What exists and is reused

- **`scripts/hosted/provision-box.sh`, `lib.sh`** (#730, tested against a fake Railway API in `provision-box.test.mjs`): the step list, variables and safety rules the Node port copies (§3.3). `claim-box.sh` is replaced by a `/claim` page with the same request. `backup-box.sh` stays the manual deep backup and restore test.
- **Hosted boot guard** (`server/src/hosted-box-guard.ts`, #729): every box sets `AGENTDASH_DEPLOYMENT_KIND=hosted` and satisfies it.
- **Signup gate** (`server/src/lib/signup-gate.ts`, `invite-code-signup-guard.ts`): the claim code rides the existing `inviteCode` body field; §3.5 adds an email binding. **Company invites** pass the gate (#743), so teammates join after sign-up closes.
- **Self-serve bootstrap promotion** (#746) and **one company per box** (#739): the claimant becomes instance admin. #748 tracks the concurrent first-company race.
- **Hermes in the image** (#721) and **the provider key in onboarding** (#725), both closed; **assistant OAuth and `/api/mcp/assistant`** (#688, merged); **the release tag in `/api/health`** (#752).
- **Billing** (Free and Pro per seat, 14-day no-card trial) is unchanged inside each box; §3.7 changes only how Stripe reaches it.
- **www on Vercel:** `vercel.json` rewrites `/api/*` to the **old** Railway instance `web-production-33a3b6`, which also answers `POST /api/invites/validate` for self-hosted installs (`onboarding-mcp-signup.ts:93`). §7 moves that.

**Gaps this closes:** browser sign-up cannot send an instance invite code (runbook §11), so today's claim is a shell script; closing sign-up needs an operator and a redeploy; a custom domain needs two GoDaddy records per box and up to an hour (runbook §8).

---

## 3. Architecture

```
person ─ www.agentdash.cloud (Vercel) ─ /api/cloud/*, /api/invites/validate ─┐
                                                                              ▼
  Railway workspace "agentdash-boxes" (Pro, dedicated)
    project agentdash-cloud:     cloud-control (API + worker), Postgres, edge (router, 2 replicas)
    project agentdash-box-acme:  web + Postgres + Volume      ... one project per customer
person ─ https://acme.agentdash.cloud ─ wildcard DNS ─ edge ─ https://web-…up.railway.app (box)
```

### 3.1 Where the control plane runs: a new Railway service

A new service wins on every axis that matters. Provisioning is a loop that polls Railway for minutes; Vercel's function time limits would split each step into a separate invocation driven by cron or a queue product. The queue is Postgres `FOR UPDATE SKIP LOCKED` in the same database. The Railway token lives in one service inside the boxes workspace, not in Vercel beside the marketing build and its preview deployments. The router shares the project and reads routes over the private network. The control plane gets its own release cadence.

The UI stays on Vercel (`/start`, progress and `/find` are SPA routes in `ui/src/marketing/`). The code is a new workspace package, `cloud/` (`@agentdash/cloud-control`), with its own Drizzle schema and migrations, never touching the box schema. AgentDash-only; no upstream impact.

### 3.2 Data model (control-plane Postgres)

| Table | Key columns and notes |
|---|---|
| `accounts` | `email` (citext, unique), `email_verified_at`, `signup_ip`, `status`. A person on the front door, not a box user (#623 D-S5: two identity domains) |
| `email_tokens` | `account_id`, `purpose` (verify, find), `token_hash`, `expires_at`, `used_at` |
| `boxes` | `account_id`, `slug` (unique), `kind` (`dedicated`; `shared` reserved for Option B), `state`, `railway_workspace_id`, `project_id`, `environment_id`, `web_service_id`, `pg_service_id`, `upstream_host`, `public_url`, `release_tag`, `image_digest`, `edge_secret_enc`, `claim_code_enc`, `claim_code_hash`, `claim_expires_at`, `claimed_at`, `plan_tier`, `last_health`, `last_human_request_at`, `suspended_at`, `delete_after`, `hold_upgrades`, `cohort`. Each Railway ID is recorded the moment it is created, which makes a crashed job resumable |
| `jobs` | `box_id`, `kind` (provision, close_signup, suspend, resume, upgrade, delete), `state` (queued, running, succeeded, failed, dead), `step`, `attempt`, `run_after`, `locked_until`, `last_error` (redacted) |
| `box_events` | append-only audit trail |
| `railway_workspaces` | `project_count`, `capacity`, `accepting`: shards past 100 projects without code changes |
| `invite_codes` | `code_hash`, `label`, `revoked_at`: the self-hosted validator (§7) |
| `waitlist`, `settings` | `settings` holds `provisioning_enabled` (kill switch), `waitlist_mode`, `daily_cap`, `max_concurrent_jobs`, `target_release`, `rollout_paused` |

`*_enc` columns use AES-256-GCM with `CLOUD_DATA_KEY` (control plane and router only). A box's auth secret, secrets master key and Postgres password are **never stored in the control plane**.

### 3.3 The provisioning worker

`cloud/src/railway/` ports `provision-box.sh` step for step. Each step reads Railway state first, creates only what is missing, and records the ID.

1. **Reserve:** the lib.sh slug rule (at most 16 characters at creation, so `<slug>-restore` fits), a reserved list (`www`, `app`, `api`, `hq`, `mcp`, `cloud`, `admin`, `status`, `mail`, `support`, `docs`, `edge`, `staging`, brand and abuse terms), a workspace with capacity.
2. **Project** `agentdash-box-<slug>`. The name guard and protected list (`agentdash`, `agentdash-demo`, `yarda-backend-v2`, `perceptive-integrity`) are ported verbatim; the dedicated workspace puts those projects out of the token's reach anyway.
3. **Postgres.** The script uses a CLI template call (`railway add --database postgres`). The port creates the service from Railway's Postgres image (major version pinned) with its own volume and a password generated in memory. SC-0 confirms this or switches to the template mutation.
4. **`web`, the Volume at `/paperclip`, a Railway domain on port 3100.**
5. **Variables:** the runbook §12 set, except that `PAPERCLIP_PUBLIC_URL`, the auth and billing base URLs and the invite validation URL are `https://<slug>.agentdash.cloud` **from the first boot** (the router serves the name at once, so there is no switch-over); `PAPERCLIP_ALLOWED_HOSTNAMES` holds both hosts; plus the claim code as `AGENTDASH_INVITE_CODES`, `AGENTDASH_CLAIM_EMAIL`, `AGENTDASH_EDGE_SECRET`, the Stripe keys and a per-box Resend key (§3.7).
6. **Service settings:** health check, restart policy, the Volume-ownership start command, and the image **by digest**, resolved from the target release tag.
7. **Snapshots:** daily and weekly schedules on both volumes (Pro).
8. **Deploy;** wait for SUCCESS (15 min cap), then healthy and `authenticated` on the Railway host (5 min), then through the router (2 min).
9. **Publish:** route live, box `awaiting_claim`, ready email sent.

**Secret rules, from lib.sh:** secrets come from `crypto.randomBytes` and live in memory for one request; none appears in a log, job row, error or URL; the GraphQL client never logs variables, and the logger redacts by key (`*SECRET*`, `*KEY*`, `*TOKEN*`, `*CODE*`, `password`) and by pattern (`AGD-`, `sk_`, `rk_`, `re_`, `whsec_`); a failed variable **read** stops the job; a deployed box missing its auth secret or master key is never given new ones (the job goes `dead` and pages ops).

**Master key escrow:** the worker seals `PAPERCLIP_SECRETS_MASTER_KEY` to an offline **escrow public key** (libsodium sealed box) and keeps only the ciphertext. The control plane can escrow but not decrypt.

### 3.4 State machine, retries, timeouts, cleanup

```
requested ─→ provisioning ─→ awaiting_claim ─(claim seen)→ active ⇄ suspended ─→ pending_delete ─→ deleted
   └→ waitlisted (until approved)   │ retries spent    │ 7 days unclaimed
                                    ▼                  ▼
                                  failed ─→ cleanup ─→ deleted
```

- **Retries:** backoff 15 s, 1 min, 4 min, 10 min; 5 attempts; Railway 429s honour `Retry-After`. A 5-minute job lock renewed by heartbeat lets another worker resume a crashed job at its step.
- **Timeouts:** per step as in §3.3; 30 minutes per provision job.
- **Failed:** ops is alerted with the redacted error; the person sees "we're on it"; an operator can `retry` (resumes at the step) or `abandon`.
- **Cleanup:** a `delete` job removes the project through `projectDelete` only if the box was never claimed, the name is `agentdash-box-<slug>`, the ID matches the row, and the description carries the control-plane tag. **Claimed boxes are deleted only through §6.5.**
- **Concurrency:** 3 provisioning jobs at once; a box takes roughly 60 to 100 API calls, well inside Pro's 10,000 an hour.

### 3.5 The one-time claim link

1. At step 5 the worker generates a claim code (`AGD-` plus 26 hex, about 100 bits) and sets it with `AGENTDASH_CLAIM_EMAIL` **before the first deploy**. The control plane keeps it encrypted (to re-send the email) plus its hash, until the claim.
2. The email and progress page link to `https://<slug>.agentdash.cloud/claim#code=<code>`.
3. **New box rule (SC-6):** with `AGENTDASH_CLAIM_EMAIL` set, the instance code is accepted only while the box has **zero users** and only for that email. The first sign-up kills it instantly, closing the runbook's "not single-use" gap. Company invites (#743) are unaffected; MCP sign-up (already 409 once a user exists) gets the same email binding.
4. `/api/health` gains `claimed`. The control plane polls boxes in `awaiting_claim` (every 15 s while the progress page is open, else every minute) and then queues `close_signup`: `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, the code rotated to an unrecorded value, `AGENTDASH_CLAIM_EMAIL` removed, the stored code erased.
5. **Those variables go in with `skipDeploys: true` and take effect at the next deploy.** A Volume service has a short outage on every redeploy, and restarting now would cut the founder off mid-onboarding. Step 3 already makes the code useless.
6. Links expire after 7 days, and unclaimed boxes are cleaned up. "Resend my link" never touches the box.

### 3.6 The control plane's own security

- **Railway token:** a **workspace token** for `agentdash-boxes`. Project tokens cannot create projects; an account token reaches every workspace the founder owns (the old `agentdash` project, `yarda-backend-v2`). It lives only in `cloud-control`; the router never has it.
- **Blast radius:** a leaked token reads every box's variables. So: the admin surface is a CLI with a separate admin bearer and an IP allow-list, not a public page; outbound traffic goes only to Railway, Resend, Stripe and GHCR; the token rotates on a schedule.
- **Public API:** `signup`, `verify`, `boxes/mine`, `resend`, `find`, `stripe/webhook`, `invites/validate`. Everything else is private-network plus bearer.

### 3.7 Stripe and Resend per box

**Stripe allows 16 webhook endpoints per account,** so #722's endpoint per box breaks at box 17. Instead, one endpoint, `https://www.agentdash.cloud/api/cloud/stripe/webhook`, verifies Stripe's signature, finds the box from `metadata.box_slug` (SC-8 adds `AGENTDASH_BOX_SLUG`, already a box variable, beside `companyId` in `server/src/services/billing.ts`), and forwards the raw body to the box's `/api/billing/webhook` **re-signed in Stripe's format with that box's own webhook secret** (HMAC-SHA256 over `t.payload`, which `constructEvent` checks). Stripe has **no public API to mint restricted keys**, so boxes share one **restricted key** (`rk_…`: checkout, portal, subscriptions, customers), created by hand; the control plane rotates it across the fleet in one command (a variables upsert per box). Accepted risk until Option B: a compromised box's key can read other customers' objects of those types, and revocation is fleet-wide, not per box (§10, decision 4). The control plane reads `customer.subscription.*` to keep `plan_tier`.

**Resend:** one verified domain (`mail.agentdash.cloud`) for control-plane mail, and a sending-only **API key per box** for invites and resets, revoked at deletion.

---

## 4. Edge router and domains

### 4.1 What the founder adds at GoDaddy, once

| Type | Host | Value | Why |
|---|---|---|---|
| CNAME | `*` | the target Railway prints for the router's wildcard domain | Every `<slug>.agentdash.cloud` reaches the router |
| CNAME | `_acme-challenge` | `authorize.railwaydns.net` | Railway answers Let's Encrypt's DNS-01 challenge for the wildcard, forever, with no GoDaddy API |
| TXT | as printed by Railway | as printed | Ownership check; the wildcard does not verify without it |

Explicit records (`www` on Vercel, `hq`, the apex, Google MX) keep precedence over the wildcard and are untouched. agentdash.cloud has no CAA record, so Let's Encrypt is allowed. Railway issues the certificate within an hour of the records resolving.

### 4.2 TLS: the question, answered

A wildcard certificate needs a DNS-01 challenge, which GoDaddy without an API cannot answer automatically. **Railway solves it by CNAME delegation:** `_acme-challenge` points permanently at Railway's DNS, which answers every challenge and renewal. No API, no DNS move. A wildcard counts as **one** custom domain slot (Hobby 2 per service, Pro 20).

A certificate per box (a Railway custom domain on each box) would need a CNAME and TXT per box at GoDaddy by hand (today's runbook §8), wait up to an hour each, and run into Let's Encrypt's weekly cap on new certificates per registered domain. The wildcard is one certificate, and a new box is reachable the second its route is published.

### 4.3 The router

A small Node service (`cloud/src/edge/`, `http-proxy` or undici), 2 replicas, in the boxes' region.

- **Routing:** `<slug>.agentdash.cloud` to the box's `upstream_host`, from an in-memory table read from the control-plane Postgres (read-only role, an `edge_routes` view), refreshed every 5 s, with an on-miss lookup so a new box routes at once. If Postgres is down, it serves the last good table.
- **Headers:** `Host` becomes the upstream Railway host (Railway's edge routes by Host); it adds `X-Forwarded-Host`, `X-AgentDash-Edge` (the per-box secret) and `X-AgentDash-Client-IP`, and strips client-supplied copies of the last two.
- **WebSockets** (live events use `ws`) are proxied with Upgrade; Railway exempts them from HTTP duration limits. **Streaming MCP:** `/api/mcp/assistant` is stateless JSON with no SSE, so nothing is long-lived; bodies stream unbuffered anyway, and Railway's limits (15 min while data flows, 5 min idle) apply on both hops.
- **Other names:** reserved or unknown slugs get a branded 404 linking to `/find`; a suspended box gets a "waking your workspace" page that queues `resume` (about 50 s, runbook §11); a deleted box says so.
- **Activity:** it records `last_human_request_at` per box (not health polls or the assistant endpoint), the Free idle signal (§5.2), with no box change.

### 4.4 What the box must do behind the router (SC-5)

- **OAuth:** the issuer is `publicBaseUrl` = `https://<slug>.agentdash.cloud` from the first boot. Muse's redirect URI is Meta's fixed callback, so nothing else changes; PRM and AS metadata pass through like any path. Deep links already come from `publicBaseUrl`.
- **Origin and cookies:** `board-mutation-guard.ts` and the MCP Origin check already trust `PAPERCLIP_PUBLIC_URL` explicitly, whatever Host the box sees. Cookies have no `Domain`, so browsers scope them to the slug host.
- **Client IP:** `trust proxy` is 1 hop, so behind the router every visitor would share the router's address in the rate limiter. With `AGENTDASH_EDGE_SECRET` set, the box takes the client IP from `X-AgentDash-Client-IP` **only when `X-AgentDash-Edge` matches** (constant time) and refuses any request without it except `GET /api/health`. The Railway host then cannot bypass the router, spoof an IP, or reach the box under another issuer.
- The boot guard checks that `PAPERCLIP_PUBLIC_URL` is under the edge domain when the edge secret is set.

### 4.5 Railway router vs a Cloudflare Worker

| | Railway router (recommended) | Cloudflare Worker |
|---|---|---|
| DNS | Stays at GoDaddy; three records once | Nameservers move; every record (www, Google MX, SPF, DKIM, `hq`, apex) copied first, or mail and www break |
| TLS | Railway wildcard via CNAME delegation | Universal SSL covers `*.agentdash.cloud` |
| Failure domain | Our service, 2 replicas, one region; if down, boxes run but are unreachable by name | Cloudflare's global edge |
| Latency | Railway edge, router, Railway edge, box: estimated 5 to 20 ms extra (SC-0 measures) | Similar |
| Route table | Same Postgres, instant | KV lags about a minute; needs D1 or a call |
| Extras, cost | none; $3 to $5 a month | WAF and DDoS on every box; $5 a month |

**Recommendation: the Railway router for launch.** No DNS migration, and it fits the budget. If its single-region failure domain starts to matter, or we want a WAF, move DNS to Cloudflare and swap in a Worker: the route table and the box-side edge secret stay the same. Turnstile on the signup form needs no Cloudflare DNS and is used from day one.

---

## 5. Abuse and cost controls

### 5.1 Controls (all in the control plane)

- **Email verification** before any provisioning (magic link, 30 min, single use) and **Turnstile** on `/start` and `/find`.
- **Rate limits:** per IP 3 signups an hour and 1 box a day; 5 boxes a day for any one non-freemail domain; **one Free box per verified email**.
- **Disposable email** blocked (the maintained `disposable-email-domains` list plus overrides; MX must exist).
- **Kill switch** `provisioning_enabled=false` (signups still land on the waitlist); **daily cap** 10 at launch (overflow goes to the waitlist); **waitlist mode** on at launch (an operator approves, one by one or in a batch); **3 concurrent jobs**.
- **Spend alarm:** a daily read of the workspace's Railway usage trips the kill switch above a threshold and pages ops.

### 5.2 Idle policy for Free boxes

"Idle" means no human request through the router (§4.3). Pro and trialing boxes are never suspended automatically; a lapsed trial falls back to Free rules.

| Day idle | Action |
|---|---|
| 14 | Email: "your workspace will pause in 7 days; sign in to keep it running" |
| 21 | **Suspend:** `web` deployment removed (`railway down` equivalent). Data stays in Postgres and the Volume. Visiting the URL wakes it in about 50 s |
| 45 | Email: "your paused workspace will be deleted in 15 days"; offer an export |
| 60 | Final snapshot and escrow check, then the deletion flow (§6.5) |

Suspending Postgres as well would save about $1.30 a month per suspended box; it is off at launch until a suspend-and-resume test on Postgres passes.

### 5.3 Cost per box and break-even

Measured on the launch box (runbook §1): `web` 0.46 GB and Postgres 0.13 GB of memory, CPU near zero, at $10 per GB-month of memory and $0.15 per GB-month of volume:

| Box state | Cost a month |
|---|---|
| Idle, running | **$6 to $7** |
| Agents running | $10 to $20 (estimate) |
| Suspended (web down) | about $1.30 to $1.50 (Postgres plus volumes); under $0.50 if Postgres is also suspended |

**Which Railway plan:** **Pro, required.** Hobby allows 50 projects per workspace, refuses volume snapshots (found on the launch box, #733) and allows 1,000 API requests an hour. Pro allows **100 projects per workspace**, snapshots, and 10,000 API requests an hour, at $20 a month per seat with $20 of usage included. Past about 80 boxes, open a second Pro workspace (the `railway_workspaces` table already shards) or ask Railway about Enterprise (unlimited projects). **Fixed platform cost:** about $50 a month (Pro seat $20, control plane plus router plus its Postgres about $15, Resend $0 to $20).

**Break-even:** a Pro seat is $29, about $27.80 after Stripe fees. A one-seat Pro box running agents costs $10 to $20, leaving about $8 to $18; every further seat is nearly all margin. An abandoned Free signup costs about $6 to $7 over its life (about $4.50 running for 21 days, then about $1.40 a month suspended until deletion at day 60). So **one paid seat covers about four abandoned Free signups**, and at 100 Free signups a month the fleet needs about 25 to 50 Pro seats to break even, depending on how hard Pro boxes run. The levers are the daily cap, a shorter idle window, and suspending Postgres.

---

## 6. Operations

### 6.1 Fleet upgrade (canary, then cohorts)

- `target_release` names the tag; the control plane resolves it to a GHCR digest (#732) and refuses tags without one.
- Order: **canary** (the launch box and an internal canary box), then 10 percent oldest-first, then batches of 5. The first failure sets `rollout_paused` and pages ops.
- Per box, in a nightly window (02:00 to 05:00 Pacific): snapshot both volumes, point at the new digest, apply pending variable changes (such as `close_signup`), deploy, and wait for `/api/health` to report the new release tag (#752) through the router. **On failure:** roll back to the previous deployment and set `hold_upgrades`. Migrations apply on boot; rolling back across one needs the snapshot (runbook §10).
- Impact: about a minute of downtime per box per release (a Volume redeploy). `hold_upgrades` also serves a customer who asks us to wait.

### 6.2 Backups

- **Railway snapshots,** daily and weekly, on both volumes, set at provisioning (Pro): the database, and `/paperclip` with the Hermes home and the customer's provider key. This closes #733 for these boxes. Plus a **pre-upgrade snapshot** and **master key escrow** (§3.3).
- The server's hourly on-volume backup stays but is not off-box. **Off-Railway encrypted pg_dumps** are post-launch; `backup-box.sh` stays the manual deep backup. A monthly restore test restores a random box's snapshot into a throwaway project.

### 6.3 Monitoring

Health every 60 s per active box on the Railway host (health is exempt from the edge secret) and every 5 minutes through the router. Alerts (email and the ops channel) on 3 consecutive failures, any failed or dead job, router 5xx above 1 percent, the spend alarm, and certificate expiry under 14 days. The admin CLI shows a fleet summary; a status page is post-launch.

### 6.4 Support access

No standing operator login on any box (runbook §1, D-S7). A customer who wants help invites `support@agentdash.cloud` into their company with the existing company invite (#743), which the box logs, and removes it afterwards. Support is never the sole instance admin. Railway access (logs, shell) is operator-only and recorded in `box_events`. A time-boxed in-app grant is post-launch.

### 6.5 Deleting a customer

On request (email at launch), by the idle policy, or by an operator: the box goes `pending_delete` and the router says so; an export (company portability) is offered; the Stripe subscription is cancelled and the box's Resend key revoked; a final snapshot is kept 30 days, then the project is deleted by a job from this flow only; the account's personal data is erased except what billing law requires, and the escrowed key ciphertext destroyed.

---

## 7. Migrating off the old instance

www's rewrite sends every `/api/*` to the old instance (project `agentdash`, service `web`), which is also the validator self-hosted installs call by default (`https://www.agentdash.cloud/api/invites/validate`, `doc/MCP-LAUNCH.md`) and what www's "Sign in" signs into.

1. **Validator first.** The control plane implements `POST /api/invites/validate` with the exact contract of `server/src/routes/invite-codes.ts` (`{code}` in, `{valid}` out, rate-limited, constant-time). The founder copies the old instance's `AGENTDASH_INVITE_CODES` values into the control plane once, through the admin CLI, which stores only hashes.
2. **Repoint the rewrite.** `vercel.json` rewrites `/api/invites/validate` and `/api/cloud/:path*` to the control plane and answers every other `/api/*` with 410. The URL self-hosted installs call never changes.
3. **Repoint the CTAs.** "Start free" goes to `/start`, "Sign in" goes to `/find`. `claims.test.ts` forbids "Start free" today because self-serve did not exist; that rule changes in the same PR.
4. **Retire.** Export the old instance's data (the plan on #675; the export has already been restore-tested, runbook §13), scale its service to zero, keep it for 30 days, then delete it. The founder does the delete; the control plane's token cannot reach that project.

---

## 8. The path to Option B, and what to keep compatible

Option B's gates (#623 §3): tenant-isolation tests, per-company secrets keys, off-box sandboxed execution, row-level security or equivalent, an impersonation audit, SSO. None is needed for launch. What stays compatible:

- **Hostnames are the contract.** Customers only see `<slug>.agentdash.cloud`; the router is the seam. In Option B a route points at the shared app plus a tenant, and a box moves without its URL changing.
- **The issuer is per host.** The shared app must derive issuer, resource URI and cookie scope from the host so Muse grants survive a move. Nothing may put a Railway host in links, tokens or customer config.
- **`boxes.kind`** reserves `shared`, and control-plane `accounts` are not box users, so a move touches no front-door identity.
- **Company portability is the migration tool:** export and import must carry assistant grants, Hermes profiles and the provider key. Keep that round trip tested.
- **Company scoping everywhere,** even with one company per box (#739).
- **Billing already flows through the control plane** (§3.7); owning the Stripe customer there is the Option B step.
- **No box-level customer features** (shell, custom images, direct database access) a shared app could not offer.

---

## 9. Milestones as PR-sized issues

Sizes: S up to 2 days, M 3 to 5 days, L more than a week. Lanes: **Claude** (control plane, secrets, payments: security-sensitive, stays on Claude), **Devin** (box-side and UI), **Founder**. Every PR follows the repo rules: a worktree under `.claude/worktrees/`, one PR per issue, a body that passes `scripts/ci/check-pr-process.mjs`, `[no-prompt-update]` where server routes or services change, and `pnpm -r typecheck && pnpm test:run && pnpm build` in Verification.

### 9.1 Founder actions (start day 1)

| ID | Action | Needed by | Blocks |
|---|---|---|---|
| F1 #756 | Create a **Railway Pro workspace** `agentdash-boxes` used only for customer boxes and the control plane; create a **workspace token** and hand it over through the password manager | 9/29 | SC-2 onward |
| F2 #757 | **Resend** account; verify `mail.agentdash.cloud` (SPF and DKIM TXT records at GoDaddy) | 10/1 | SC-7, SC-8 |
| F3 #758 | **GoDaddy:** the three records in §4.1, once the router exists and Railway prints them | 10/2 | SC-4 acceptance, everything after |
| F4 #759 | **Stripe:** live account, Pro price, two restricted keys made by hand; **Cloudflare** account for a Turnstile site key (no DNS move) | 10/6 | SC-7, SC-8 |
| F5 #760 | Copy the old instance's invite codes into the control plane; approve retiring it after export | 10/9 | SC-9 |

### 9.2 Code issues, in critical-path order

| ID | Title | Size | Lane | Depends on | Acceptance and verification |
|---|---|---|---|---|---|
| SC-0 #761 | **Spike:** Postgres by API, router behaviour through two Railway edges (`X-Forwarded-Host`, WebSocket, latency), Volume redeploy downtime | S (1 day) | Claude | F1 | Findings note; a throwaway box created and deleted by API only; latency and downtime measured |
| #732 | GHCR image per stable tag, digest in the release body | S | Claude | none | The next stable cut publishes `ghcr.io/thetangstr/agentdash:vYYYY.MDD.P` and `provision-box.sh` deploys it |
| SC-1 #762 | **Control plane skeleton:** `cloud/` package, schema and migrations (§3.2), settings, admin CLI, redacting logger, deploy config | M | Claude | F1 | Embedded-PG schema tests; a log-redaction test; deployed, `/health` 200 |
| SC-2 #763 | **Railway provisioner:** §3.3 steps as idempotent TS, secret rules, name guards, escrow sealing | L (5 to 6 days) | Claude | SC-0, SC-1, #732 | Every `provision-box.test.mjs` scenario ported to a fake Railway API; no generated secret in captured logs; a real box healthy in under 3 minutes, then deleted |
| SC-3 #764 | **Job queue and state machine** (§3.4): locks, retries, timeouts, cleanup | M | Claude | SC-1 | A crash mid-step resumes there; 429 backs off; retries end in `failed`; cleanup refuses a claimed box or a name or ID mismatch |
| SC-4 #765 | **Edge router** (§4.3): routing, headers, WebSocket, streaming, 404, wake page, activity, 2 replicas | M | Devin | SC-1, F3 | Tests for header strip and inject, WebSocket upgrade, unknown and suspended slugs; live `https://<test>.agentdash.cloud/api/health` with a valid wildcard certificate |
| SC-5 #766 | **Box behind the edge** (§4.4): edge secret gate, client IP from the edge, boot-guard check | S | Devin | none | Embedded tests: no edge header refused except health; spoofed IP header ignored; rate limit keys on the edge IP |
| SC-6 #767 | **Claim** (§3.5): email-bound single-use code, `claimed` in health, `/claim` page to `/cos` | M | Devin | none | Wrong email refused; second use refused; company invites unaffected; MCP sign-up bound the same way; `/claim` UI test; a Playwright run on a real box |
| SC-7 #768 | **Front door:** `/start`, progress, `/find`; public API; §5.1 controls; waitlist; Resend mail | M | Devin (UI), Claude (API) | SC-1, SC-3, F2, F4 | Tests for rate limits, disposable refusal, kill switch, cap overflow to waitlist, single-use magic links; a real signup reaches "ready" |
| SC-8 #769 | **Stripe fan-out, shared restricted key rotation, per-box Resend keys** (§3.7), the `box_slug` metadata line | M | Claude | SC-2, F4 | A forwarded event passes the box's unmodified `constructEvent`; unknown slug dropped and alerted; in test mode a trial start moves `planTier` to `pro_trial` |
| SC-9 #770 | **Old instance migration** (§7): validator, `vercel.json`, CTAs, claims test | S | Devin | SC-1, F5 | `POST https://www.agentdash.cloud/api/invites/validate` answers from the control plane; a self-hosted MCP sign-up with a code still works |
| SC-10 #771 | **Fleet health and idle policy** (§5.2, §6.3): poller, alerts, suspend and wake, spend alarm | M | Claude | SC-3, SC-4 | Tests for each idle transition; a real box suspended and woken through the router in about a minute |
| SC-11 #772 | **End-to-end and runbook:** Playwright journey on a staging control plane (signup to `/cos`, provider key, Muse OAuth metadata on the slug host), 10 concurrent signups, `doc/runbooks/cloud-control-plane.md` | M | Devin | SC-2 to SC-8 | Three passes in a row; 10 healthy boxes and no dead jobs; runbook covers kill switch, approve, retry, suspend, delete, token rotation |
| SC-12 #773 | **Fleet upgrade** (§6.1): canary, cohorts, snapshot, rollback, hold | M | Claude | SC-2, SC-10 | A failing box pauses the rollout and rolls back (fake Railway); two live boxes upgraded. **May land after launch;** until then an operator upgrades per box with the same module |

### 9.3 Schedule and whether 2026-10-28 holds

| Days (from 9/26) | Claude lane | Devin lane (alongside M4, M5, M6) | Founder |
|---|---|---|---|
| 1 to 2 | SC-0, SC-1, #732 | SC-5 | F1, F2 |
| 3 to 7 | SC-2, SC-3 | SC-6, SC-4 | F3, F4 |
| 8 to 10 | SC-8, SC-7 API | SC-7 UI, SC-9 | F5 |
| 11 to 13 | SC-10 | SC-11 | |
| after | SC-12 | | |

That is about 22 to 26 lane-days, finishing around **10/14** with two lanes, which leaves two weeks for a staging soak and fixes.

**The honest answer:** 10-28 **holds for self-serve with waitlist mode on and a daily cap of 10** (automation provisions everything; an operator only clicks approve), provided a Claude lane owns SC-0 to SC-3, #732, SC-8, SC-10 and SC-12, because Devin's queue is already full with M4 to M6 (MVL §5). On the Devin lane the control plane slips about two weeks. **Fully open signup on 10-28 does not hold responsibly:** open it about **11-04**, after a week of real signups. **Fallback:** if SC-2 slips, launch 10-28 with runbook-provisioned boxes behind the same waitlist page and switch automation on when it lands.

---

## 10. Founder decisions (approved 2026-09-25)

All six recommendations were approved as written:

1. **DNS stays at GoDaddy** with the Railway edge router (three records, §4.1); no Cloudflare move.
2. **A dedicated Railway Pro workspace** for boxes; a second workspace or Enterprise near about 80 boxes.
3. **10-28 launches behind a waitlist** with operator approval and a cap of 10 a day; signup opens fully about 11-04.
4. **One Stripe account**, restricted keys, and control-plane webhook forwarding (§3.7). The risk that a compromised box's key can read other customers' Stripe objects of the allowed types is accepted until Option B. *Correction found while filing:* Stripe cannot mint restricted keys by API, so the keys are one shared restricted key rotated fleet-wide, not one per box.
5. **Free boxes:** one per verified email; warn at 14 idle days, suspend at 21, delete at 60 (§5.2).
6. **Support access** only when the customer invites `support@agentdash.cloud` into their company (§6.4).

---

## Sources

- Railway, wildcard domains, the `_acme-challenge` CNAME to `authorize.railwaydns.net`, the TXT requirement and custom domain limits per plan: [Working with Domains](https://docs.railway.com/networking/domains/working-with-domains)
- Railway HTTP duration limits and WebSockets: [Public networking specs and limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- Railway token types and API rate limits: [Public API](https://docs.railway.com/integrations/api)
- Railway resource prices and plan limits: [Pricing plans](https://docs.railway.com/reference/pricing/plans)
- Railway project limits per workspace (Hobby 50, Pro 100, Enterprise unlimited): [Railway staff answer, 2025-12-19](https://station.railway.com/questions/projects-limits-797a0c14)
- Stripe's 16 webhook endpoints per account: [Stripe webhooks guide](https://hookdeck.com/webhooks/platforms/guide-to-stripe-webhooks-features-and-best-practices), [Stripe API: webhook endpoints](https://docs.stripe.com/api/webhook_endpoints)
- DNS for agentdash.cloud checked with `dig` on 2026-09-25: GoDaddy nameservers, no CAA record, `www` on Vercel, Google MX
