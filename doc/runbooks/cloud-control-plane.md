# Runbook: the self-serve cloud control plane

**Scope:** `cloud-control` and `cloud-migrate` in the Railway project `agentdash-cloud`, workspace "AgentDash Boxes". Design: `docs/superpowers/specs/2026-09-25-self-serve-cloud-design.md`. SC-11 (#772) extends this runbook with the full operator procedures (kill switch, approve, retry, suspend, delete, token rotation); this first version covers what exists as of SC-2 and SC-3.

## 1. Provisioning is locked until claim tracking lands

Turning provisioning on is **refused in code** (`cloud/src/capabilities.ts`, `claimTrackingReady = false`). `admin settings set provisioning_enabled true` answers 400, and even a stored `true` provisions nothing: the enqueue path and the job runner both treat provisioning as off while the capability is false.

Why: the control plane may delete a box that was never claimed (spec §3.4), and it may only do so on **positive evidence** from the box's own `/api/health` that it is unclaimed. Today's release does not report its claim (`claimed` arrives with SC-6, #767, and the edge gate with SC-5, #766), and `bootstrapStatus` stays `bootstrap_pending` after a founder has signed up, until they create a company. So the cleanup sweep never deletes a box whose claim state is unknown; it flags it (`cleanup_needs_operator` box event and an ops alert, at most once a day per box). The capability is flipped only by the pull request that lands SC-5 and SC-6 box-side, with a test that the sweep sees `claimed`.

## 2. Deploy order

1. `cloud-migrate` first, on every release that adds a migration. It holds the only superuser URL, runs the migrations as `cloud_owner`, re-applies `cloud_app`'s grants and revokes any role membership `cloud_app` has. Service settings (set through the API, since Railway no longer applies an uploaded `railway.json` to a new service): Dockerfile `cloud/Dockerfile`, start command `node dist/migrate.js`, restart policy NEVER, no health check, no domain.
2. `cloud-control` second. It refuses to start as a superuser, an owner, a member of any role, a role with DELETE, or on an unmigrated schema.

## 3. Escrow key custody (for the founder)

Every box's `PAPERCLIP_SECRETS_MASTER_KEY` is sealed (libsodium sealed box) to the **escrow public key** and stored as `boxes.master_key_escrow` in the form `e1.<key id>.<ciphertext>`. The control plane holds only the public key (`CLOUD_ESCROW_PUBLIC_KEY`) and cannot open a blob. The private key is the only way to recover a box whose master key is lost; if it leaks, its holder can open every escrowed key sealed to it.

**Custody rules**

- The private key lives **offline**: in the password manager as a secure note that only the founder can open, plus one printed copy in a sealed envelope stored away from the office. It is never on a server, in Railway, in a repository, in chat or in email.
- The key pair generated during the SC-2 build sits on the build Mac in the operator's `~/.agentdash-cloud/` directory (`escrow-secret-key`, mode 600). **Move it now:** copy the file's single line into the password-manager note and the printed copy, verify it (step 5 below), then delete the file (`rm -P` on macOS) and empty the Trash.
- Keep a record, next to the key, of the key id (printed by the tool) and the date it became active.

**Recovering a box's master key**

1. On an offline machine with a checkout of the repository, create a directory with mode 700 holding `escrow-public-key` and `escrow-secret-key` from the password manager.
2. Read the box's blob: `master_key_escrow` from the control plane's `boxes` row (an operator query; the blob is not secret).
3. `echo '<blob>' | pnpm --filter @agentdash/cloud-control escrow open --key-dir <dir> --out <file>`. The tool checks the blob's key id against the key, writes the master key to `<file>` with mode 600, and never prints it.
4. Restore it on the box as `PAPERCLIP_SECRETS_MASTER_KEY` (Railway variables), redeploy, then delete `<file>` and the key directory.
5. **Verification drill (do it once now, then yearly):** seal a test value with the public key and open it with the tool; the provisioner test `escrow key id and the offline tool` shows the exact round trip.

**Rotating the escrow key**

1. On the offline machine: `pnpm --filter @agentdash/cloud-control escrow keygen --out-dir <dir>`. It writes the new pair (secret key mode 600) and prints the public key and its key id.
2. Store the new private key under the custody rules above, **keeping the old one**: blobs already stored name the old key id and still need it.
3. Set `CLOUD_ESCROW_PUBLIC_KEY` on `cloud-control` to the new public key and redeploy. New boxes are sealed to the new key; the key id in each blob tells you which private key opens it.
4. Retire an old private key only after every blob naming its id has been re-escrowed (re-running a box's `variables` step with `master_key_escrow` cleared reads the live key and seals it to the current key) or its box deleted.

## 4. The front door (SC-7, GH #768)

www's `/start`, `/start/verify`, `/start/progress` and `/find` call `/api/cloud/*`, which `vercel.json` rewrites to `cloud-control`'s public routes (`cloud/src/routes/public.ts`). The flow: signup (checks, then a single-use 30-minute magic link by email; nothing is created yet) → the link (proves the email, creates the box, asks the queue for provisioning) → the progress page (polls `boxes/mine`) → the ready email and the **Open my workspace** button carry the box's claim link.

**While provisioning is gated (`claimTrackingReady=false`, today):** every verified signup becomes a `waitlisted` box with reason `kill_switch` and a `waiting` waitlist entry, and gets the "You're on the list" email. `admin waitlist approve <id>` (or `approve-next <n>`) moves the entry to `approved` and emails the person, but the box stays `waitlisted` (the page says "You're in"): nothing is queued and nothing is provisioned. A pass every minute (`admin waitlist release` runs it by hand) gives approved boxes their job once the gates open, oldest approval first, within the daily cap.

**Client address (GH #836 review):** a static `vercel.json` rewrite cannot add a request header from an environment variable, so www runs Vercel Routing Middleware (repo-root `middleware.js`, matcher `/api/cloud/:path*` and `/api/invites/validate`). It strips any client-sent `X-AgentDash-Edge-Proxy` and `X-AgentDash-Client-IP`, then, when the Vercel env var `CLOUD_VERCEL_PROXY_SECRET` is set, adds the secret and the visitor address Vercel's edge saw. A direct call to the Railway host cannot forge the address without the secret. `rate_events` is pruned hourly through `prune_rate_events()` (SECURITY DEFINER, never deletes rows younger than an hour).

**Controls (spec §5.1):** per visitor IP 3 signups an hour and 1 box a day; 5 boxes a day per non-freemail domain; one box per verified email (a second signup gets a "you already have a workspace" email, the same 202 answer); the disposable-domain list (`disposable-email-domains-js`) plus `CLOUD_DISPOSABLE_DOMAINS_EXTRA` / `_ALLOW`, and an MX record; find and resend 3 an hour per email; Turnstile on signup and find. **Without Turnstile keys, signups are accepted but every one waits for an operator's approval** (`needs_approval`), even with waitlist mode off.

**Variables on `cloud-control`:**

| Variable | Value |
|---|---|
| `CLOUD_RESEND_API_KEY` | the Resend key (already used for alerts). Without it `/start` and `/find` answer 503 |
| `CLOUD_MAIL_FROM` | default `AgentDash <no-reply@agentdash.cloud>` (agentdash.cloud is a verified Resend domain) |
| `CLOUD_PUBLIC_SITE_URL` | default `https://www.agentdash.cloud` (links in emails) |
| `CLOUD_VERCEL_PROXY_SECRET` | `openssl rand -hex 32`; the **same value** as the Vercel project's env var below. Only with it does the control plane believe `X-AgentDash-Client-IP` (compared in constant time); without it every limit keys on the connecting address, which through Vercel is Vercel's, so per-visitor limits collapse into one shared bucket until it is set |
| `CLOUD_TURNSTILE_SITE_KEY`, `CLOUD_TURNSTILE_SECRET_KEY` | together or not at all (founder action #759) |

**Deploy checklist**

1. `cloud-migrate` first (migrations `0006_front_door`: `signup_requests`, `cloud_sessions`, `rate_events`; and `0007_prune_rate_events`), then `cloud-control`.
2. Set the variables above on `cloud-control` (not the Turnstile pair until #759 is done). Keep `waitlist_mode=true`, `daily_cap=10`.
2b. **Vercel:** add `CLOUD_VERCEL_PROXY_SECRET` (the same value, Production scope only, marked sensitive) to the www project's environment variables. Never put it in `vercel.json`, a command line or a log.
3. `curl -s https://cloud-control-production.up.railway.app/api/cloud/config` answers `{"turnstileSiteKey":null,"signupOpen":true,"waitlist":true,…}`.
4. Deploy www (Vercel) with the `/api/cloud/:path*` rewrite; `curl -s https://www.agentdash.cloud/api/cloud/config` gives the same answer.
5. Sign up at `https://www.agentdash.cloud/start` from a private window: the verify email arrives from no-reply@agentdash.cloud, the link lands on "You're on the list", and `admin waitlist list` shows the entry. Check the `signup_requests.ip` of that row is your address, not a Vercel one; if it is Vercel's, the middleware is not running or the two secrets differ. Also check that `curl -s -X POST https://cloud-control-production.up.railway.app/api/cloud/signup -H 'Content-Type: application/json' -H 'X-AgentDash-Client-IP: 203.0.113.9' -d '{}'` is keyed by your own address (it is refused as `invalid_email`; the point is that no row or limit ever records 203.0.113.9).
5b. **Middleware check without a signup:** `curl -s https://www.agentdash.cloud/api/cloud/proxy-check` answers `{"trustedProxy":true}`; the same call straight to `https://cloud-control-production.up.railway.app/api/cloud/proxy-check` with a made-up `X-AgentDash-Edge-Proxy` answers `false`. It returns nothing else and is rate-limited (30 a minute per address). A Vercel preview can run the same check first (its rewrites point at the same control plane), once the preview scope has the secret too.
6. `admin waitlist approve <id>`: the approval email arrives and the page says "You're in"; `admin jobs list` shows no provision job (gated).

## 5. The self-hosted invite validator and www's API (SC-9, GH #770)

Fresh self-hosted installs call `https://www.agentdash.cloud/api/invites/validate` (`{code}` in, `{valid}` out) before creating their founding user. That URL now reaches `cloud-control` (`cloud/src/invites.ts`) through `vercel.json`; the contract is the box's `server/src/routes/invite-codes.ts` exactly: 200 `{valid}`, 400 `invalid_body`, 429 `{error:"Rate limited", retryAfter}` after 10 attempts per 15 minutes per client. Codes are stored only as an HMAC under `CLOUD_DATA_KEY` (old keys in `CLOUD_DATA_KEYS_PREVIOUS` still match). Every other `/api/*` path on www answers **410** from the control plane: nothing on www reaches the old shared instance any more. The per-client limit keys on the address www's middleware vouches for with `CLOUD_VERCEL_PROXY_SECRET` (section 4), never on a bare header.

**Old app routes on www** (`vercel.json` `redirects`, all temporary): `/auth`, `/auth/*`, `/login`, `/signin`, `/sign-in`, `/forgot-password`, `/reset-password`, `/invite/*`, `/board-claim/*`, `/cli-auth/*`, `/claim`, `/companies` go to `/find`; `/signup`, `/sign-up`, `/company-create`, `/onboarding`, `/trial` go to `/start`; `/share/*` goes to `/`; and a catch-all sends every other path without a dot to `/find` (company boards such as `/ACME/dashboard`, `/cos`, `/settings`). Kept: `/`, `/demo`, `/consulting`, `/about`, `/mcp`, `/start/*`, `/find`, `/terms`, `/privacy`, `/pricing`, `/investors`, `/assess/*`, `/api/*`, `/assets/*`, `/brands/*` and every file path. **Known gap:** `/assess` still loads but its API calls now get 410; it needs its own decision.

**Short codes:** `invites import` refuses codes under 12 characters and reports a length histogram (`lengths`, bucketed; never a code). At 10 guesses per 15 minutes per address, a short human-chosen code falls to a guesser with many addresses. The old instance's `AGENTDASH_INVITE_CODES` is free-form (no format or minimum in any release), so read the histogram first; `--allow-short` imports them anyway, and the better fix is to issue replacements with `invites add`.

**Operator commands** (every change lands in `operator_audit` as `invite_codes_changed`, with counts and ids, never a code):

```sh
# F5 (#760): copy the old instance's codes once. Paste them on stdin; nothing is echoed back.
pnpm --filter @agentdash/cloud-control admin invites import old-instance < codes.txt   # add --allow-short only on purpose
pnpm --filter @agentdash/cloud-control admin invites add "<label>"      # prints one new code, once
pnpm --filter @agentdash/cloud-control admin invites list               # ids and labels only
pnpm --filter @agentdash/cloud-control admin invites revoke <id>
```

To read the old instance's codes without printing them: `railway variables --service web --kv | grep '^AGENTDASH_INVITE_CODES=' | cut -d= -f2- > codes.txt` in the old `agentdash` project (founder only; the control plane's token cannot reach it), run the import, then `rm -P codes.txt`.

**Deploy checklist (after SC-7's)**

1. `cloud-migrate` (migrations `0007_prune_rate_events` from SC-7 and `0008_invite_audit`), then `cloud-control`.
2. F5: import the old codes (above). `admin invites list` shows them.
3. Against the control plane directly: `curl -s -X POST https://cloud-control-production.up.railway.app/api/invites/validate -H 'Content-Type: application/json' -d '{"code":"<a known code>"}'` answers `{"valid":true}`, and a wrong code `{"valid":false}`.
4. Deploy www with the new `vercel.json`. Repeat step 3 against `https://www.agentdash.cloud/api/invites/validate`; `curl -s -o /dev/null -w '%{http_code}' https://www.agentdash.cloud/api/health` answers 410.
5. A self-hosted MCP sign-up with a code against the default URL succeeds (`AGENTDASH_INVITE_VALIDATION_URL` unset); with a wrong code it answers 403 `invalid_invite_code`.
6. www: "Start free" opens `/start`, "Sign in" opens `/find`.
7. Comment the import command and the step 3 and 4 output on #760.

**Rollback:** revert the `vercel.json` change and redeploy www; the old instance still answers `/api/*` until it is retired.

## 6. Retiring the old shared instance (founder, after #760)

The old instance is the Railway project `agentdash`, service `web` (`web-production-33a3b6.up.railway.app`). Nothing in the control plane can reach it (its token is scoped to the boxes workspace), and **no step here is automated**: the founder runs each one and approves the retirement on #760. Do not start until section 5's checklist has passed and www has served the new `vercel.json` for at least 7 days with no `/api/*` traffic you need (Vercel's logs show the 410s).

1. **Confirm nothing depends on it.** `grep -rn web-production-33a3b6` in the repository: the remaining references are the release smoke test (`.github/workflows/deploy.yml`, `scripts/release-control-contract.test.mjs`) and historical docs. Retarget or delete the smoke test in its own pull request first; the Deploy workflow is inert without a `RAILWAY_TOKEN` secret.
2. **Record what it holds.** In the Railway dashboard, note its variables (names only), volumes and database size. Check whether any real user signed up there (the instance ran in `authenticated` mode with a company); if one did, tell them where their data goes before step 3.
3. **Export.** Follow the export plan on #675: a `pg_dump` of its Postgres and a copy of the `/paperclip` volume, encrypted, stored beside the other backups (runbook `hosted-box.md` §13 describes the restore test that export already passed). Record the file names and checksums on #760.
4. **Scale to zero.** Remove the `web` deployment (`railway down` in the project, or scale replicas to 0). Keep Postgres and the volume. Confirm `https://web-production-33a3b6.up.railway.app/api/health` no longer answers and that www and the self-hosted validator still work (section 5, steps 3 to 5).
5. **Wait 30 days.** Anything that still needed it surfaces here; scaling back up restores it as it was.
6. **Delete.** The founder deletes the project in the Railway dashboard, then records the date, the export's location and checksums on #760 and closes it.
