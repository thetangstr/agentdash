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
launchctl print gui/$(id -u)/com.agentdash.mkboard.server | head
launchctl kickstart -k gui/$(id -u)/com.agentdash.mkboard.backup   # backup now
```

## Two decisions worth knowing

**LaunchAgents, not LaunchDaemons.** The harnesses keep their credentials under
`$HOME` — Hermes reads `~/.hermes/.env` — and the instance data lives in
`~/.paperclip`. A daemon runs as root with a different `$HOME` and would
authenticate as nobody.

The cost is real: **a user agent needs that user logged in.** On an unattended
Mini, turn on automatic login, or the service will not come back after a power
cut. This is the one thing the installer cannot do for you.

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
