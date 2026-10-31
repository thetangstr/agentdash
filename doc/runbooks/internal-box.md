# Runbook: an internal box, set up by an agent

How an agent sets up an internal AgentDash cloud box and moves a company into it, with `scripts/hosted/internal-box.mjs`. An internal box is an ordinary hosted box with `purpose internal` (cloud-control-plane.md §7): it never bills, rollouts upgrade it like a customer box, and it runs Hermes only (`doc/plans/2026-09-24-mvl-1.0.md`, D6). The tool drives the same operator surface, Railway CLI and box APIs a person would, so everything it does is visible in `admin boxes list`, the box's events and Railway.

| Command | What it does | Mutates |
|---|---|---|
| `preflight` | Checks the control URL, the admin token, the operator surface, `railway whoami`, and optionally a release image, a provider key and a source key | nothing |
| `create <slug>` | `POST /internal/boxes` with purpose `internal`, then waits until the box is `awaiting_claim` | the control plane (one box) |
| `claim <slug>` | Stores a generated founder password in the Keychain, creates the founder account with the box's claim code, waits for the control plane to close sign-up, redeploys | the Keychain, the box, a redeploy |
| `move-company` | Exports a company from a source instance, imports it into the box, every agent on `hermes_local`, counts verified. **A dry run unless `--apply`** | the box (with `--apply`) |
| `configure <slug>` | Sets the box's Hermes provider key from the Keychain | the box's company secret and Hermes profiles |
| `status <slug>` | Purpose, state, release, health paths, alerts, backups, and what this tool recorded | nothing |

Every mutating command takes `--dry-run`. Every command takes `--json` (one JSON document on stdout; progress lines on stderr). Run it from a repository checkout with dependencies installed (`pnpm install`): it loads the operator CLI's own request code (`cloud/src/admin/run.ts`) and the control plane's release checks through tsx, so it cannot drift from `pnpm --filter @agentdash/cloud-control admin`.

## 1. One-time setup (the founder, on the Mac the agent runs on)

1. **Repository checkout and tools.** A clone of this repository with `pnpm install` done, Node 20 or later, and the Railway CLI (`brew install railway`).
2. **Railway login.** `railway login` as an account that is a member of the **AgentDash Boxes** workspace (where the control plane creates boxes). `railway whoami` must answer. The tool never sees the Railway token; the CLI holds it.
3. **The control plane URL** in the agent's environment (not a secret): `export CLOUD_CONTROL_URL=https://cloud-control-production.up.railway.app`.
4. **This Mac's address on the allow-list.** Find the public address (`curl -s https://checkip.amazonaws.com`) and add it to `CLOUD_ADMIN_ALLOWED_IPS` on the `cloud-control` service (Railway project `agentdash-cloud`), then redeploy `cloud-control`. A home or office address that changes needs updating; `preflight` says so when it does.
5. **Keychain items** (login Keychain, generic passwords; `-w` last makes `security` prompt, so the value never lands in shell history or argv):

   | Item (service name) | Holds | Command |
   |---|---|---|
   | `agentdash-cloud-admin-token` | `cloud-control`'s `CLOUD_ADMIN_TOKEN` | `security add-generic-password -s agentdash-cloud-admin-token -a "$USER" -w` |
   | `agentdash-source-token` | a **board key** (`pcp_board_…`) for the instance companies move from | see below |
   | `agentdash-provider-<name>` | the Hermes provider API key, `<name>` one of `zai`, `openrouter`, `anthropic`, `openai` | `security add-generic-password -s agentdash-provider-zai -a "$USER" -w` |

   The board key: `pnpm paperclipai auth login --api-base https://<source instance>` and approve in the browser (docs/api/api-keys.md). The CLI keeps the key in `~/.paperclip/auth.json`; copy it into the Keychain without it reaching any command line (`printf` is a shell builtin, and `security -i` reads its command from stdin):

   ```sh
   SRC=https://<source instance>
   printf 'add-generic-password -U -a %s -s agentdash-source-token -w %s\n' "$USER" \
     "$(jq -r --arg b "$SRC" '.credentials[$b].token' ~/.paperclip/auth.json)" | security -i
   ```

   `CLOUD_ADMIN_TOKEN` and `AGENTDASH_SOURCE_TOKEN` in the environment take precedence over the first two items (for a session that already has them). A board key expires after 30 days; replace the item with `-U`. A `local_trusted` source on this machine (`http://localhost:3100`) needs no key. For a second source instance, store its key under another name and pass `--source-token-item <name>`.

   The tool writes one item itself: `agentdash-box-<slug>-founder`, the box founder's password, created by `claim`.
