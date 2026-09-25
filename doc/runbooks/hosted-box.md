# Hosted box runbook

How an operator provisions, hands over, backs up, updates and retires one hosted AgentDash box on Railway. Issue #675; decisions D-S1 (one box per customer), D-S4 (one Railway service per box), D-S6 (retire the old instance) from the SaaS discovery (#623), and D1, D2, D6 from the 1.0 plan (`doc/plans/2026-09-24-mvl-1.0.md`, PR #706).

Scripts live in `scripts/hosted/`:

| Script | Who runs it | What it does |
|---|---|---|
| `provision-box.sh` | operator | Creates or re-converges `agentdash-box-<slug>`: project, Postgres, `web` service, Volume, domain, variables, deploy, health wait |
| `claim-box.sh` | the customer's founder | Creates the founder's account with the one-time invite code |
| `backup-box.sh` | operator | Postgres dump, Volume tarball, Railway snapshots; `--restore-test` proves the dump restores |
| `lib.sh` | (sourced) | Railway GraphQL helpers; refuses to touch any project not named `agentdash-box-*` |

## 1. What a box is

One customer, one Railway **project** named `agentdash-box-<slug>`, in its own private network, so a server-side request forgery on one box (#709) cannot reach another box. The project holds:

- **`Postgres`**: Railway's Postgres template. It generates its own password and keeps its data on its own volume.
- **`web`**: the AgentDash image, one replica, health check `/api/health`, restart on failure.
- **A Volume at `/paperclip`** on `web`: the Paperclip home (instance config, local storage, logs, workspaces). When #721 lands, the Hermes home, profiles, ledgers and wrappers live here too.
- **A Railway domain** `web-production-<hash>.up.railway.app`, and optionally `<slug>.agentdash.cloud` (section 8).

Secrets are generated once by the script and exist only as Railway variables: `BETTER_AUTH_SECRET`, `PAPERCLIP_SECRETS_MASTER_KEY` and `AGENTDASH_INVITE_CODES`. The script never prints them. The founder invite code is also written to `~/.agentdash-boxes/<slug>/founder-invite-code.txt` (mode 600) so the operator can hand it over out of band.

**Cost.** Measured idle on the launch box: `web` about 0.46 GB of memory, Postgres about 0.13 GB, CPU near zero. At Railway's usage prices (about $10 per GB of memory per month, $20 per vCPU per month, $0.15 per GB of volume per month) an idle box costs about **$6 to $7 a month**, and an estimated $10 to $20 a month with agents running. On a Hobby workspace the $5 plan fee includes $5 of usage; a Pro workspace is $20 a month per seat plus usage.

The customer's founder is the box's first instance admin. Our support uses a separate, named account added only with the customer's consent (D-S7). **Never make us the sole instance admin of a customer box.**

## 2. Before you start

- `railway` CLI logged in to the workspace that will own the box (`railway whoami`). Customer boxes belong in a Railway **Pro** workspace (volume snapshots, larger volumes, team access); the launch box runs on the founder's Hobby workspace.
- `jq`, `curl`, `openssl`, `git`, and Docker (for backups).
- **Security bar (1.0 plan F1):** no customer box before #692 and #713 to #718 are merged. The launch box is ours and exempt.
- A release tag, e.g. `v2026.924.0`, and an image for it (section 3).

## 3. Images

`.github/workflows/docker.yml` pushes `ghcr.io/thetangstr/agentdash` (public) on every push to `main` with tags `latest` and `sha-<7>`, and would push `<version>` and `<major>.<minor>` for a `v*` tag push (for `v2026.924.0` that is `2026.924.0` and `2026.924`, **without** the `v`).

**Known gap:** release tags are pushed by `release.yml` with the workflow's own `GITHUB_TOKEN`, and GitHub does not start other workflows from such pushes, so no release tag has ever produced an image (only `latest`, `agentdash-main` and `sha-*` exist). The `main` build for a release commit is also often cancelled by the next merge (`cancel-in-progress`). Until release.yml builds the image itself:

- `provision-box.sh` checks GHCR for the tag before deploying and stops if it is missing.
- `--from-source` uploads `git archive <tag>` and has Railway build the Dockerfile. This is how the launch box runs `v2026.924.0`. It is slower (about 10 to 15 minutes per build) but pins the exact tagged tree.
- `--image ghcr.io/thetangstr/agentdash:sha-<7>` pins a `main` build by commit when one exists.

## 4. Provision a box (target: 30 operator-minutes)

```sh
scripts/hosted/provision-box.sh --slug <slug> --release v2026.924.0 --from-source
# or, once GHCR has the tag:
scripts/hosted/provision-box.sh --slug <slug> --release v2026.924.0
```

The script is idempotent; re-run it after any failure. In order it:

1. Creates project `agentdash-box-<slug>` with a `production` environment (or finds it).
2. Adds Postgres (`railway add --database postgres`) and waits for it.
3. Creates the `web` service, a Volume at `/paperclip`, and a Railway domain on port 3100.
4. Upserts the variables in section 12 without deploying, generating the three secrets only if they are absent.
5. Sets the health check (`/api/health`, 300 s), restart policy, image source, and a start command that gives the Volume to the `node` user before the image's entrypoint drops privileges. Railway mounts volumes root-owned, and without this the first boot dies with `EACCES: mkdir '/paperclip/instances/default/logs'` (seen on the launch box). The proper fix belongs in `scripts/docker-entrypoint.sh` with #721.
6. Deploys (image or source upload), waits for the **new** deployment to succeed, then for `/api/health` to answer `status: ok`, and refuses to finish unless `deploymentMode` is `authenticated`.
7. Prints the claim instructions.

Local state (the CLI link and the invite code file) lives in `~/.agentdash-boxes/<slug>/` (mode 700), never in a repo checkout.

**Timing, launch box (2026-09-25):** about 10 seconds of script for the project, Postgres, service, Volume, domain and variables, then about 14 minutes for Railway to build `v2026.924.0` from source and start it. A restart with `--redeploy` takes about a minute. From a GHCR image, the whole box (project to healthy) took **67 seconds** on a throwaway box the same day. Hands-on operator time is under 5 minutes plus the wait; the full "box N+1 in 30 operator-minutes" drill (I1) is still to be timed by someone other than the author.

## 5. Verify

```sh
BOX=https://<host>
curl -s $BOX/api/health | jq '{status,deploymentMode,bootstrapStatus,selfServeBootstrap,instanceHasCompany}'
# expect status ok, deploymentMode authenticated, bootstrapStatus bootstrap_pending, instanceHasCompany false
curl -s -o /dev/null -w '%{http_code}\n' $BOX/api/companies           # expect 401 or 403
curl -s -X POST $BOX/api/auth/sign-up/email -H 'Content-Type: application/json' \
  -H "Origin: $BOX" -d '{"name":"x","email":"stranger@example.com","password":"x-long-password-1"}'
# expect 403 invite_code_required
curl -s -X POST $BOX/api/onboarding/mcp-signup -H 'Content-Type: application/json' \
  -d '{"name":"x","email":"stranger@example.com"}'
# expect 403 invite_code_required
curl -s -o /dev/null -w '%{http_code}\n' $BOX/.well-known/oauth-protected-resource
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BOX/api/mcp
```

Also run the cloud preflight against the box's variables from its state directory: `cd ~/.agentdash-boxes/<slug> && railway run --service web node <repo>/scripts/cloud-preflight.mjs`. Until a model adapter and Stripe are configured it reports the adapter error and the Stripe warning; everything else must pass.

## 6. The founder claims the box

**How the gate works.** Sign-up on a box is closed by default and fails closed:

- `AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true` makes `POST /api/auth/sign-up/*` refuse any request without a code in `AGENTDASH_INVITE_CODES` (`server/src/middleware/invite-code-signup-guard.ts`). With no codes configured, every code is refused.
- MCP sign-up (`POST /api/onboarding/mcp-signup`, `doc/MCP-LAUNCH.md`) validates its code against `AGENTDASH_INVITE_VALIDATION_URL`, which the script points at **the box's own** `/api/invites/validate`, so the box never trusts www.agentdash.cloud's code list and an unreachable validator refuses sign-up.
- No social sign-in provider is configured, and `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP` is off, so nothing else creates users.
- `AGENTDASH_SELF_SERVE_BOOTSTRAP=true` makes the creator of the **first** company on a box with no instance admin its instance admin (`server/src/routes/companies.ts`).

**Steps, done by the founder:**

1. Receive the invite code out of band (the operator reads `~/.agentdash-boxes/<slug>/founder-invite-code.txt`; never paste it into chat, a ticket or a commit).
2. Run `scripts/hosted/claim-box.sh https://<host> --code-file <file with the code>`. It asks for name, email and a password (hidden), and creates the account. The browser sign-up form cannot send a code yet (section 11), so this is a script.
3. Open `https://<host>/auth`, sign in, and create the company. The founder is now instance admin and company owner; `/api/health` shows `bootstrapStatus: ready`.

## 7. After the claim

1. **Rotate the code.** The code is not single-use: until it is rotated, anyone holding it can create another account on the box (tested). Rotate it so the one the founder used stops working, and restart the box to load it:
   ```sh
   scripts/hosted/provision-box.sh --slug <slug> --release <tag> --rotate-invite --redeploy
   ```
   The new code is written to the same file. Teammates join by company invite (section 11 for the current gap).
2. Record the box in the operator's box list: slug, URL, release, founder email, date claimed.
3. Escrow the secrets master key (section 9).

## 8. Custom domain `<slug>.agentdash.cloud`

DNS for agentdash.cloud is at GoDaddy, with no API access, so this is manual.

1. `scripts/hosted/provision-box.sh --slug <slug> --release <tag> --custom-domain <slug>.agentdash.cloud --redeploy`. The script attaches the domain in Railway, prints the DNS records Railway requires, and switches `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BILLING_PUBLIC_BASE_URL`, the invite validation URL and the allowed hostnames to the custom name (the Railway name stays allowed).
2. In GoDaddy (Domain, DNS, Manage DNS for `agentdash.cloud`), add exactly what the script printed. Typically:
   - `CNAME` host `<slug>`, value `<something>.up.railway.app`, TTL 1 hour
   - `TXT` host `_railway-verify.<slug>`, value `railway-verify=<token>` (domain ownership verification)
3. Wait for Railway to show the domain as verified with a certificate (minutes to an hour), then `curl -s https://<slug>.agentdash.cloud/api/health | jq .publicBaseUrl`.
4. Register any OAuth callbacks against the custom name only after it serves.

## 9. Backups and restore

**What must survive:** the Postgres database, the `/paperclip` Volume (and the Hermes directory once #721 lands), and the secrets master key. Without the master key, every encrypted company secret in the database is unreadable.

- **Automatic:** in a Pro workspace, enable daily and weekly snapshots on both volumes (Railway, service, Volume, Backups; or the `volumeInstanceBackupScheduleUpdate` mutation).
- **Logical, operator-run:** `scripts/hosted/backup-box.sh --slug <slug>` writes `db.dump` (pg_dump custom format), `volume.tgz` (the Volume over `railway ssh`), live row and schema counts and a manifest to `~/.agentdash-boxes/<slug>/backups/<UTC stamp>/` (mode 700), and requests Railway snapshots where the plan allows. A box's Postgres has **no public endpoint**; the script opens a Railway TCP proxy for the length of the dump and deletes it on exit.
- **Also on the Volume:** the server's own hourly database backup (`/paperclip/instances/default/data/backups`, kept 7 days). It is on the same Volume as everything else, so it is not a substitute for an off-box copy.
- **Plan limits found on the launch box:** a Hobby workspace refuses volume snapshots (`Not Authorized`), and `railway ssh` in CLI 4.5.1 fails ("application is not running or in an unexpected state"); CLI 5.x needs an SSH key registered to the Railway account (`railway ssh keys add`). Until one of those is in place, the Volume has no off-box backup. Before #721 puts Hermes state there, the Volume holds only regenerable files (instance config, logs, the local backup copies); after #721 it must be backed up.
- **The master key** is the Railway variable `PAPERCLIP_SECRETS_MASTER_KEY`. Copy it once, at provisioning, into the operator password manager entry for the box. It is deliberately not in the backup directory.

**Restore test (run after every change to this runbook, and weekly):**

```sh
scripts/hosted/backup-box.sh --slug <slug> --restore-test
```

It restores `db.dump` into a throwaway local Postgres container of the same major version, never over live data, compares row counts for the core tables against the live database, checks `volume.tgz` extracts, prints the time taken, and removes the container.

**Real restore (box lost or corrupted):**

1. Provision a replacement: `provision-box.sh --slug <slug>-restore --release <same tag> --no-deploy`.
2. Set its `PAPERCLIP_SECRETS_MASTER_KEY` and `BETTER_AUTH_SECRET` to the escrowed values of the old box (so secrets decrypt and sessions survive).
3. Restore the dump into its Postgres through a temporary TCP proxy (as `backup-box.sh` opens one): `pg_restore --clean --if-exists --no-owner --no-privileges db.dump` from a `postgres:<major>` container with the `PG*` variables in an env file, then delete the proxy.
4. Restore the Volume: deploy once, then `railway ssh --service web` and extract `volume.tgz` into `/paperclip` (or restore a Railway snapshot onto the volume).
5. Deploy, verify (section 5), then move the domain.

## 10. Update a box to a new release

```sh
scripts/hosted/provision-box.sh --slug <slug> --release <new tag> [--from-source]
```

Migrations apply on boot (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`). Take a backup first. **Rollback:** Railway keeps earlier deployments; redeploy the previous one from the dashboard (service, Deployments). A rollback across a migration needs the pre-update `db.dump`.

Boxes do not auto-deploy. `.github/workflows/deploy.yml` targets only the old `agentdash` project's `web` service; never add a box to it.

## 11. Suspend, delete, and known gaps

- **Suspend an idle Free box:** remove the `web` deployment (`cd ~/.agentdash-boxes/<slug> && railway down`) or enable serverless sleep on `web`. Data stays in Postgres and the Volume. Resume with `provision-box.sh --redeploy`.
- **Delete a box:** take a final backup and restore-test it, keep it for 30 days, then delete the project in the Railway dashboard (Settings, Danger). The scripts deliberately have no delete command.

**Known gaps (tracked on #675):**

- **Browser sign-up cannot send an invite code.** `Auth.tsx` and `InviteLanding.tsx` post only name, email and password, so with the gate on, a teammate following a company invite is refused. The guard should also accept a valid company invite token. Until then teammates need the operator's rotated code and `claim-box.sh`.
- **`AGENTDASH_FREE_AGENT_CAP=2` has no effect without Stripe:** with `STRIPE_SECRET_KEY` unset, tier caps are bypassed (`services/tier-policy.ts`). Per-box Stripe wiring is CUJ-7.
- **The hosted flag** `AGENTDASH_DEPLOYMENT_KIND=hosted` is the name proposed in #726, which is not merged. Today `deploymentKind()` treats any value other than `on_prem` as `cloud`, so the variable is inert until #726 lands.
- **No Hermes in the image** until #721; `AGENTDASH_HERMES_MANAGED_PROFILES=true` is set in advance.
- **No model adapter** is configured; CoS chat returns stub replies until the founder brings a key (CUJ-2).
- **No email:** without `RESEND_API_KEY`, password-reset and invite emails are not sent.

## 12. Variables the script sets

| Variable | Value | Why |
|---|---|---|
| `PAPERCLIP_DEPLOYMENT_MODE` | `authenticated` | Real sign-in; never `local_trusted` on a public box (#450) |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `public` | Internet-facing |
| `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BILLING_PUBLIC_BASE_URL` | `https://<host>` | Auth callbacks, links, the OAuth issuer |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | the Railway host (plus the custom host) | Host header allow-list |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | `true` | Headless migrations on boot |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Private-network reference to the box's own Postgres |
| `PORT` | `3100` | Matches the domain's target port |
| `AGENTDASH_SELF_SERVE_BOOTSTRAP` | `true` | First company creator becomes instance admin |
| `AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE` | `true` | Browser sign-up needs a code |
| `AGENTDASH_INVITE_CODES` | generated secret | The founder's one-time code; rotated after the claim |
| `AGENTDASH_INVITE_VALIDATION_URL` | `https://<host>/api/invites/validate` | MCP sign-up validates against the box itself |
| `AGENTDASH_FREE_AGENT_CAP` | `2` | 1.0 plan: the CoS does not use up the only Free agent |
| `AGENTDASH_DEPLOYMENT_KIND` | `hosted` | Hosted-box boot guard flag (#726, pending) |
| `AGENTDASH_HERMES_MANAGED_PROFILES` | `true` | Per-agent Hermes profiles (#721, pending) |
| `AGENTDASH_RELEASE_TAG`, `AGENTDASH_BOX_SLUG` | tag, slug | Operator bookkeeping |
| `BETTER_AUTH_SECRET` | generated, 32 bytes hex | Session signing |
| `PAPERCLIP_SECRETS_MASTER_KEY` | generated, 32 bytes base64 | Encrypts company secrets; escrow it |

Not set on purpose: `AGENTDASH_MK_INVITE_CODES` (no MK profile on hosted boxes, D2), social sign-in credentials, `AGENTDASH_LEGACY_AUTH_AUTOBOOTSTRAP`, `AGENTDASH_INVITE_VALIDATION=off`.

## 13. Launch box record

| Item | Value |
|---|---|
| Project | `agentdash-box-launch` (Hobby workspace of the founder) |
| URL | https://web-production-a74cc.up.railway.app |
| Release | `v2026.924.0` (`5abcf7c22`), built from source because GHCR has no image for the tag |
| Provisioned | 2026-09-25 |
| Claim | Invite-code gate; founder claims with `claim-box.sh` (section 6) |

Verification on 2026-09-25, before the claim:

| Check | Result |
|---|---|
| `GET /api/health` over HTTPS | 200, `deploymentMode: authenticated`, `publicBaseUrl` the Railway URL, `bootstrapStatus: bootstrap_pending`, `selfServeBootstrap: true` |
| HTTP | 301 to HTTPS |
| `GET /api/companies` unauthenticated | 403 `Board access required` |
| `GET /api/agents/me` unauthenticated | 401 |
| Browser sign-up, no code or a wrong code | 403 `invite_code_required` |
| MCP sign-up, no code | 403 `invite_code_required`; wrong code 403 `invalid_invite_code` (validated by the box itself) |
| `POST /api/invites/validate` wrong code | 200 `{"valid":false}` |
| Social providers | none |
| `POST /api/mcp` without a key | 401 "Connect with an agent key"; `GET /api/mcp` 405 (the agent-key MCP endpoint in this build) |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | 200 `text/html`, the SPA fallback: no OAuth metadata in this build (the assistant OAuth server is PR #688, unmerged) |
| Cloud preflight | 1 error (no model adapter key, expected until CUJ-2), 1 warning (no Stripe) |
| Restart (`--redeploy`) | healthy again in about a minute |

Claim path, tested end to end on a throwaway box (`agentdash-box-claimtest`, image `sha-e270a4c`, deleted afterwards): `claim-box.sh` with the code created the account; sign-in and `POST /api/companies` made the claimant instance admin (`bootstrapStatus: ready`); `mcp-signup` then answered 409 `instance_already_claimed`; the same code still created a second account until `--rotate-invite --redeploy`, after which it was refused with 403. The backup restore test on that box, with real rows, passed in 2 s (1 company, 2 users, 1 membership, 1 instance admin).

Backup and restore test on 2026-09-25: `db.dump` 704 KB in 3 s; restored into a scratch `postgres:18` container in 4 s; counts matched the live box (0 companies and users before the claim, 129 migrations, 178 tables, 2243 columns). The same restore path was also run on the old instance's export (6 companies, 18 agents, 1 invite, restored in 2 s). Volume snapshot and Volume tarball were not possible (section 9). Re-run the drill after the claim, when there is real data.
