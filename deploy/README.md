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

The Mini runs the repository itself, so an update is a commit, not an image.
`scripts/deploy/agentdash-source-update.mjs` does it with the same discipline as
the Docker updater beside it: back up, apply, prove `/api/health`, roll back to
the exact previous commit if health does not return, and leave a receipt under
`~/.agentdash/deployments/`.

```sh
# Is this box behind GitHub? Changes nothing.
node ~/.agentdash/bin/agentdash-source-update.mjs --check

# Apply whatever origin/main points at.
node ~/.agentdash/bin/agentdash-source-update.mjs \
  --backup-command "AGENTDASH_INSTANCE=mkboard /bin/sh ~/agentdash/deploy/agentdash-backup.sh"

# Go back to the commit that was running before.
node ~/.agentdash/bin/agentdash-source-update.mjs --rollback --backup-command "…"
```

Three things about it are deliberate:

- **It runs from `~/.agentdash/bin`, not from the checkout.** The updater lives
  inside the thing it updates; the first live rollback attempt died with
  `MODULE_NOT_FOUND` because the update before it had checked out a commit where
  the script did not exist yet. A successful update refreshes that standalone
  copy from the commit it just deployed.
- **It detaches to the target commit** rather than fast-forwarding a branch,
  because a rollback goes backwards and a fast-forward cannot.
- **It refuses to run against a dirty tree, and refuses to update without a
  backup** unless you pass `--skip-backup` and say so out loud.

`deploy/agentdash-update.sh` is the scheduled wrapper, installed by
`install-launchdaemons.sh` as `com.agentdash.update` (09:15 daily). It is
**check-only by default**: it reports that the box is behind and changes
nothing. Set `AGENTDASH_UPDATE_APPLY=1` in the instance env file to let it
deploy unattended.

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
