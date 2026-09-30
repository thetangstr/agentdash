# Leaving AgentDash on a Mac Mini

One command, run as the user who will own the install:

```sh
AGENTDASH_INSTANCE=mkboard ./deploy/install.sh
```

It is idempotent — re-run it after a code change or a config edit.

## What it does

1. Checks the checkout and the env file exist, and sets the env file to `600`
   (it holds `DATABASE_URL`, `BETTER_AUTH_SECRET` and the license key).
2. **Rebuilds `ui/dist`.** Not optional: the server serves a pre-built bundle,
   so a stale one silently shows old code in the browser. This was observed in
   the wild as a five-day-old bundle that made UI fixes look unapplied.
3. Disables sleep via `pmset` if it can do so without a password, and prints the
   command if it cannot. A sleeping Mini is a dead AgentDash.
4. Installs two LaunchAgents and waits for `/api/health` to answer `200`.

## The services

| | |
|---|---|
| `com.agentdash.postgres` | The database. **One, shared by every instance.** Installed and waited for before any server |
| `com.agentdash.<instance>.server` | Starts at login, restarts on crash (15s throttle) |
| `com.agentdash.<instance>.backup` | Nightly at 03:30, catches up if the Mini was asleep |

Postgres was unmanaged for the whole of development — started once by hand and
kept alive by luck. When it died, both instances crash-looped with
`ECONNREFUSED 127.0.0.1:54329` and the logs blamed the *server*, not the thing
that was actually missing. On a reboot it would never have come back, and the
install would have looked like a server bug.

Logs: `~/Library/Logs/agentdash/<instance>-{server,backup}.log`
Backups: `~/.paperclip/backups/<instance>/`, retained 14 daily / 8 weekly / 12 monthly.

```sh
# after install-launchdaemons.sh (the MKThink Mini), services live in the system domain:
sudo launchctl print system/com.agentdash.mkboard.server | head
sudo launchctl kickstart -k system/com.agentdash.mkboard.backup   # backup now

# before that migration, they are login-scoped:
launchctl print gui/$(id -u)/com.agentdash.mkboard.server | head
launchctl kickstart -k gui/$(id -u)/com.agentdash.mkboard.backup   # backup now
```

## Updating over the air

The Mini runs the repository itself, so an update is a release tag, not an
image. `scripts/deploy/ota-apply.mjs` owns both halves of the loop, with the
same discipline as the Docker updater beside it: back up, apply, prove
`/api/health`, roll back to the exact previous release if health does not
return, and leave a receipt under `~/.agentdash/deployments/`.

```sh
# What would the board offer right now? Writes available-release.json,
# changes nothing else. The daily launchd job runs exactly this.
node ~/.agentdash/bin/ota-apply.mjs --check

# Apply an approved release by tag. With no --restart-command, the restart
# is verified against launchd first (see below).
node ~/.agentdash/bin/ota-apply.mjs --tag v2026.929.0 \
  --backup-command "AGENTDASH_APP_DIR=$HOME/.agentdash/releases/current $HOME/.agentdash/releases/current/deploy/agentdash-backup.sh"

# What would a prune remove? Lists only.
node ~/.agentdash/bin/ota-apply.mjs --prune --dry-run
```

**Restart.** Do not use `launchctl kickstart -k system/com.agentdash.mkboard.server`
as the restart command. Kickstarting a system-domain daemon needs root, and
neither the scheduled job nor an SSH session has it. Passing no restart
command at all used to be worse: the restart ran `/bin/sh -c undefined`,
exited 127 after the switch, and the update rolled back.

Without `--restart-command`, the apply restarts the server by killing its
process chain, and launchd's `KeepAlive` starts it again from
`releases/current`. It verifies that chain first, before the backup and before
the switch:

- It reads the job's pid from `launchctl print system/<label>`, or
  `gui/<uid>/<label>`, which needs no root. The label defaults to
  `com.agentdash.mkboard.server` and can be set with `--service-label`.
- The listener on the port must descend from that pid. The port comes from
  `--port`, or from a loopback `--base-url` with an explicit port.
- The pid must be launchd's direct child.
- Nothing in the chain may be a terminal, tmux, screen, sshd, login, Caddy or
  launchd.

It kills only the listener up to and including the job's pid. If it cannot
verify all of that, the apply refuses and changes nothing, in `--dry-run` too.
So it refuses a `--base-url` on Caddy's port 3112, and a server started by
hand in a terminal. It never kills the terminal or tmux. The receipt's
`restart_command` check lists the exact pids.

A hand-written "kill whatever listens on the port and its parents" script
walks up to pid 1 without checking. Pass one as `--restart-command` only when
you have looked at what is listening.

**Health means the new release is serving.** A healthy `/api/health` is not
enough on its own: a restart that did nothing leaves the old process
answering, healthy, from the old release. The server reports `releaseCommit`,
the commit in the completion marker (`.agentdash-release.json`) of the release
directory its code was loaded from. After the restart the apply polls until
health is ok and `releaseCommit` equals the target commit. If the old commit,
or no `releaseCommit`, is still being reported when `--health-timeout` runs
out, the update has failed and rolls back. Two consequences:

- A target release whose server predates `releaseCommit` is refused before
  the backup (check `served_release`), because it could never pass.
- The marker is now required: if it cannot be written after the build, the
  apply fails before the switch instead of rolling back after it.

**Rollback.** If health fails, `current` goes back to the previous release and
the apply restarts again. Then it always checks health again. A rollback
restart that finds nothing to kill is recorded as skipped, because a release
that crashed at boot leaves nothing listening and launchd brings the old one
back on its own. Health decides whether that recovered. When the previous
release reports `releaseCommit`, rollback health must report its commit too.
When it predates the field, health ok is accepted without it, and the
receipt's `rollback_health` check says `served release NOT verified`.

Five things about it are deliberate:

- **It runs from `~/.agentdash/bin`, not from a release or the checkout.** The
  updater lives inside the thing it updates. The first live rollback attempt
  died with `MODULE_NOT_FOUND` because the update before it had checked out a
  commit where the script did not exist yet. A healthy apply installs
  `agentdash-update.sh`, `ota-apply.mjs` and the `ota-release-layout.mjs` it
  imports into `~/.agentdash/bin`, from the release it just proved. If a
  rename fails part-way, the old set is put back. The wrapper also refreshes
  the two `.mjs` files from `releases/current` on every run. It falls back to
  the checkout only on a box that has no release yet. Neither path ever
  downgrades the installed updater: `ota-apply.mjs` declares
  `UPDATER_VERSION`, and when the release's is older than the installed one
  (a rollback to a release that predates an updater fix) the installed copies
  are kept and the receipt or the job log says so. The wrapper replaces the
  two files together or not at all. Bump `UPDATER_VERSION` whenever the
  updater's behaviour changes.
- **Almost nothing runs from the checkout.** `install-launchdaemons.sh`
  refuses, and installs nothing, when a plist names a path inside
  `~/agentdash`. It also refuses when a plist's program does not exist, and
  when `~/.agentdash/bin` lacks the updater that the update job needs. Two
  exceptions are documented:
  - the update job's fetch-only `AGENTDASH_REPO_DIR`;
  - Postgres (below).

  A job that runs from the checkout drifts behind the serving release,
  because an apply never updates the checkout. The daily check then runs a
  retired updater and reports a commit nothing is serving.
- **A human approves before anything applies.** `--check` only writes the
  offer file (`available-release.json`) that the board's read-only status
  endpoint renders. The apply path refuses without an approval that names the
  exact tag and commit. An approval is single-use: once an apply completes,
  whether `applied` or `rolled_back`, `deployments/pending-approval.json` is
  moved to `deployments/used-approvals/<receipt>-<id>.json`, annotated with
  `consumedAt`, `consumedByReceipt` and `consumedOutcome`, and the receipt
  records `approvalConsumed`. Applying the same tag again, or retrying after a
  rollback, needs a fresh approval. A run that stops before completing (a
  refused gate, a failed build, a rollback that did not recover) keeps the
  approval for a retry. An approval may carry an optional `expiresAt`; after
  that time both the board and the apply refuse it.
- **It refuses to update without a backup** unless you pass `--skip-backup`
  and say so out loud. It also refuses a release that adds migrations unless
  you pass `--allow-migrations`, because automatic rollback restores code, not
  data.
- **Old releases are pruned after a healthy apply, carefully.**
  - It keeps current and previous.
  - It keeps anything a running process uses: named on a command line, or
    held as a working directory or mapped file (`lsof -d cwd,txt`).
  - It keeps anything an installed `com.agentdash.*` plist names.
  - It keeps `--keep-releases` more release tags (default 5), newest by
    version, so `v2026.1001.0` is newer than `v2026.929.0`.
  - `candidate-*`, `hotfix-*` and other untagged directories are never pruned
    without `--prune-untagged`.
  - If `ps` or `lsof` cannot answer, nothing is pruned.
  - More than 5 removals at once are held. The receipt lists them, and nothing
    is deleted until `ota-apply.mjs --prune --prune-confirm`.

A rerun after a failed apply reuses the release directory only if it carries
the completion marker (`.agentdash-release.json`) for the same commit. That
marker is written after the build and seal. A directory without it is removed
and exported again. The apply refuses instead, and asks for a person, when
that directory is the current or previous release, a running process uses
it, or an installed `com.agentdash.*` plist names it (the same protections
pruning applies).

**Postgres stays on the checkout, on purpose.** `com.agentdash.postgres` runs
the embedded-postgres binary from `~/agentdash/node_modules`. Pointing it at
`releases/current` would let an ordinary apply, and the next Postgres restart
(a reboot, say), change the database binary silently. A release with a
different embedded-postgres major version would then not start on the
existing data directory. Moving it is a separate, explicit migration, not part
of any apply:

1. Copy the embedded-postgres native directory, the one containing `bin/`,
   `lib/` and `share/`, to a stable, never-pruned path such as
   `~/.agentdash/postgres/<version>/`.
