# Mac Mini Test Deployment Runbook — AgentDash-MK

> **SUPERSEDED 2026-08-03 — do not follow the install steps below.**
> The branch this deploys was merged to `main` as `cd296cf5` (#467), which reversed four
> instructions here: deploy `main` not `codex/agentdash-mk`, the lockfile is tracked so
> `--frozen-lockfile` is now correct, the offline bundle was removed, and migrations run to
> 0114. Use [`2026-08-03-mac-mini-test-runbook.md`](2026-08-03-mac-mini-test-runbook.md).
> Kept for the record; §5's real-cycle intent is unchanged and carried forward.

**Date:** 2026-08-02
**Deploys:** `codex/agentdash-mk` @ `87cade25` (harness slices 1,A,B,C,D,E,F,G,H + zk-flake fix + GLS plan)
**Mode:** on-prem, `claude_local` (BYOT), 6-month free license
**Supersedes:** [`2026-07-23-monday-customer-deployment.md`](2026-07-23-monday-customer-deployment.md) — that predates the harness work; use this one.

> **Why off-branch, not `main`:** the branch is intentionally NOT merged yet. Merging is
> blocked by a known CI gap (three required checks run `pnpm install --frozen-lockfile`,
> which fails because `pnpm-lock.yaml` is intentionally uncommitted while `package.json`
> carries `@microsoft/teams.apps`). The mac mini does a **non-frozen** install, which
> regenerates the lockfile locally and works — verified 2026-08-02. Merge to `main` only
> **after** a real cycle validates here.

---

## 0. What is and isn't in scope for this test

- **In scope:** the AgentDash-MK workforce loop — stewardship, owner ceilings, steward
  approvals, My Agent + Inbox, the weekly deliverable pipeline (B measurement → C facts →
  G pipeline → H recommendations), Telegram, WhatsApp, HubSpot per-steward keys, OBO/SharePoint.
- **Deprioritized (do not test as complete):** Microsoft Teams (scope override 2026-07-30).
- **The actual point of this test:** *no real weekly cycle has ever run.* Every figure so far
  came from a mocked Microsoft Graph. This deployment exists to run **one real end-to-end
  cycle** against live credentials. See §5.

---

## 1. Pre-visit prep (on your machine, before the mac mini)

Mint the license. `keygen` prints the public key to stdout (it does NOT write a `.pub` file) —
copy it. Keep the private key secret; it never leaves your machine.

```sh
cd <agentdash checkout>
node scripts/mint-license.mjs keygen --out ~/agentdash-license-private.pem
#   → copy the printed "-----BEGIN PUBLIC KEY-----" block (this is AGENTDASH_LICENSE_PUBLIC_KEY)

node scripts/mint-license.mjs mint \
  --key ~/agentdash-license-private.pem \
  --customer "<Design Partner Name>" \
  --plan on_prem \
  --days 180
#   → copy the printed token (this is AGENTDASH_LICENSE_KEY)
```

Bring: this runbook, the **public key** + **license token**, the repo URL
`github.com/thetangstr/agentdash`, and the branch name `codex/agentdash-mk`.
(Offline fallback: the `agentdash-mk-87cade25.bundle` on the hosted volume restores the same tip.)

## 2. On the mac mini — prerequisites

```sh
node --version     # need 20+ (24 recommended; CI runs 24)
pnpm --version     # need 9+ (CI pins 9.15.4)
git --version
which claude && claude --version        # Claude Code CLI must be present
echo "Respond with hello" | claude --print -   # confirms Claude auth works
```

If `claude` prompts for login, sign in with the customer's Claude account (this is the BYOT
compute). Do not type credentials from any screen into AgentDash.

## 3. Install (verified sequence)

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
git switch codex/agentdash-mk
git log --oneline -1                     # expect 87cade25

pnpm install                             # NON-frozen; regenerates lockfile locally. DO NOT use --frozen-lockfile.
pnpm build                               # all packages
pnpm --filter @paperclipai/db run check:migrations   # expect exit 0 (migrations 0096–0105, additive)
```

Optional confidence check before wiring live creds:
```sh
pnpm -r typecheck && pnpm test:run       # ~4,560 tests green as of 87cade25
```

## 4. Configure `.env` (on-prem + claude_local)

Copy `.env.example` → `.env` and set at least:

```sh
AGENTDASH_DEPLOYMENT_KIND=on_prem
AGENTDASH_ENFORCE_LICENSE=true
AGENTDASH_LICENSE_KEY=<token from §1>
AGENTDASH_LICENSE_PUBLIC_KEY=<public key PEM from §1>
AGENTDASH_DEFAULT_ADAPTER=claude_local        # BYOT: uses the local `claude` CLI, no markup
DATABASE_URL=<postgres url>                    # local Postgres on the mini
BETTER_AUTH_SECRET=<generate a strong secret; do not rotate later>
PAPERCLIP_PUBLIC_URL=<the mini's origin, e.g. http://localhost:3000>
```

See `.env.example` for the full list (auth mode, exposure, email/Stripe are OFF for an on-prem test).

## 5. Run + the first real cycle (the reason we're here)

1. Start the server (per `doc/DEVELOPING.md` / `LAUNCH.md`), confirm it boots and migrations apply.
2. Create an **`agentdash_mk`**-profile company (profile-gated routes 404 off-profile — that's expected).
3. Assign a steward to an agent; confirm My Agent + Inbox load server-backed.
4. **Wire live Microsoft Graph (OBO/SharePoint) credentials** and define ONE weekly deliverable
   with its fact list (implementer-authored; customers author nothing).
5. **Run one real cycle** and watch, specifically:
   - **⚠️ OBO/SharePoint fail-closed:** if a real Entra OBO response omits `scope`, the agent
     fails **closed** — which presents as a *total outage*, not a subtle bug. This is the #1
     thing to confirm the moment a live tenant is connected (harness plan / architecture §F).
   - Measurement events actually emit from the real path (minutes of human review, % no-touch,
     correction counts, stalls) — not just in tests.
   - The two-approver sequential flow (first approver, then senior) gates shipping; nothing
     ships without both.
   - Provenance carries on every agent↔agent fact answer.

## 6. Known caveats / watch-items

- **Teams:** deprioritized — present but not to be validated as complete.
- **zk flake:** fixed (`328073e9`); artifact downloads now verify Content-Length + atomic rename.
- **Frozen-lockfile / merge:** do not `--frozen-lockfile` here; that's the CI-merge gap, not a
  runtime issue. Merge to `main` after this test passes (then the `refresh-lockfile` bot
  reconciles the lockfile on main).
- **Nothing validated until this runs:** the machinery is proven in tests; its judgement is not.

## 7. Rollback

On-prem, free trial — low blast radius. Stop the server, drop the local DB, remove the checkout.
See [`2026-05-27-mac-mini-rollback-runbook.md`](2026-05-27-mac-mini-rollback-runbook.md) for the
fuller rollback if a managed install was used.
