# Agent Dash SaaS offering — discovery and proposal (working plan)

Status: **design exploration, nothing built, nothing bought.** Founder direction of 2026-09-07
(separate file, read in full): after the evaluator authority/milestone preparation, think
through and design Agent Dash's SaaS offering and the signup-to-box journey for
agentdash.cloud. This is planning and design authorization only — no infrastructure
deploys, purchases, billing activation, or implementation of an unapproved business model.
The public marketing redesign with an embedded interactive demo is a **separate task**; this
plan does not assume it has started or succeeded, and §7 is its interface brief.

Every statement below is tagged **FACT** (verified in the repository or against the live
site on 2026-09-07), **PRIOR PROPOSAL** (a plan already in the repo, not a decision),
**PROPOSED** (this plan's recommendation) or **DECISION** (the founder's to make, §6).

## 0. The question and the one-paragraph answer

The founder wants prospects to visit agentdash.cloud, sign up, and receive their own hosted
Agent Dash environment ("a new box"). Today the site's login leads into one shared Railway
instance with no administrator bootstrapped, and nothing anywhere provisions a new instance
for a new customer. The product's isolation model (one process, one Postgres, one secrets
master key and host-wide model credentials per instance, agents run as subprocesses on the
serving host) makes **shared multi-tenancy with real agent execution unsafe as built**. The
recommended initial model is therefore **one managed instance per paying customer** —
"a box" is a dedicated instance we operate — reached through a thin identity-and-order
front door on agentdash.cloud, provisioned by runbook first and by automation second, with
the existing in-box onboarding (company → assess → CoS chat → first hire → invites) as the
first useful workflow. Shared tenancy stays a later scale optimisation behind explicit gates.

## 1. Established facts

### 1.1 What agentdash.cloud is today (live, 2026-09-07)

- **FACT** `www.agentdash.cloud` is a Vercel deployment of the repo's UI bundle
  (`vercel.json`: build `ui/dist`, rewrite `/api/:path*` to one Railway service,
  `web-production-33a3b6.up.railway.app`). The marketing landing (`ui/src/marketing/pages/Landing.tsx`)
  is the SPA's root route when logged out; logged in it redirects to `/companies`.
- **FACT** That Railway instance answers `/api/health` with `deploymentMode: authenticated`,
  `bootstrapStatus: bootstrap_pending` (no `instance_admin` role exists on it —
  `server/src/routes/health.ts:93-103`), `instanceHasCompany: true`, `selfServeBootstrap: false`;
  Google and Microsoft sign-in are off. Its build version is not observable from outside (no
  version route). The auto-deploy workflow `.github/workflows/deploy.yml` is inert unless a
  `RAILWAY_TOKEN` secret exists; whether it is set is the open decision AGE-26.
- **FACT** The landing CTAs read "Start free — No credit card · Free single-seat tier" and
  point at `/auth?mode=sign_up` on that same instance (`ui/src/marketing/sections/Hero.tsx`,
  `FinalCTA.tsx`); "Talk to sales" is a mailto.
- **FACT** The apex `agentdash.cloud` resolves to a host whose certificate does not match the
  name (HTTPS fails); `hq.agentdash.cloud` resolves to a Tailscale-only address (the internal
  dogfood box). `www` is the only working public name.
- **FACT** The repo designs `POST /api/invites/validate` on `www.agentdash.cloud` as "the cloud
  side of the fresh-install funnel gate … the seed of the future license/entitlement service"
  (`server/src/routes/invite-codes.ts`); self-hosted installs fail closed if it is unreachable
  (`doc/GETTING-STARTED.md`). Its live availability was not exercised (no POST was made).

### 1.2 Product shape (repository)

- **FACT** One Node/Express process + one Postgres per **instance** (`~/.paperclip/instances/<id>`,
  `PAPERCLIP_INSTANCE_ID`, embedded Postgres or `DATABASE_URL`; `server/src/home-paths.ts`).
  Two deployment modes: `local_trusted` (no auth, synthetic `local-board` admin) and
  `authenticated` with exposure `private|public` (`doc/DEPLOYMENT-MODES.md`).
- **FACT** Identity is Better Auth, email + password, optional Google/Microsoft, email
  verification **not** enforced; sign-up can be disabled, invite-code gated or corp-email
  gated — all off by default (`server/src/auth/better-auth.ts`, `server/src/middleware/*signup-guard.ts`).