6. **Gates.** `provisioning_enabled` must be true for `create` to start a job (the kill switch and the daily cap apply to operator-created boxes too); `preflight` warns when it is off. Turning it on is a founder decision (`admin settings set provisioning_enabled true`).

## 2. The command sequence (the agent)

`I="node scripts/hosted/internal-box.mjs"`. Choose a slug of 3 to 16 characters (`a-z`, `0-9`, `-`), the founder email the claim binds to, a release tag at or after `v2026.929.0` with a GHCR image, and the provider.

```sh
I="node scripts/hosted/internal-box.mjs"
$I preflight --release v2026.1030.0 --provider zai --from https://<source instance>
$I create <slug> --email <founder email> --release v2026.1030.0
$I claim <slug> --name "<founder name>" --email <founder email>
$I move-company --from https://<source instance> --to <slug> --company "<company name or id>"
$I move-company --from https://<source instance> --to <slug> --company "<company name or id>" --apply
$I configure <slug> --provider zai
$I status <slug>
```

Expected output, in order:

1. **preflight** prints one line per check, `[ok]`, `[warn]`, `[FAIL]` or `[skip]`, with a `fix:` line under each failure, and ends `preflight passed`. Exit 1 on any failure. Fix and re-run until it passes; do not continue past a failure.
2. **create** prints `==> [waiting] provisioning: box provisioning, job running at <step>` as the provision job moves (reserve, project, postgres, web, variables, snapshots, service_settings, deploy, health, publish), then `==> [ok] healthy: <slug> is awaiting_claim at https://<slug>.agentdash.cloud`. From a GHCR image this takes a few minutes; the wait is capped at 30 minutes (`--timeout <min>`).
3. **claim** prints `password: stored in the Keychain item agentdash-box-<slug>-founder (read back and verified)`, `founder: account <email> created and signed in`, then waits (`close-signup: box active (claim recorded), close_signup queued`) for the control plane: its claim sweep runs every 10 minutes and then runs the `close_signup` job. It checks the box's variables changed (`PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, invite code rotated), runs `railway redeploy`, waits for `/api/health` to report `signUpDisabled: true`, and checks that a sign-up without a code is refused. The wait is capped at 15 minutes.
4. **move-company** (dry run) prints the source company, the export counts, the Hermes plan (which agents switch adapter), the goal gap warning, and `dry run: nothing was written to the box`. Read the plan before applying.
5. **move-company --apply** creates the box's company (its creator, the founder, becomes instance admin), imports the bundle, enforces Hermes, and prints one `verify` line per entity: `[ok] verify agents: source 4, bundle 4, box 4`, and `[gap] verify goals: …` when the source has goals (section 7).
6. **configure** prints `provider: <label>, model <model>, <n> profiles updated`.
7. **status** prints the box (purpose, state, release, held upgrades), its address, claim, health per path, firing alerts, off-box backups (count, latest good, last attempt), recorded moves and the provider.

## 3. What each step does, and what it reuses