2. Check that `$PGDATA/PG_VERSION` matches that binary's major version.
3. Change `agentdash-postgres.sh` to take that path, for example
   `AGENTDASH_PGBIN`. It has no such override today.
4. Repoint the plist, and remove its exception in `install-launchdaemons.sh`.
5. Restart Postgres in a maintenance window, after a backup.

`deploy/agentdash-update.sh` is the scheduled wrapper, installed by
`install-launchdaemons.sh` as `com.agentdash.update` (09:15 daily). It is
**check-only**: it refreshes the offer file and changes nothing else.
`AGENTDASH_UPDATE_APPLY=1` currently makes the job exit non-zero with a clear
refusal. Unattended apply is unsupported until the `releases/current`
bootstrap is decided, because a box that serves straight from its git
checkout would keep running the old code while a receipt said "applied".
An operator can still run `ota-apply.mjs --tag ...` by hand on a releases
layout once that layout exists.

That default is a judgement, not timidity. A bad commit reaching `main` can
reach a customer's Mini within the hour — on 2026-08-18 one did, and broke the
agent's heartbeat in production. Rollback exists and is tested end to end on
this machine, but "it repairs itself afterwards" is a weaker promise than "a
person decided".

## Two decisions worth knowing

**LaunchAgents first, LaunchDaemons once the box is unattended.** The harnesses
keep their credentials under `$HOME` — Hermes reads `~/.hermes/.env` — and the
instance data lives in `~/.paperclip`. A daemon running as root has a different
`$HOME` and would authenticate as nobody, which is why `install.sh` writes
LaunchAgents.

The cost is real: **a user agent needs that user logged in.** For an unattended
Mini, `install-launchdaemons.sh` moves the services into the system domain with
`UserName` set, so they start at boot without a login and still read the right
`$HOME`. Verified with FileVault off; with FileVault on, the home volume is not
readable at boot and this buys nothing.

**Exactly one supervisor per instance.** The two mechanisms must never both own
a service. Booting a LaunchAgent out is not enough to retire it: launchd
re-bootstraps everything in `~/Library/LaunchAgents` at the next login, and a
later `launchctl bootstrap gui/$(id -u) …` resurrects it by hand. The migration
therefore renames each agent plist to `*.plist.disabled`.

If two ever do run, the symptom is not an obvious crash. The loser of the port
race falls back to the next free port, answers `/api/health` with `status: ok`,
and serves nobody — Caddy proxies only 3102. Observed on the Mini on
2026-08-18. When a restart looks wrong, count the listeners before anything
else:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -E '310[0-9]'   # expect one line per instance
```

**The backup does not use `pg_dump`.** The embedded Postgres this stack runs on
ships only `initdb`, `pg_ctl` and `postgres` — there is no `pg_dump` on the
machine. `server/scripts/nightly-backup.mjs` uses the repository's own
`runDatabaseBackup` with `backupEngine: "auto"`, which falls back to the
JavaScript engine. The first version of this script shelled out to `pg_dump`
and failed on its first real run.

Neither script uses `paperclipai run` or `paperclipai db-backup`: both are built
for a human at a terminal and can stop to ask a question. A service that blocks
on a prompt never becomes healthy, and a backup that can block is not a backup.

## Remote access over Tailscale

`tailscaled` runs as a root LaunchDaemon (`sudo brew services start tailscale`),
so unlike the AgentDash agents it comes back on boot with nobody logged in.

Reaching a instance over Tailscale needs its hostname in **one** setting:

```
PAPERCLIP_ALLOWED_HOSTNAMES=mkmini.local,<tailscale-ip>,<machine>.<tailnet>.ts.net
```

That is enough for both gates. `deriveAuthTrustedOrigins` builds Better Auth's
trusted origins from every entry in this list (http and https, with and without
the port) *in addition to* the auth base URL — so the base URL stays on the LAN
address and LAN access keeps working. Without the entry you get
`403 INVALID_ORIGIN`, the same failure the seed script hit when run against
loopback instead of the LAN address.

To remove Tailscale later, delete the block at the end of each env file and:

```sh
sudo tailscale logout && sudo brew services stop tailscale && brew uninstall tailscale
```

## Verified on 2026-08-14

- Installer ran clean for both instances, and is idempotent across re-runs.
- Killed each server with `kill -9`; launchd restarted both within 5s.
- **Killed Postgres with `kill -9`; the whole stack was healthy again within
  10s** — new database PID, both servers back at `200` without intervention.
- Reached both instances over Tailscale: health `200`, host gate `200` via the
  MagicDNS name, and the auth origin accepted (a `400` for a missing body,
  rather than the `403 INVALID_ORIGIN` that means the origin was rejected).
- Backup produced a 204,692-byte gzipped dump of the live database, both from
  the shell and triggered through launchd.

Restore is `runDatabaseRestore` in `@paperclipai/db` — **untested here.** Prove
it against a scratch database before you rely on it.