- **FACT** Companies are many per instance; memberships are many-to-many (roles `admin`/`member`,
  plus instance-wide `instance_admin`); a **single-workspace-per-installation guard** is on by
  default with a Pro-plan carve-out and env overrides (`server/src/routes/companies.ts:428-455`).
- **FACT** v2 sign-up flow: `/company-create` → `/assess?onboarding=1` → `/cos`; the orchestrator
  creates the company, the membership, a Chief-of-Staff agent and the first conversation;
  teammate invites go out via Resend (`server/src/routes/onboarding-v2.ts`).
- **FACT** There is **no HTTP or CLI path that provisions a new instance** for a new customer; the
  only instance-per-thing tooling is the developer worktree CLI.

### 1.3 Isolation as built

- **FACT** Company boundaries are enforced at the application layer (`assertCompanyAccess`,
  `companyId` filters); no row-level security, no per-company process, worker or database.
- **FACT** Company secrets are encrypted per value with **one master key per instance**
  (`server/src/secrets/local-encrypted-provider.ts`); agent JWT signing keys are derived per
  (instance, company). Rate limits are per actor, not per company. Plugin workers are one
  process per plugin shared across companies and are "trusted code". All schedulers (heartbeat,
  routines, ingest, billing reconcile) run on one event loop.
- **FACT** **Agents execute as subprocesses on the serving host** (Claude, Codex, Cursor, Gemini,
  OpenCode, Pi CLIs; the Dockerfile installs them globally), under credentials that are
  **process-global** (`~/.config/agentdash/agentdash.env`, "NEVER written to the DB",
  `server/src/services/adapter-presets.ts`); Hermes keeps its own provider config under the
  host user. Sandboxing is optional macOS Seatbelt, default off; non-macOS hosts refuse to
  sandbox (`doc/AGENT-SANDBOX.md`). Off-box execution exists only as opt-in environment drivers:
  SSH remote target and an E2B cloud-sandbox plugin.

### 1.4 Billing and accounting as built

- **FACT implemented:** Stripe checkout/portal/status/usage/webhook with an idempotency ledger;
  tiers `free`, `pro_trial`, `pro_active` (and downgraded states); Free caps 1 human + 1 agent
  (env-tunable); Pro unlimited with seat-quantity sync; trial with no card
  (`payment_method_collection: if_required`, `STRIPE_TRIAL_DAYS`); daily trial reconciliation;
  caps enforced at write paths; run quotas (Free 50 included runs → hard block; Pro 1000 + 250
  per seat → soft-allow tagged overage); `cost_events` ledger with monthly rollups per agent and
  company; scoped hard-stop budgets; Hermes token metering (cost only when Hermes reports a
  non-zero price). All gated by `STRIPE_SECRET_KEY`; unset = caps bypassed
  (`server/src/routes/billing.ts`, `services/{billing,entitlement-sync,tier-policy,quota*,costs,budgets}.ts`).
- **FACT not built:** overage → Stripe charge (AGE-122), per-agent ledger UX (AGE-123), 80 %
  quota warning (AGE-124); the Stripe Billing Meters reporter exists with no caller; the
  `requireTier` middleware is dead code; **on-prem license enforcement is not wired**
  (`requireLicense` has no caller — `doc/GETTING-STARTED.md`).
- **FACT** Cost telemetry can be wrong: one run on the local instance recorded 450 000 cents with
  zero tokens (see the evaluator calibration plan, §4.1).

### 1.5 Deployment channels and operations

- **FACT** GHCR multi-arch image on every `main` push and `v*` tag; Railway service from the
  Dockerfile (`railway.json` healthcheck `/api/health`); VPS Docker Compose with an OTA
  image-pin updater and receipts/rollback (`doc/VPS-DEPLOYMENT.md`); Mac mini via launchd
  (Docker or the source-checkout fallback that the only live customer, MKThink, actually
  runs, updated with `scripts/deploy/agentdash-source-update.mjs`); canary/stable release
  lanes with signed release-control assets. No infrastructure-as-code of any kind.