- **Credentials.** The admin token comes from `CLOUD_ADMIN_TOKEN` or the Keychain, never argv; flags that look like secrets (`--password`, `--token`, `--key`, `--code`, …) are refused. Keychain reads use `security find-generic-password -w`; the one write uses `security -i` with the command on stdin, so the password is on no process's command line, then reads it back before it counts.
- **Control plane.** Every call is the operator CLI's `runAdmin` in-process: `settings get` (preflight), `boxes list`, `boxes create … --purpose internal`, `boxes retry`, `jobs list`, `box health`, `backups list`. A 403 is the IP allow-list (the control plane answers `{"error":"forbidden"}` and does not say which address it saw), a 401 the token, a 429 the lockout after repeated failures.
- **Release image.** The control plane's own `resolveImageDigest` (`cloud/src/railway/image.ts`) and release floor (`MIN_BOX_RELEASE`, `cloud/src/jobs/claim.ts`).
- **Claim code.** The box's `AGENTDASH_INVITE_CODES`, read with `railway variables --service web --environment production --json` from the box's state directory (`~/.agentdash-boxes/<slug>`, linked as `provision-box.sh` links it). It is the same value the control plane emails in the claim link. The claim is bound to `AGENTDASH_CLAIM_EMAIL` (the `create` email) and dies the moment the first account exists (`server/src/lib/claim-code.ts`), so `claim` refuses another email before touching the Keychain or the box.
- **Closing sign-up.** hosted-box.md §7 closes sign-up with `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`, a rotated invite code and a redeploy. On a control-plane box the `close_signup` job sets those variables (cloud-control-plane.md §1, `cloud/src/jobs/close-signup.ts`); `claim` waits for it rather than writing them itself, then redeploys so the closed door is live. Running `provision-box.sh --close-signup` on a control-plane box would rewrite its public URL to the Railway host: never do it.
- **Box address.** The slug host (`https://<slug>.agentdash.cloud`) when it answers; otherwise, while the edge router does not enforce its secret, the box's Railway host from `PAPERCLIP_ALLOWED_HOSTNAMES`. `--box-url` overrides both.
- **Moving a company.** `POST /api/companies/:id/export` on the source with the board key (all of company, agents, projects, issues, skills), then on the box, signed in as the founder: `POST /api/companies` when the box has no company, `POST /api/companies/import/preview` (dry run, once a company exists), and `POST /api/companies/import` into that company with `adapterOverrides` putting every agent on `hermes_local` with an empty adapter config, so it runs the managed Hermes profile with the box's provider and model. Afterwards it re-reads what landed: an agent on another adapter is switched, any `command`, `args`, `env` or `cwd` key is stripped, and an issue's `assigneeAdapterOverrides.adapterConfig` (another adapter's settings) is cleared, keeping its model profile. Verification compares live counts on the source, the bundle and the box. Internal boxes have billing disabled, so the Free tier cap does not refuse the import.
- **Provider key.** `POST /api/onboarding/setup-adapter` with `preset: hermes` (the route the box's first-run uses, `server/src/routes/hermes-provider-setup.ts`): the box tests the key with one small model call, stores it as the company's encrypted secret and writes it into the Hermes template and every agent profile on the Volume. It survives redeploys and needs none. The key is **not** a Railway variable on a hosted box: Hermes reads it from its profiles, and the agent wrappers do not forward the process environment.
- **Local state.** `~/.agentdash-boxes/<slug>/internal-box.json` (mode 600, directory 700; `AGENTDASH_BOX_STATE_DIR` moves it) records the box address, the founder email, the claim, each move's target company and steps, and the provider. It holds no secret.

## 4. Resuming a failed step

Every command is safe to re-run with the same arguments; it reads where things stand first.

| Failed in | Re-run | What happens |
|---|---|---|
| `preflight` | after each fix | nothing is changed by preflight |
| `create`, still provisioning or timed out | `create` again | reports the existing box and keeps waiting; never a second box |
| `create`, box `failed` | `create` again | calls `admin boxes retry <slug>`, which resumes the job at its failed step |
| `create`, job `dead` | not resumable | a safety rule refused it; fix the cause, then abandon (section 6) |
| `create`, waitlisted | after the gate opens | the box starts when the kill switch or cap allows |
| `claim`, before the account | `claim` again | reuses the Keychain password if one was stored, then creates the account |
| `claim`, waiting for close-signup | `claim` again | signs in with the stored password, picks up the wait, redeploys |
| `claim`, "already claimed, not by this tool" | do not re-run | someone else holds the founder account; find out who before anything else |
| `move-company --apply`, before the import | `--apply` again | reuses the company it created |
| `move-company --apply`, after the import | `--apply` again | the import is recorded (or, if the run died before recording it, adopted when the box already matches the bundle); never imported twice. It re-enforces Hermes and re-verifies |
| `move-company`, "data this tool did not record importing" | not resumable | the box's company holds something else; use a fresh box |
| `configure` | `configure` again | skipped when the same provider is set; `--rotate` sets the key again |

`--json` output has `ok`, `steps` (each `{step, status, detail}`), `warnings`, `result` and `error` (`{message, fix}`). Exit codes: 0 done, 1 a check or step failed (the `fix` says what to do), 64 a usage error.

## 5. Watching it from elsewhere

`$I status <slug>`, `pnpm --filter @agentdash/cloud-control admin box health <slug>`, `admin jobs list`, and the Railway project `agentdash-box-<slug>` (service `web`). The box's own `/api/health` reports `claimed`, `signUpDisabled`, `adapterReady` and `releaseTag` without signing in.

## 6. Rollback and abandon

- **Before the claim** (box `failed` or `awaiting_claim`): `pnpm --filter @agentdash/cloud-control admin boxes abandon <slug>`. The guarded delete removes the Railway project (`cloud/src/jobs/ops.ts`).
- **After the claim**, `abandon` refuses: "a claimed box is deleted only through the customer deletion flow". For an internal box the founder takes a final off-box backup (`admin backups run <slug>`), then deletes the project as hosted-box.md §11 describes. The tool has no delete command, on purpose.
- **A bad move.** The source company is only read (an export), so it is untouched. A hosted box holds one company, so the clean undo is a fresh internal box: abandon or delete this one and repeat the sequence with a new slug.
- **A bad provider key.** `configure <slug> --provider <name> --rotate` after updating the Keychain item; the box tests a key before storing it, so a rejected key changes nothing.
- **Afterwards, locally:** `security delete-generic-password -s agentdash-box-<slug>-founder` and `rm -r ~/.agentdash-boxes/<slug>`, only once the box is gone.

## 7. Known gaps

- **Goals do not move.** The portability bundle carries the company, agents, projects, issues (recurring ones become routines) and skills, not goals. The dry run warns, and verification reports `[gap] verify goals`. Recreate goals on the box, or extend the portability export.
- **Per-agent adapter settings are dropped.** Every imported agent starts on the box's Hermes defaults (the provider's model, the managed profile). Re-tune models on the box if needed.
- **The 403 does not name the address.** The control plane's IP guard answers `{"error":"forbidden"}` only, so `preflight` can only say how to find this machine's address.
- **Claim waits on the sweep.** The control plane notices a claim within 10 minutes; `claim --no-wait` returns after the account exists, and a later `claim` finishes.
- **macOS only.** Secrets live in the login Keychain through `security`.

## 8. What it never does

- Touch a box whose purpose is not `internal`, or a Railway project not named `agentdash-box-<slug>` (and never the protected projects `scripts/hosted/lib.sh` lists).
- Take a secret on the command line, pass one on a child's command line, print one, or write one to its state file. Every printed line is scrubbed of every secret the run has seen.
- Create a second box for a slug, claim a box someone else claimed, import over a company it did not create or record, or import twice.
- Change control-plane settings (kill switch, waitlist, daily cap), approve waitlist entries, delete a box, or write Railway variables.
- Write anything during a dry run (`move-company` without `--apply`, or any `--dry-run`): it reads, signs in and previews only.

## 9. Tests

`node --test scripts/hosted/internal-box.test.mjs` (also in `pnpm test:launch-signoff`) runs every command against fakes of the control plane, GHCR, a box, a source instance, `security` and `railway`, through the real operator CLI code.
