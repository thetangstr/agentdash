# Mac Mini Test Deployment Runbook — AgentDash-MK

**Date:** 2026-08-03
**Deploys:** `main` @ `cd296cf5` — the harness, deliverable pipeline, and measurement (#467)
**Mode:** on-prem, `claude_local` (BYOT), 6-month free license
**Supersedes:** [`2026-08-02-mac-mini-test-runbook.md`](2026-08-02-mac-mini-test-runbook.md) — that one
predates the merge and four of its instructions are now wrong. Use this one.

---

## 0. What changed since the 2026-08-02 runbook

Read this section even if you read the last runbook, because the install steps reversed.

| The 08-02 runbook said | Now |
|---|---|
| Deploy `codex/agentdash-mk` @ `87cade25`; **do not merge** | Merged as `cd296cf5`. **Deploy `main`.** |
| `pnpm install` **NON-frozen**; never `--frozen-lockfile` | `pnpm-lock.yaml` is tracked on `main`. **Use `--frozen-lockfile`.** |
| Offline fallback: `agentdash-mk-87cade25.bundle` on the hosted volume | Removed as redundant. Clone from GitHub. |
| Migrations 0096–0105 | Migrations **0096–0114** |

The CI gap that blocked merging (three required checks running `--frozen-lockfile` against an
intentionally uncommitted lockfile) is closed: #467 merged with a lockfile refresh, and the
`verify` lane timeout is now 35 minutes.

---

## 1. What is and isn't in scope

- **In scope:** the AgentDash-MK workforce loop — stewardship, owner ceilings, steward
  approvals, My Agent + Inbox, the weekly deliverable pipeline (B measurement → C facts →
  G pipeline → H recommendations), Telegram, WhatsApp, HubSpot per-steward BYO keys,
  OBO/SharePoint.
- **Deprioritized — do not test as complete:** Microsoft Teams
  ([scope override 2026-07-30](../../docs/superpowers/specs/2026-07-30-agentdash-mk-scope-override.md)).
  The code and its tests remain and keep running; the gap stays visible rather than skipped.
- **The actual point of this test:** *no real weekly cycle has ever run.* Every figure so far
  came from a mocked Microsoft Graph, and no approver has read the review surface. This
  deployment exists to run **one real end-to-end cycle** against live credentials. See §5.

## 2. Pre-visit prep (on your machine, before the mac mini)

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
`github.com/thetangstr/agentdash`, and — if the mini will run in `authenticated` mode — the
**MK invite code** you intend to set (§4.1). Decide that before you travel.

## 3. On the mac mini — prerequisites

```sh
node --version     # need 20+ (24 recommended; CI runs 24)
pnpm --version     # need 9.15.4 (repo pins packageManager: pnpm@9.15.4)
git --version
which claude && claude --version        # Claude Code CLI must be present
echo "Respond with hello" | claude --print -   # confirms Claude auth works
```

If `claude` prompts for login, sign in with the customer's Claude account (this is the BYOT
compute). Do not type credentials from any screen into AgentDash.

**GitHub auth:** a fresh Mac has none. `git clone` over HTTPS on a public repo needs no auth,
so the clone below works — but if you later need to push, install `gh` and run
`gh auth login -h github.com` first. Neither an SSH key nor a keychain credential carries
over from another machine.

## 4. Install

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
git log --oneline -1                     # expect cd296cf5 (or later on main)

pnpm install --frozen-lockfile           # the lockfile is tracked now; frozen is correct
pnpm build                               # all packages
pnpm --filter @paperclipai/db run check:migrations   # expect exit 0 (0096–0114, additive)
```

Optional confidence check before wiring live creds:
```sh
pnpm -r typecheck && pnpm test:run
```

> Record the real suite figure when you run it. The last recorded count, 4,560, was measured at
> `87cade25` **before** the merge; it has not been re-recorded on `main`. Report what you see
> rather than repeating that number.

## 4.1 The one new trap: deployment mode vs. the MK invite gate

This did not exist when the 08-02 runbook was written, and it will stop you at company
creation if you meet it cold.

`PAPERCLIP_DEPLOYMENT_MODE` defaults to `local_trusted`. The two modes behave differently for
**creating an `agentdash_mk`-profile company**:

| Mode | MK profile at company creation | Host binding |
|---|---|---|
| `local_trusted` (default) | **Ungated** | **Must bind loopback** — the server refuses to start on a non-loopback host in this mode |
| `authenticated` | **Requires** a code from `AGENTDASH_MK_INVITE_CODES` | Any |

So:

- **Testing alone on the mini itself** → `local_trusted`, bound to loopback, no invite code needed.
- **Real MKThink humans reaching it over the network** (which the two-approver flow in §5
  requires) → `authenticated`, and you **must** set `AGENTDASH_MK_INVITE_CODES` before creating
  the company, or the request is refused. MK is opt-in, not merely unadvertised.

Requesting a non-default `productProfile` without a code is refused by design. Profile-gated
routes return **404 off-profile, not 403** — a 404 on an MK surface means the company is on the
wrong profile, not that the route is missing.

## 4.2 Configure `.env`

Copy `.env.example` → `.env` and set at least:

```sh
AGENTDASH_DEPLOYMENT_KIND=on_prem
AGENTDASH_ENFORCE_LICENSE=true
AGENTDASH_LICENSE_KEY=<token from §2>
AGENTDASH_LICENSE_PUBLIC_KEY=<public key PEM from §2>
AGENTDASH_DEFAULT_ADAPTER=claude_local        # BYOT: uses the local `claude` CLI, no markup
DATABASE_URL=<postgres url>                    # local Postgres on the mini
BETTER_AUTH_SECRET=<generate a strong secret; do not rotate later>
PAPERCLIP_PUBLIC_URL=<the mini's origin, e.g. http://localhost:3000>