- **FACT** Backups are logical `pg_dump`s that **exclude uploads, workspace files and the
  secrets master key**; per-instance readiness scripts and a `doctor` CLI exist; operator time
  per first install is 90–120 minutes today with a ≤30-minute target
  (`doc/customers/MINIMUM-REPEATABLE-DEPLOYMENT.md` §5).

### 1.6 Prior plans in the repository (proposals, not decisions)

| Doc | Position | Notes |
|---|---|---|
| `doc/plans/2026-05-29-vps-cloud-and-outcome-pricing.md` | P0 managed VPS per customer → P1 managed single-tenant cloud → P2 multi-tenant only after isolation tests, impersonation audit, SSO, per-tenant backup/restore | pricing: "do not sell seats"; managed instance + governed runs + accepted work + customer-defined value events; ramp with credited deposit and month-one cap |
| `doc/2026-06-08-deployment-and-inference-skus.md` | two SKUs from one trunk: Cloud (we host and provide inference via aggregators, usage-based) and On-prem (BYO keys, license + support) | argues personal Claude subscriptions may not back a multi-tenant SaaS (individual-use terms); G1–G5 claimed code-complete on a feature branch |
| `doc/plans/2026-07-23-business-plan.md` (agent-authored) | BYOT license tiers and Cloud Free / pay-as-you-go 1.5× / Pro + usage; "10 companies by Sep 30" | the date passed; treat as a prior proposal only |
| `doc/customers/MINIMUM-REPEATABLE-DEPLOYMENT.md` (2026-08-19) | single-tenant by default; multi-tenant deferred to P2; self-serve checkout P2; VPS $24–60/mo | the most recent and most grounded of the four |
| `CLAUDE.md` sub-project 4 | Free + Pro per-seat, 14-day no-card Stripe trial | this is what is **implemented** (§1.4) |

The unresolved conflict among them is the **pricing unit**: per-seat (built) vs
managed-instance/value events (May) vs usage markup (June/July). That is DECISION D-S2.

## 2. What a customer buys, and what a box is (PROPOSED)

**A box = one dedicated Agent Dash instance operated by us**: its own process, Postgres,
secrets master key, hostname (`<slug>.agentdash.cloud`), backups and update lane. The customer
gets one company in it (the default guard), their humans as members, their agents, and either
their own model credentials entered into the box or managed inference (D-S3). This is the May
plan's P1 and the August spec's "managed single-tenant"; it is the only shape the current
isolation model supports honestly. Alternatives considered:

| Shape | Verdict |
|---|---|
| **B. Company inside a shared instance** | not for paying customers while agents run as host subprocesses with host-wide credentials and one master key; acceptable only for a **read-only or scripted demo** (marketing task) |
| **C. Customer-owned machine** (existing on-prem path) | keep as the self-hosted SKU; it is not "a box we hand them" |
| **A. Dedicated managed instance** | **recommended initial model** |

**Journey (end to end, PROPOSED):**

1. **Visit** `www.agentdash.cloud` → honest claims (§7), one primary CTA.
2. **Sign up on the front door** (identity + order): email (verified), organisation name, region,
   plan choice, model-credential choice (bring your own / managed). The front door is a small
   control-plane app, not an Agent Dash instance; today's live Railway instance is not it.
3. **Provision**: state machine `requested → provisioning → ready → active → suspended →
   deleting → deleted`. Phase 1 runs the existing VPS/Docker OTA runbook by an operator (target
   ≤30 min, measured); Phase 2 automates it. The customer sees a status page, not a spinner.
4. **Hand-off email** with the box URL and a one-time admin sign-in (the board-claim flow already
   exists for exactly this: `doc/DEPLOYMENT-MODES.md` §board claim).
5. **First login in the box** → the existing v2 onboarding: company → assess → CoS interview →
   first agent hire → invite teammates.
6. **First useful workflow**: one governed task — the CoS proposes an agent plan, the founder
   confirms, the first agent runs a bounded task, a human approves the result. Success is
   measured as time-to-first-approved-result.
7. **Steady state**: OTA updates on the stable lane with backup and rollback; support access
   only with consent and audit (D-S7).

## 3. Isolated instances vs shared multi-tenancy (on the current architecture)

