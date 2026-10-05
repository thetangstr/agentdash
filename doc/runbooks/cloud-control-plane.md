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

**Old app routes on www** (`vercel.json` `redirects`, all temporary): `/auth`, `/auth/*`, `/login`, `/signin`, `/sign-in`, `/forgot-password`, `/reset-password`, `/invite/*`, `/board-claim/*`, `/cli-auth/*`, `/claim`, `/companies` go to `/find`; `/signup`, `/sign-up`, `/company-create`, `/onboarding`, `/trial` go to `/start`; `/share/*` goes to `/`; and a catch-all sends every other path without a dot to `/find` (company boards such as `/ACME/dashboard`, `/cos`, `/settings`). Kept: `/`, `/demo`, `/consulting`, `/about`, `/mcp`, `/start/*`, `/find`, `/terms`, `/privacy`, `/pricing`, `/investors`, `/assess/*`, `/api/*`, `/assets/*`, `/brands/*` and every file path. **`/assess` stays on the old instance for now:** `vercel.json` still sends exactly its API paths there, ahead of the 410 rule: `/api/health`, `/api/auth/get-session`, `/api/onboarding/finalize-assessment`, `/api/onboarding/complete-initial-assessment`, `/api/companies/:id/assess` and `/api/companies/:id/assess/*`.

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

0. **Re-home or pull `/assess` first.** www's readiness assessment still calls the old instance (section 5). Either move it (#838) or remove the page, its footer link and those six rewrites, before step 4; otherwise scaling to zero breaks `/assess` on the live site.
1. **Confirm nothing depends on it.** `grep -rn web-production-33a3b6` in the repository: the remaining references are the release smoke test (`.github/workflows/deploy.yml`, `scripts/release-control-contract.test.mjs`) and historical docs. Retarget or delete the smoke test in its own pull request first; the Deploy workflow is inert without a `RAILWAY_TOKEN` secret.
2. **Record what it holds.** In the Railway dashboard, note its variables (names only), volumes and database size. Check whether any real user signed up there (the instance ran in `authenticated` mode with a company); if one did, tell them where their data goes before step 3.
3. **Export.** Follow the export plan on #675: a `pg_dump` of its Postgres and a copy of the `/paperclip` volume, encrypted, stored beside the other backups (runbook `hosted-box.md` §13 describes the restore test that export already passed). Record the file names and checksums on #760.
4. **Scale to zero.** Remove the `web` deployment (`railway down` in the project, or scale replicas to 0). Keep Postgres and the volume. Confirm `https://web-production-33a3b6.up.railway.app/api/health` no longer answers and that www and the self-hosted validator still work (section 5, steps 3 to 5).
5. **Wait 30 days.** Anything that still needed it surfaces here; scaling back up restores it as it was.
6. **Delete.** The founder deletes the project in the Railway dashboard, then records the date, the export's location and checksums on #760 and closes it.

## 7. Box purpose and fleet upgrades (GH #861, SC-12 GH #773)

**Purpose.** Every box has a `purpose`: `customer` (default), `demo`, `canary` or `internal` (migration `0009_fleet_upgrade`). `demo` boxes are created with `hold_upgrades` on, so rollouts leave them on their pinned release. `canary` boxes are the first wave of every rollout: mark the launch box (or a dedicated canary box) as one.

```sh
A="pnpm --filter @agentdash/cloud-control admin"
$A boxes create demo-acme you@agentdash.cloud v2026.930.1 --purpose demo
$A boxes list --purpose demo
$A boxes purpose launch canary
$A boxes hold <slug>      # rollouts skip it; also for a customer who asks us to wait
$A boxes unhold <slug>
```