PAPERCLIP_DEPLOYMENT_MODE=<local_trusted | authenticated>   # see §4.1
AGENTDASH_MK_INVITE_CODES=<code>                            # REQUIRED in authenticated mode
```

For Telegram, also set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.

WhatsApp, HubSpot, and Microsoft Graph are **not** environment-configured — HubSpot is a
per-steward BYO key and Graph is per-user OBO, so both are wired in-product per company. Email
and Stripe stay OFF for an on-prem test; the license, not billing, is what gates this install.

## 5. Run + the first real cycle (the reason we're here)

1. Start the server (per [`doc/DEVELOPING.md`](../DEVELOPING.md) / [`doc/LAUNCH.md`](../LAUNCH.md)),
   confirm it boots and migrations apply.
2. Create an **`agentdash_mk`**-profile company (see §4.1 on the invite code).
3. Assign a steward to an agent; confirm My Agent + Inbox load server-backed.
4. **Wire live Microsoft Graph (OBO/SharePoint) credentials** and define ONE weekly deliverable
   with its fact list — implementer-authored; **customers author nothing**.
5. **Run one real cycle** and watch, specifically:
   - **⚠️ OBO/SharePoint fail-closed:** if a real Entra OBO response omits `scope`, the agent
     fails **closed** — which presents as a *total outage*, not a subtle bug. This is the #1
     thing to confirm the moment a live tenant is connected (harness plan / architecture §F).
   - Measurement events actually emit from the real path (minutes of human review, % no-touch,
     correction counts, stalls) — not just in tests.
   - The two-approver sequential flow (first approver, then senior) gates shipping; nothing
     ships without both.
   - Provenance carries on every agent↔agent fact answer.

**You should not need to poke it.** Both timers are wired in `server/src/index.ts`: lapsed
leases sweep every 60s, and the deliverable pipeline ticks every 2 minutes, running its four
stages sequenced on one tick. Every stage is idempotent, so a person's answer moves the cycle
on within about two minutes of arriving. If a cycle sits still, that is a finding — not
something to work around by calling a service by hand.

## 6. Known caveats / watch-items

Operational gaps that are real and currently open — none block the cycle, but do not be
surprised by them at the mini:

- **Channel pairing is not self-serve.** The `HumanChannelBindings` settings component was
  never built, so Telegram/WhatsApp pairing has no UI. Expect to do it out-of-band.
- **Ceiling violation messages are unreachable in the UI.** There is no steward-request editor,
  and `AgentCeilingEditor` exposes 4 of 7 dimensions and has no test.
- **`destructiveActions` binds nothing at action time.** It is rejected on configuration write
  and clamped on narrowing, but no action-time check reads it — nothing classifies an action as
  destructive yet.
- **`outcome_unknown` has no operator surface.** An ambiguous HubSpot write is recorded and
  never retried (correct), but nothing lists these for a human to reconcile against the CRM;
  it is discoverable only by query.
- **HubSpot writes attribute to the app, not the person** — a private-app token is
  portal-scoped, so AgentDash records who requested and approved every write and HubSpot does
  not. Accepted by the product owner 2026-07-30; stated in the UI rather than hidden.
- **WhatsApp outside the 24-hour window** reports an approval card undelivered rather than
  sending it, because a Meta-reviewed utility template is an operator provisioning step this
  build does not assume.
- **The bridge has no push and no long-poll.** A closed laptop receives nothing, and an agent
  that files a task learns the outcome only by polling.
- **Teams:** deprioritized — present, not to be validated as complete.
- **Nothing validated until this runs:** the machinery is proven in tests; its judgement is not.

## 7. Rollback

On-prem, free trial — low blast radius. Stop the server, drop the local DB, remove the checkout.
See [`2026-05-27-mac-mini-rollback-runbook.md`](2026-05-27-mac-mini-rollback-runbook.md) for the
fuller rollback if a managed install was used.