| Dimension | Isolated box per customer | Shared multi-tenant instance |
|---|---|---|
| Fits current code | yes — every instance already is this | partly — companies are multi per instance, but the single-workspace guard, host-wide credentials and one master key assume one customer |
| Security / isolation | network boundary; blast radius one customer; per-box master key; agent subprocesses see one customer's credentials | app-layer only; no RLS; one master key for every tenant's secrets; agents of tenant A run on the same host and credentials as tenant B; sandbox off by default; plugin workers trusted and shared |
| Provisioning | needs automation that does not exist (instance + DB + secrets + DNS + TLS + OTA lane) | exists (create company) — but the guard and the credential model must change first |
| Upgrades | per-box OTA pin with backup/rollback (exists); N boxes = N deploys, staggerable | one deploy for all; a bad migration hits everyone |
| Operations | N health checks, backups, log streams; fixed cost per box; readiness scripts exist per instance | one of each; cheaper per tenant; noisy neighbour on one event loop and one pool |
| Cost | VPS $24–60/mo per box (prior estimate) + operator time; Railway per-service pricing unknown here | marginal cost per tenant near zero; engineering cost of the isolation gates is the real price |
| Billing fit | Stripe already per company inside the box; needs a control-plane roll-up | Stripe per company works as built |
| What blocks it | provisioning automation; control plane for identity/entitlements/usage | tenant-isolation tests, per-company secrets keys, off-box sandboxed execution, RLS or equivalent, impersonation audit, SSO — the May plan's P2 gates, none met |

**PROPOSED verdict:** isolated boxes now; shared tenancy only as a demo surface, and as a
production option only after the P2 gates are proven.

## 4. Design areas (level: decisions and shapes, not implementation)

- **Identity and membership.** Two identity domains: the front door (one account per human,
  owns orders and billing) and each box (Better Auth users inside the instance). PROPOSED for
  Phase 1: the front door creates the box's first admin through the board-claim link; humans
  inside the box are managed by the existing membership model. Single sign-on across front door
  and box is a later gate (SSO/OIDC), DECISION D-S5 on whether to require it before Phase 2.
- **Provisioning lifecycle.** PROPOSED states as in §2 step 3, a `boxes` record in the front
  door (customer, region, plan, hostname, image SHA, state, receipts), and idempotent
  provisioning steps reusing the existing OTA scripts. The substrate (stay on Railway, VPS
  provider, or a Docker host we run) is DECISION D-S4; nothing here picks a vendor.
- **Agent and model credentials.** FACT: keys are per host, in an env file. PROPOSED: per box,
  the customer either enters their own keys (BYO; our cost zero; their terms) or we place a
  managed aggregator key (managed inference; usage metered; our COGS). The June doc's warning
  stands: personal assistant subscriptions are not a resale basis. DECISION D-S3.
- **Usage accounting and limits.** FACT: quotas, budgets and the cost ledger work per company
  and therefore per box. PROPOSED: the front door pulls each box's usage summary
  (`GET /api/billing/usage`, quota route) for roll-up and invoices; fix the cost telemetry
  defect before any customer sees a number.
- **Billing and pricing.** FACT: per-seat Free/Pro with a no-card trial is built. PROPOSED for
  Phase 1: keep it as the entitlement container inside the box, add a **managed-box fee** as the
  unit customers actually buy, and defer value-event pricing until a work ledger exists (May
  plan P0 list). No prices are proposed here; the prior proposals' numbers are candidates only.
  DECISION D-S2.
- **Upgrades.** FACT: OTA image pin, backup before apply, health and readiness after, receipts,
  rollback. PROPOSED: boxes follow the stable lane with a staggered rollout and a per-box
  "hold" flag; migrations auto-apply as on Railway today.
- **Data lifecycle.** FACT: backups exclude uploads, workspace files and the master key.
  PROPOSED: full-box backup (DB + uploads + workspaces + key) per box with defined retention,
  customer export via the existing company-portability service, and a deletion procedure with
  a grace period. Residency and retention defaults are DECISION D-S8.
- **Support.** FACT: on-prem support access is documented via Tailscale/SSH by consent. PROPOSED
  for managed boxes: no standing operator login; time-boxed access on request, logged in the
  box's activity log (the impersonation-audit gate). DECISION D-S7.

## 5. Recommended initial model, phases, validation