**What an upgrade does, per box** (`cloud/src/jobs/upgrade.ts`, one `upgrade` job; every step is recorded in `box_upgrades`, so a restarted control plane resumes it and never deploys twice): a Railway snapshot of both volumes; the web service pointed at the release's GHCR image **by digest**; `AGENTDASH_RELEASE_TAG` set (variables already upserted with skipDeploys, such as close-signup or the edge secret, ride this deploy); one deploy, waited to SUCCESS (15 min cap), and Railway's own record of that deployment (`meta`) must name the release's image digest (health's tag is the variable this job sets, so it proves only that a new deployment answers); then `/api/health` must report the exact `releaseTag` (and `releaseCommit`, when the box reports one, must match the tag's commit) on the Railway host and, once `CLOUD_EDGE_LIVE` is true, through the router (5 and 2 min caps). Every step first re-checks the project guards (boxes workspace, `agentdash-box-<slug>` name, never a protected project, this box's tag). On a failed deploy, a wrong digest or a health mismatch it restores the previous image and tag (or no tag, for an old box that had none), runs Railway's rollback to the previous deployment (a source-built box is redeployed at its recorded commit instead, never HEAD), checks the rollback deployment runs the previous digest or commit and the old release answers, sets `hold_upgrades` on the box, and pages ops. Migrations apply on boot: a rollback across a migration needs the pre-upgrade snapshot (hosted-box runbook §10).

**The pre-upgrade snapshots.** Railway caps a volume at `CLOUD_VOLUME_BACKUP_LIMIT` backups (default 10, the plan limit). Snapshots taken here are "Manual" backups and never expire on their own, so before each one the job deletes the oldest manual backups until a slot is free — never a scheduled backup, never a locked one, and never either of the newest two manual ones. Deletions run one at a time per volume and are polled for up to 5 minutes. A volume that still has no free slot fails the upgrade dead (the box is held, ops is paged) with the volume instance id in the error; free a backup in Railway and retry the upgrade.

**One box** (no rollout): `$A boxes upgrade <slug> [release]` queues it for the next window opening; `--now` runs it at once. The release defaults to `target_release`; a tag without a GHCR image is refused.

**A fleet rollout:**

1. `$A settings set target_release v2026.1001.0` (the image must be on GHCR; `rollout start` refuses a tag without one).
2. `$A rollout start` plans the waves and prints them: wave 0 the canary boxes, wave 1 the oldest 10 percent of the rest (at least one), then batches of 5, oldest first. Held, suspended and already-current boxes are listed as skipped.
3. Waves start only inside `upgrade_window` (default `02:00-05:00` in `upgrade_window_tz`, default `America/Los_Angeles`; `null` means always). The orchestrator ticks every minute and starts the next wave once the previous one has finished. `rollout start --now` ignores the window for that rollout; `$A rollout tick` runs a pass at once.
4. `$A rollout status` shows the plan, each box's state, the counts, the window and when it next opens.
5. **The first failure pauses the rollout** (`rollout_paused` true, audited as a setting change, with the reason on the rollout) and pages ops. Members of the same wave that had not started go back to planned. Investigate the held box (its `box_upgrades` row has the error and the last health answer; `box_events` has the trail), then `$A rollout resume` (the rest waits for the window again; `rollout resume --now` to carry on at once). The failed box stays held until `$A boxes unhold <slug>`; upgrade it alone with `boxes upgrade <slug> --now` once fixed.
6. `$A rollout pause [reason]` stops new upgrades by hand (in-flight ones finish); `$A rollout cancel` drops the remaining planned boxes.

**One job per box:** the job runner never runs two jobs of one box at once, and holds every other job (close-signup, delete, suspend) of a box whose upgrade is running or rolling back.

