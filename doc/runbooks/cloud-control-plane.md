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

**Controls (spec §5.1):** per visitor IP 3 signups an hour and 1 box a day; 5 boxes a day per non-freemail domain; one box per verified email (a second signup gets a "you already have a workspace" email, the same 202 answer); the disposable-domain list (`disposable-email-domains-js`) plus `CLOUD_DISPOSABLE_DOMAINS_EXTRA` / `_ALLOW`, and an MX record; find and resend 3 an hour per email; Turnstile on signup and find. **Without Turnstile keys, signups are accepted but every one waits for an operator's approval** (`needs_approval`), even with waitlist mode off.

**Variables on `cloud-control`:**

| Variable | Value |
|---|---|
| `CLOUD_RESEND_API_KEY` | the Resend key (already used for alerts). Without it `/start` and `/find` answer 503 |
| `CLOUD_MAIL_FROM` | default `AgentDash <no-reply@agentdash.cloud>` (agentdash.cloud is a verified Resend domain) |
| `CLOUD_PUBLIC_SITE_URL` | default `https://www.agentdash.cloud` (links in emails) |
| `CLOUD_PUBLIC_CLIENT_IP_HEADER` | `x-vercel-forwarded-for`: through Vercel the connecting address is Vercel's. Verify after deploy (step 5 below) |
| `CLOUD_PROXY_SIGNUPS_PER_HOUR` | default 120: ceiling per connecting address, so a caller that skips Vercel and forges the header is still capped |
| `CLOUD_TURNSTILE_SITE_KEY`, `CLOUD_TURNSTILE_SECRET_KEY` | together or not at all (founder action #759) |

**Deploy checklist**

1. `cloud-migrate` first (migration `0006_front_door`: `signup_requests`, `cloud_sessions`, `rate_events`), then `cloud-control`.
2. Set the variables above on `cloud-control` (not the Turnstile pair until #759 is done). Keep `waitlist_mode=true`, `daily_cap=10`.
3. `curl -s https://cloud-control-production.up.railway.app/api/cloud/config` answers `{"turnstileSiteKey":null,"signupOpen":true,"waitlist":true,…}`.
4. Deploy www (Vercel) with the `/api/cloud/:path*` rewrite; `curl -s https://www.agentdash.cloud/api/cloud/config` gives the same answer.
5. Sign up at `https://www.agentdash.cloud/start` from a private window: the verify email arrives from no-reply@agentdash.cloud, the link lands on "You're on the list", and `admin waitlist list` shows the entry. Check the `signup_requests.ip` of that row is your address, not a Vercel one; if it is Vercel's, the header name is wrong.
6. `admin waitlist approve <id>`: the approval email arrives and the page says "You're in"; `admin jobs list` shows no provision job (gated).