**Initial SaaS model (PROPOSED):** *Agent Dash Managed Box* — one dedicated instance per
customer, ordered on agentdash.cloud, provisioned by us, updated on the stable lane, priced as
a managed-box fee plus the existing in-box seat tiers, with BYO credentials at launch and
managed inference as an option once metering is trustworthy. Self-hosted stays the free
community path.

| Phase | Scope | Validation criteria (measured, not asserted) |
|---|---|---|
| **0. Truth and decisions** (no spend) | site claims corrected (§7); D-S1…D-S8 decided; the orphaned live Railway instance dispositioned (D-S6) | zero claims on the site that §1 contradicts |
| **1. Managed box by runbook** | front door = verified sign-up + order + status page; operator provisions with the existing VPS/OTA scripts; 3 design partners | provisioning ≤ 30 operator-minutes (MRD target); time-to-first-approved-result per customer; support minutes per box per week; one full backup-and-restore drill per box |
| **2. Automated provisioning and control plane** | `boxes` state machine, automated provision/suspend/delete, entitlement and usage roll-up, invite/license validator on `www` as the entitlement service | unattended provisioning success rate; upgrade rollout with zero customer-visible downtime beyond the stated window; usage numbers reconcile to the box ledgers |
| **3. Shared tenancy evaluation** (only if the gates are met) | tenant-isolation test suite, per-company secrets keys, off-box sandboxed execution, RLS or equivalent, impersonation audit, SSO | every gate has a passing test or record before any shared paying tenant |

## 6. Minimal founder decisions

- **D-S1** Box definition: adopt "one managed instance per customer" as the initial offering?
- **D-S2** Pricing unit for v1: keep the built per-seat Free/Pro inside the box plus a
  managed-box fee, or move to the May plan's value-event model first?
- **D-S3** Credentials at launch: bring-your-own only, or managed inference via an aggregator too?
- **D-S4** Hosting substrate for boxes (planning target only): Railway service per box, VPS
  provider, or a Docker host we operate.
- **D-S5** Identity: is one shared sign-on across front door and boxes required before Phase 2?
- **D-S6** The live Railway instance: it holds a company with no administrator and is what
  "Start free" signs into today — bootstrap it as the demo/front door, wipe it, or retire it;
  and resolve AGE-26 (auto-deploy on or off).
- **D-S7** Support access policy for managed boxes (consent, time-box, audit).
- **D-S8** Data residency and retention defaults for boxes.

## 7. Interface brief for the marketing-site task

- **Honest claims.** What exists: a self-hosted install driven by one prompt; a managed pilot
  operated by hand for one design partner; Free/Pro seat tiers with a no-card trial inside an
  instance; Stripe billing code. What does not exist and must not be implied: self-serve
  provisioning of a customer environment, a multi-tenant SaaS, usage-based billing, working
  license enforcement, single sign-on.
- **CTA readiness.** "Start free" currently signs users into a shared Railway instance with no
  administrator bootstrapped. Until Phase 1 is live, the primary CTA should be **request a
  managed box / join the list** or **book a walkthrough**, and the self-hosted path should be
  offered plainly as "install it yourself". Do not link the apex (certificate mismatch) or the
  `hq` subdomain (internal).
- **Demo vs live.** The embedded interactive demo must be labelled as a demo and run on
  fixture or scripted data, never on the live Railway instance or any customer box; no demo
  action may create accounts, companies or agents on a real instance.
- **Future signup hand-off.** Reserve a stable contract the front door will implement:
  `/signup` (identity) → `/order` (plan, credentials choice) → `/status/<box>` (provisioning
  state) → hand-off email; analytics events for each step; the invite/license validator on
  `www` as the seed entitlement service. The marketing pages should link to these routes only
  when they exist.

## 8. Not verified / open

- The live Railway instance's build version, company contents and whether sign-up is open on it
  (no write or sign-up was attempted; only `GET /api/health` and the public providers probe).
- Which parts of the June SKU branch (G1–G5) are on `main` beyond what §1.4 lists (the
  aggregator adapter and the metering helpers are present; the Stripe meter reporter has no caller).
- Railway per-service pricing and limits; DNS registrar of the apex; Vercel project ownership.
- Whether the MKThink-shape operator time (90–120 min) applies to a Docker/VPS box (estimated in
  the MRD, not measured).