**Not covered yet:** the deployment `meta` digest read and the Railway snapshot and rollback mutations (`volumeInstanceBackupCreate`, `deploymentRollback`) are exercised against the fake Railway only; the first live run on two boxes (#773 acceptance) confirms them. If Railway's `meta` does not name the digest, every upgrade rolls back and holds its box (safe, loud): fix the read before a fleet rollout. Boxes do not report `releaseCommit` until their image carries a release marker.
## 8. Off-box backups (GH #733)

Three layers protect a hosted box's data, from fastest restore to most independent:

| Layer | What | Where | Restores |
|---|---|---|---|
| Railway snapshots | both volumes (database and `/paperclip`), daily and weekly, set by the provisioner's `snapshots` step (Pro workspace) | Railway | a whole volume, in the Railway dashboard |
| **Off-box database backup** | an encrypted logical dump of the box's database, nightly, 7 daily plus 4 weekly | S3-compatible bucket outside Railway | the database, with the `backup-restore` tool |
| `scripts/hosted/backup-box.sh` | the manual deep backup (dump, `/paperclip` tarball, snapshots) | the operator's machine | see `hosted-box.md` §9 |

The server's hourly backup on the box's own Volume stays, but it is not off-box.

**How the nightly backup works.** From `CLOUD_BACKUP_HOUR_UTC` (default 08:00 UTC, before the 02:00 Pacific upgrade window), the control plane claims one row per active box per UTC day in `box_backups`, reads the box's `AGENTDASH_BACKUP_TOKEN` from Railway (in memory only), and calls `POST /api/agentdash/backup-export` on the box's Railway host with that token and the box's edge secret. The box writes a fresh dump (the same library as its hourly backup) to a temp directory and streams it; the control plane encrypts it on the fly to the **backup public key** (libsodium sealed data key plus XChaCha20-Poly1305 secretstream, header authenticated), uploads it, records its size and SHA-256, and prunes the box to 7 daily plus 4 weekly backups. A failure is retried 30 minutes later, up to 3 times a day. On the box, an export is capped at 30 minutes: the route answers 504 and ends the dump's own database sessions. It refuses a second export until the first has really stopped, waiting at most 60 seconds more, so dumps never stack. An export that reports no applied migrations is never stored, so it cannot push good dailies out of retention. **The control plane cannot decrypt a backup**: like the master key escrow (section 3), only the offline secret key opens one.

**Boxes made before this change** have no `AGENTDASH_BACKUP_TOKEN` and run a release without the export route. The first backup attempt sets the token with `skipDeploys` (box event `backup_token_installed`) and fails with `token_pending_deploy`; once the box's next deploy runs a release with the route, backups start. New boxes get the token at provisioning.

**Variables on `cloud-control`** (all four `CLOUD_BACKUP_S3_*` credentials together or none; a partial set refuses to start):

| Variable | Value |
|---|---|
| `CLOUD_BACKUP_S3_ENDPOINT` | the store's https endpoint, e.g. `https://<account id>.r2.cloudflarestorage.com` (R2) or `https://s3.us-west-2.amazonaws.com` |
| `CLOUD_BACKUP_S3_BUCKET` | a **dedicated, private** bucket, e.g. `agentdash-box-backups`; turn on object versioning or object lock if the store offers it |
| `CLOUD_BACKUP_S3_REGION` | default `auto` (R2); the bucket's region for AWS |
| `CLOUD_BACKUP_S3_ACCESS_KEY_ID`, `CLOUD_BACKUP_S3_SECRET_ACCESS_KEY` | a key scoped to that one bucket: read, write and delete objects, nothing else |
| `CLOUD_BACKUP_S3_PREFIX` | default `boxes` |
| `CLOUD_BACKUP_S3_VIRTUAL_HOSTED` | `true` for `<bucket>.<host>` URLs; default path style, which R2 and MinIO need |
| `CLOUD_BACKUP_PUBLIC_KEY` | the backup public key (below). Falls back to `CLOUD_ESCROW_PUBLIC_KEY`, with a warning |
| `CLOUD_BACKUP_HOUR_UTC`, `CLOUD_BACKUP_RETAIN_DAILY`, `CLOUD_BACKUP_RETAIN_WEEKLY`, `CLOUD_BACKUP_CONCURRENCY`, `CLOUD_BACKUP_MAX_ATTEMPTS`, `CLOUD_BACKUP_STALE_HOURS` | defaults 8, 7, 4, 2, 3, 36 |

**The backup key pair (founder, once).** On the offline machine: `pnpm --filter @agentdash/cloud-control escrow keygen --out-dir <dir>`; set the printed public key as `CLOUD_BACKUP_PUBLIC_KEY` and keep the secret key under the section 3 custody rules, in its own password-manager note. A separate pair from the escrow key keeps the two duties apart; using the escrow pair works too. Rotation follows section 3: each backup names its key id, so keep an old secret key until the last backup sealed to it has been pruned (about 5 weeks).

**Operator commands.**

```sh
pnpm --filter @agentdash/cloud-control admin backups status          # fleet: last good backup, age, stale boxes
pnpm --filter @agentdash/cloud-control admin backups list <slug>     # a box's backups
pnpm --filter @agentdash/cloud-control admin backups run <slug>      # back up now (e.g. before risky work)
pnpm --filter @agentdash/cloud-control admin backups download <backup id> <file>   # still encrypted; SHA-256 checked
```

**Alerts.** The service reports `backup_succeeded`, `backup_failed`, `backup_gave_up`, `backup_token_installed` and `backup_pruned` through its `onEvent` hook (logged today), and `staleBackups()` / `admin backups status` list active boxes with no good backup in `CLOUD_BACKUP_STALE_HOURS`. SC-10 wires those to the ops channel.

**Threat model for restores.** The box writes the dump, so a compromised tenant box controls its SQL. The envelope proves only that the control plane sealed what a box sent. It does not make the SQL benign, and it does not prove which box sent it. So:

- **Decrypt and replay are separate steps on separate machines.** `decrypt` runs on the offline key machine and executes nothing. `replay` runs in a **disposable sandbox with no key material** (a throwaway VM or container, deleted afterwards), and it refuses `--key-dir`.
- **Parsed by the real Postgres parser, never by patterns.** Only backup-lib's statement format is accepted, and there is no psql path. Every statement is parsed with libpg_query (the `libpg-query` package, MIT, WebAssembly, so no native build), and must be exactly one statement whose syntax tree matches, node for node and field for field, a shape backup-lib writes. The allowed shapes:
  - `BEGIN`, `COMMIT`, and `SET LOCAL` of two settings;
  - `CREATE SCHEMA IF NOT EXISTS`, enum types, `CREATE EXTENSION IF NOT EXISTS <allowlisted> WITH SCHEMA <name>` (kept because backup-lib records each extension's schema; safe only where the extension script's search_path cannot be bent into the dump-named schema — CVE-2022-2625 and CVE-2023-39417 — so replay refuses a server older than 11.21 / 12.16 / 13.12 / 14.9 / 15.4 or any pre-16 major other than those minors);
  - `DROP TABLE` or `DROP SEQUENCE IF EXISTS`, `CREATE SEQUENCE`, `ALTER SEQUENCE … OWNED BY`;
  - `CREATE TABLE` with columns and NOT NULL, DEFAULT, PRIMARY KEY or UNIQUE (never `AS SELECT`), and `CREATE INDEX`;
  - `ALTER TABLE` with exactly one `ADD CONSTRAINT` (primary key, unique or foreign key);
  - `INSERT … VALUES` with constants only, `SELECT setval(<literals>)`, and `COPY <table> (<columns>) FROM STDIN`.

  Anything else is refused: an unknown field, a function outside a short allowlist (`nextval`, `now`, `gen_random_uuid`, `lower`, …), a qualified function or operator, a subquery, a second statement. Quoting, comments and spacing cannot hide anything from a parser — leading lines are classified with PostgreSQL's own ASCII whitespace set, so a Unicode space cannot make a statement look like a comment or a blank. Nothing is buffered whole: a statement is refused past 16 MiB or 65,536 lines, one physical line past 64 MiB, and a COPY block's TSV payload streams line by line (with line and byte backstops) rather than ever becoming one string, so `decrypt`'s safety scan holds constant memory on the key machine even against a gzip bomb.
- **One statement per protocol message.** Each statement runs over the extended protocol, where the server itself refuses more than one statement.

  `decrypt` runs the check before it keeps the plaintext; `replay` runs it again on the whole file, then again per statement.
- **Replay as a plain role.** It must own the sandbox databases and be a member of no role. The tool refuses superuser, CREATEROLE, CREATEDB, replication and bypass-RLS, membership of `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`, and any membership at all.
- **Verify the schema before any promotion.** The applied migrations are read from the restored `drizzle.__drizzle_migrations`, never from the box-written header, and in row order they must form an **unbroken prefix** of this repository's migration journal — known hashes are not enough; a skipped or reordered migration fails the restore.
  - The tool builds a **reference** database from exactly those migrations, in a second empty sandbox database (`--reference`).
  - It compares the two catalogs: tables, columns, defaults, constraints, indexes, sequences, types, triggers, rules, views, functions, policies, row-level security, extensions (name and home schema), event triggers, casts, operators, languages, foreign servers, publications, owners and ACLs. Any object in the restore that our migrations do not create fails the restore.
  - The comparison is by catalog entry, not by definition, and does not compare: function bodies, policy predicates, a trigger's enabled state, default privileges, collation definitions, sequence options, or large objects (never read). Those stay safe because the replay allowlist makes them unreachable — a dump cannot carry `CREATE FUNCTION`, `POLICY`, `TRIGGER`, `COLLATION`, `GRANT`/`ALTER DEFAULT PRIVILEGES` or large-object SQL at all; functions, views, triggers and CHECKs come only from our migrations during repair, and the one reachable knob — `CREATE SEQUENCE` options — may hold literals only.
  - backup-lib's engine does not carry CHECK constraints, views, functions or triggers. The tool then re-creates those from the **reference** (our migrations, never the dump), and the schema must match exactly.
- **Check the object is the one you asked for.** `admin backups download` refuses a stored object whose header names another backup id. `decrypt` requires `--expect-slug` and `--expect-backup-id`, never overwrites its output, and prints box-written text only with control characters stripped.

**Restore test (monthly, and after any change here).** On the offline **key** machine:

```sh
pnpm --filter @agentdash/cloud-control admin backups list <random active slug>
pnpm --filter @agentdash/cloud-control admin backups download <newest backup id> ./box.adbk
pnpm --filter @agentdash/cloud-control backup-restore inspect --in ./box.adbk
pnpm --filter @agentdash/cloud-control backup-restore decrypt --in ./box.adbk --key-dir <dir> --out ./box.sql.gz --expect-slug <slug> --expect-backup-id <id>
```

`decrypt` writes `box.sql.gz` (mode 600) and `box.sql.gz.manifest.json` (the header: counts and release, no key). If it is interrupted, it removes the partial plaintext. Move those two files, **not the key directory**, to the sandbox, then `rm -P` them and `box.adbk` on the key machine.

In the **sandbox** (a disposable VM or container with a repository checkout and Node, and no keys or other credentials):

```sh
docker run -d --name restore-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=<random> postgres:18
docker exec restore-pg psql -U postgres -c "create role restore login password '<random>' nosuperuser nocreatedb nocreaterole" \
  -c "create database restore owner restore" -c "create database reference owner restore" \
  -c "grant set on parameter session_replication_role to restore"
pnpm --filter @agentdash/cloud-control backup-restore replay --dump ./box.sql.gz \
  --into postgres://restore:<random>@127.0.0.1:55432/restore --reference postgres://restore:<random>@127.0.0.1:55432/reference
docker rm -f restore-pg
```

`replay` refuses a target that holds users or companies, and replays as the plain role. It then checks the schema against our migrations (and re-creates what the dump format does not carry), reports the restored counts beside the box's own, and prints `RESTORE TEST PASSED` or `FAILED`. Destroy the sandbox, and record the date, slug, backup id and timings in the ops log.

**Real restore (box database lost or corrupted).** Never restore over a live box: `replay` refuses any target database that holds users or companies.

1. Provision a throwaway replacement `<slug>-restore` on the same release (the slug rule leaves room for the suffix), and do not claim it.
2. Recover the old box's master key from escrow (section 3) and set it, with the old `BETTER_AUTH_SECRET`, on the replacement.
3. Run `decrypt` on the key machine as above, then move the dump and manifest to a sandbox with no keys. Open a temporary TCP proxy to the replacement's Postgres (as `backup-box.sh` does). There, create a plain `restore` role (as in the sandbox block above) that owns two fresh databases, one to restore into and one for the reference schema, and grant it `SET` on `session_replication_role`. Run `backup-restore replay --dump ./box.sql.gz --into <restore db URL> --reference <reference db URL>`. Only after `RESTORE TEST PASSED`, point the replacement's `DATABASE_URL` at the restored database.
4. Delete the proxy and redeploy the replacement. `curl -s https://<its railway host>/api/health` must answer `"status":"ok"`; then sign in as the customer's admin, and only then point the router and the box row at it.

## 9. Stripe fan-out, the shared box key and per-box Resend keys (SC-8, GH #769)

**Why one endpoint.** Stripe allows 16 webhook endpoints per account, so the account has exactly one: `https://www.agentdash.cloud/api/cloud/stripe/webhook` (www rewrites `/api/cloud/*` to `cloud-control`; the route is mounted before the JSON parser because the signature covers the exact raw bytes). For each event `cloud-control` verifies Stripe's signature with the endpoint's secret (5-minute tolerance), finds the box from `metadata.box_slug` (boxes write `AGENTDASH_BOX_SLUG` there, `server/src/services/billing.ts`; invoices carry it under `parent.subscription_details`; an event without it is routed by the box's bound customer), stores it once per event id in `stripe_events` (the body encrypted), and forwards the unchanged body to `https://<box upstream host>/api/billing/webhook` **re-signed in Stripe's format with that box's own `STRIPE_WEBHOOK_SECRET`**, so the box's unmodified `constructEvent` accepts it. `customer.subscription.*` also keeps `boxes.plan_tier` (a box holds one company with one subscription; an older event never overwrites a newer one, and on the same second the more final status wins).

**Customer binding (security).** Every box holds the shared key, so a compromised box can write any `box_slug` into any Stripe object. The control plane therefore treats the **customer binding** as the authority: the first slug-routed event that names a customer binds it to that box (`boxes.stripe_customer_id`, unique: one customer, one box), a box keeps the customer it was bound to, and neither is ever rebound silently. A conflicting event is held (table below). To rebind on purpose (a company really moved customers), an operator clears `stripe_customer_id` on the box after checking in the Stripe Dashboard, then redelivers the held events. A box that never checked out has no binding yet, so the first customer to name it wins; a later real checkout for that box is then held and alerted, not lost.

**Targets.** A forward goes only to a recorded upstream host under `.up.railway.app`, with no redirects. Dead letters keep their encrypted body for 30 days, then only the metadata.

| Outcome | Answer to Stripe | What happens |
|---|---|---|
| Bad or missing signature, or a body that is not an event | 400 | Nothing stored; Stripe retries (a forged call gets nothing) |
| No endpoint secret configured | 503 | Stripe retries until it is set |
| Same event id again (a Stripe retry, a replay inside the tolerance) | 200 `duplicate` | Never forwarded twice |
| Event of the other mode (`livemode` vs `CLOUD_STRIPE_MODE`) | 200 | Dropped |
| `box_slug` names no known box | 200 | Dropped, ops alert `stripe_unknown_box` |
| `box_slug` disagrees with the customer binding (the customer belongs to another box, or the named box is bound to another customer) | 200 | **Held** in the dead letters with its body, ops alert `stripe_routing_conflict`; never delivered, no tier change. `admin stripe redeliver` sends it to the box the customer is bound to |
| Slug listed in `CLOUD_STRIPE_IGNORE_BOX_SLUGS` | 200 | Dropped quietly (the script-provisioned launch box keeps its own endpoint) |
| No `box_slug` and no known customer | 200 | Dropped, logged |
| Box deleted, `pending_delete` or `cleanup` | 200 | Dropped, body discarded |
| Box `awaiting_claim` or `active` | 200 | Delivered now; on failure retried after 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h and 24 h, then `dead` with alert `stripe_delivery_dead` |
| Box not running yet, `suspended` or `failed`, or missing its webhook secret | 200 | Parked: re-checked every 10 minutes without using an attempt, `dead` after 3 days |

A delivered event's body is discarded; a dead one keeps its encrypted body so it can be redelivered. A background pass every 15 seconds sends due retries.

**Operator commands** (`pnpm --filter @agentdash/cloud-control admin …`):

```sh
admin stripe status                    # mode, endpoint secret, shared key version + fingerprint, boxes behind, event counts
admin stripe events                    # the dead letters (default); also: pending, delivered, dropped, all
admin stripe redeliver evt_123         # a dead or waiting event back on the queue with a fresh attempt budget
admin stripe endpoint ensure           # dry run; --apply creates the endpoint and stores its secret
pbpaste | admin stripe rotate-box-key  # dry run: which boxes would get the key; nothing stored or sent
pbpaste | admin stripe rotate-box-key --apply              # store it, upsert every box (takes effect at each box's next deploy)
admin stripe rotate-box-key --apply --resume               # finish an interrupted run with the stored key (no stdin)
pbpaste | admin stripe rotate-box-key --apply --redeploy   # also restart each box now (a short outage per box)
```

A dropped event keeps no body; after fixing the cause, resend it from the Stripe Dashboard (Developers, Webhooks, the endpoint, the event, Resend).

**What each box gets** (in the provisioner's single variables upsert before the first deploy, and from `rotate-box-key` afterwards): `STRIPE_SECRET_KEY` (the shared restricted key), `STRIPE_WEBHOOK_SECRET` (the box's own, generated by the control plane and kept encrypted in `boxes.stripe_webhook_secret_enc`), `STRIPE_PRO_PRICE_ID`, `STRIPE_TRIAL_DAYS`, plus `RESEND_API_KEY` (the box's own sending-only key) and `AGENTDASH_EMAIL_FROM`. `AGENTDASH_FREE_AGENT_CAP=2` and `AGENTDASH_BOX_SLUG` were already set. Railway applies variables only at a box's next deploy, so a config the control plane sent is recorded as `boxes.stripe_config_pending_rev` and becomes `boxes.stripe_config_rev` (`k<key version>.<price>.<trial days>`, the config the box **runs**) only once a deployment that started after the upsert has succeeded. `stripe status` reports `boxesBehind` (not yet running the target config) and, within it, `boxesPendingDeploy` (sent, waiting for a deploy). The rotation command also refuses to write to a project that is not the box's own (`agentdash-box-<slug>`, never a protected project, in the boxes workspace, carrying the box's control-plane tag). While the fleet config is incomplete a new box is provisioned without Stripe (the `billing_mail_skipped` box event says so), which means its caps are bypassed: finish the setup below before turning provisioning on.

**Purpose and billing (GH #861).** `demo` and `internal` boxes never bill: at provisioning they get `AGENTDASH_BILLING_DISABLED=true` and no Stripe variables at all (Resend still goes in — a demo still sends email), and `rotate-box-key` skips them (`BILLING_SYNC_PURPOSES = customer, canary`; a purpose not listed is never pushed config). `canary` keeps the full config so the first rollout wave exercises the real path. A customer box can be marked demo later — then it just keeps the config it already has until its purpose changes back or it is re-provisioned.

**Resend:** at provisioning the control plane creates a key named `agentdash-box-<slug>` with `sending_access` restricted to the box mail domain, records only its id (`boxes.resend_key_id`), and revokes any older key of that name first. The delete job revokes it after the project delete (spec §6.5). The full-access key used for this never leaves `cloud-control`.

### 9.1 Founder setup, Stripe TEST mode first (F4, GH #759)

All in the Stripe Dashboard with **Test mode** on. IDs are not secrets; keys are. Keys go into Railway variables or the CLI's stdin through the password manager, never into a chat, an issue, a commit or a log.

1. **Product and price:** product "AgentDash Pro", recurring price **$29 per seat per month** (per unit). Copy the price id (`price_…`).
2. **Customer portal:** Settings, Billing, Customer portal: turn it on (allow cancel, payment method updates, quantity changes).
3. **The boxes' shared restricted key** `boxes-shared` (Developers, API keys, Create restricted key): Customers **Write**, Checkout Sessions **Write**, Customer portal **Write**, Subscriptions **Write**, Invoices **Read**, Prices **Read**, Products **Read**; everything else None. Accepted risk until Option B (spec §10, decision 4): a compromised box's key can read other customers' objects of these types, and revocation is fleet-wide.
4. **The control plane's restricted key** `cloud-control`: Webhook Endpoints **Write**; everything else None.
5. Set on `cloud-control` (then redeploy; `cloud-migrate` first, it adds migration `0009_stripe_forwarding`):

| Variable | Value |
|---|---|
| `CLOUD_STRIPE_MODE` | `test` (default). Keys and events of the other mode are refused or dropped |
| `CLOUD_STRIPE_PRO_PRICE_ID` | the `price_…` from step 1 |
| `CLOUD_STRIPE_TRIAL_DAYS` | `14` (default) |
| `CLOUD_STRIPE_CONTROL_KEY` | the `rk_test_…` from step 4 (only needed for `stripe endpoint ensure`) |
| `CLOUD_STRIPE_WEBHOOK_SECRET` | only if the endpoint is made by hand in the Dashboard (step 6, option b): its `whsec_…`; comma-separate two during an endpoint secret roll |
| `CLOUD_STRIPE_IGNORE_BOX_SLUGS` | the launch box's slug, if it shares this Stripe account and keeps its own endpoint |
| `CLOUD_RESEND_ADMIN_API_KEY` | a Resend **full access** key (`re_…`), used only to create and revoke box keys (F2, GH #757) |
| `CLOUD_RESEND_BOX_DOMAIN_ID` | Resend's id of the verified domain `mail.agentdash.cloud` (Resend, Domains); set together with the key above |
| `CLOUD_BOX_EMAIL_FROM` | default `AgentDash <no-reply@mail.agentdash.cloud>` |

6. **The endpoint.** (a) `admin stripe endpoint ensure`, then `admin stripe endpoint ensure --apply`: it creates the endpoint with API version `2026-04-22.dahlia` (the version the boxes pin) and the events `checkout.session.completed`, `customer.subscription.created`, `.updated`, `.deleted`, `.trial_will_end`, `invoice.paid`, `invoice.payment_failed`, and stores its signing secret encrypted (no person sees it). Or (b) by hand in the Dashboard with the same URL, API version and events; then set `CLOUD_STRIPE_WEBHOOK_SECRET`.
7. **The shared key:** copy `boxes-shared` to the clipboard, run `pbpaste | admin stripe rotate-box-key` (dry run), check the list, then `pbpaste | admin stripe rotate-box-key --apply --redeploy`, then clear the clipboard.
8. **Check:** `admin stripe status` shows `targetRev` set, `boxesBehind: 0`, `boxesPendingDeploy: 0`, `incomplete: []`. `stripe trigger customer.subscription.created` (Stripe CLI, test mode) shows a 200 delivery on the endpoint in the Dashboard and appears in `admin stripe events dropped` as `no_box_slug` (it names no box).

**Acceptance on a real box (test mode):** on a box provisioned after step 7, hit the hire wall at the third agent and start the no-card trial: the Dashboard shows the endpoint delivery succeeded, `admin stripe events delivered` lists `customer.subscription.created` for the box, `admin boxes list` shows `plan_tier` `pro_trial`, and `https://<slug>.agentdash.cloud/api/billing/status` (signed in) shows the tier. Invite a teammate: the subscription quantity goes up (a `customer.subscription.updated` delivery), and the invite email arrives from `no-reply@mail.agentdash.cloud` through the box's own key (Resend, Logs, filtered by the key name `agentdash-box-<slug>`).

### 9.2 Rotating the shared box key

Stripe cannot mint restricted keys through its API, so rotation is by hand plus one command:

1. Dashboard, the `boxes-shared` key, **Rotate key**, with the old key expiring later (24 hours is enough when step 2 redeploys; up to 7 days if the boxes should pick it up at their next upgrade instead).
2. `pbpaste | admin stripe rotate-box-key --apply --redeploy`. A box that fails is listed; fix the cause and run `admin stripe rotate-box-key --apply --resume` until `failed` is 0. Without `--redeploy` the new key reaches each box only at its next deploy, so the old key must outlive the slowest box.
3. Wait until `admin stripe status` shows `boxesBehind: 0` **and** `boxesPendingDeploy: 0`: only then does every box run the new key (each box counts once a deployment after the upsert succeeded, so a box whose redeploy failed stays behind). Do not let the old key expire before that; extend its expiry in the Dashboard if needed.

The same command with no key change converges a new price or trial length across the fleet (`--apply --resume`).

### 9.3 Live mode (later, F4 #759)

Repeat 9.1 with Test mode off: live price, live `boxes-shared` and `cloud-control` keys, a live endpoint (its own secret). Set `CLOUD_STRIPE_MODE=live` and the live values on `cloud-control`, redeploy it, then `pbpaste | admin stripe rotate-box-key --apply --redeploy` with the `rk_live_…` key (a test key is refused in live mode). Test-mode customers and subscriptions do not carry over: a box that started a test trial starts again in live mode.
