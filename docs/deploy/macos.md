---
title: macOS (launchd)
summary: Run AgentDash on an always-on Mac as a launchd service, from a source checkout pinned to a git SHA
---

This runs AgentDash on one Mac (a Mac mini, for example) as a per-user launchd service. launchd starts it at login and restarts it if it exits. It runs from a clone of https://github.com/thetangstr/agentdash that is pinned to one reviewed git commit, in `authenticated` + `private` mode for access over Tailscale or a LAN.

The installer is `scripts/deploy/agentdash-mac-mini-source-launchd.mjs`. It writes the files below and starts nothing itself. Everything on this page comes from that script.

## Before you start

- macOS, with the Mac set to log in to the account that will run AgentDash. The service is a LaunchAgent, so it runs only while that user is logged in.
- Node.js 20 or later, pnpm 9, `git`, `curl` and `lsof`. The generated scripts use the PATH `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`; pass `--tool-path` if your tools are elsewhere.
- The agent CLIs your agents will use (for example `hermes`, `claude` or `codex`), installed and signed in as the same user.
- Optional: Tailscale. See [Tailscale private access](/deploy/tailscale-private-access).

## 1. Check out the commit you will run

```sh
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash
git checkout --detach <commit-sha>
pnpm install --frozen-lockfile
pnpm build
```

The service refuses to start if the checkout's `HEAD` is not the pinned commit.

## 2. Preview the install

Without `--write`, the installer prints the plan and changes nothing:

```sh
node scripts/deploy/agentdash-mac-mini-source-launchd.mjs \
  --repo-dir ~/agentdash \
  --target-sha "$(git rev-parse HEAD)" \
  --public-url http://<tailscale-or-lan-host>:3100
```

`--public-url` is the address people will open in a browser. Other options: `--paperclip-port` (default `3100`), `--label` (default `ai.agentdash.agent`), `--runtime-env-file`, `--agentdash-home`, `--paperclip-home`, `--launch-agent-dir`, `--tool-path`, `--better-auth-secret`, `--agent-jwt-secret`. Run with `--help` for the full list.

## 3. Write the files

Run the same command with `--write`. It creates:

| Path | What it is |
|---|---|
| `~/.config/agentdash/agentdash.env` | Runtime environment, mode `600` |
| `~/Library/LaunchAgents/ai.agentdash.agent.plist` | The launchd job (`RunAtLoad`, `KeepAlive`) |
| `~/.agentdash/bin/agentdash-source-supervisor.sh` | What launchd runs: loads the env file, checks the SHA, starts the server |
| `~/.agentdash/bin/agentdash-backup-db.sh` | Database backup, with a read-only `--check` |
| `~/.agentdash/bin/agentdash-readiness.sh` | Post-start checks |
| `~/.agentdash/bin/agentdash-source-update.sh` | Update to a new commit |
| `~/.agentdash/bin/agentdash-source-rollback.sh` | Go back to the previous commit |
| `~/.agentdash/RUNBOOK.md` | The same commands, with this machine's paths |
| `~/.agentdash/logs/`, `backups/`, `deployments/` | Logs, backups, deploy state and receipts |

The env file gets these values:

```sh
NODE_ENV=production
PORT=3100
SERVE_UI=true
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_PUBLIC_URL=<your --public-url>
PAPERCLIP_API_URL=http://127.0.0.1:3100
PAPERCLIP_MIGRATION_AUTO_APPLY=true
AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true
AGENTDASH_SOURCE_SHA=<commit-sha>
PAPERCLIP_HOME=~/.paperclip   # expanded to an absolute path
BETTER_AUTH_SECRET=<generated>
PAPERCLIP_AGENT_JWT_SECRET=<generated>
```

`PAPERCLIP_API_URL` stays on loopback, so agents on this Mac call the API directly rather than through the public address.

Re-running with `--write` sets every key above again from the command line, except the two secrets, which are kept if already present. Other lines you added are left alone. So put your own settings (for example `PAPERCLIP_ALLOWED_HOSTNAMES`, `AGENTDASH_DEFAULT_ADAPTER`, `RESEND_API_KEY`) on their own lines, and pass the same options each time. See [Environment variables](/deploy/environment-variables).

## 4. Start it

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.agentdash.agent.plist
curl -fsS http://127.0.0.1:3100/api/health
~/.agentdash/bin/agentdash-readiness.sh
```

The readiness script checks that health responds at the public URL, launchd has the service loaded with a live process, the checkout is at the pinned SHA, the env file is mode `600` and in `authenticated` + `private` mode with both secrets set, and the process listening on the port belongs to the service.

Then make the first admin: see [First admin](/deploy/deployment-modes).

## Service commands

```sh
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent              # restart
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.agentdash.agent.plist   # stop and unload
tail -f ~/.agentdash/logs/launchd.err.log                           # logs (also launchd.out.log)
```

Restart after any change to the env file.

## Update and roll back

```sh
~/.agentdash/bin/agentdash-source-update.sh <new-commit-sha>
~/.agentdash/bin/agentdash-source-rollback.sh
```

The update script backs up the database first and stops if the backup fails, before it changes anything. Then it fetches, checks out the new commit, runs `pnpm install --frozen-lockfile` and `pnpm run build`, restarts the service, runs the readiness checks and writes a receipt to `~/.agentdash/deployments/receipts`. Rollback returns to the previous commit recorded there. It does not restore the database; do that only on purpose.

The update runs `git fetch --all --tags --prune`, so it fails if another remote in the clone has a tag that conflicts with `origin`. Keep the clone's remotes to `origin`.

## Backups

```sh
~/.agentdash/bin/agentdash-backup-db.sh --check   # read-only: can a backup be taken?
~/.agentdash/bin/agentdash-backup-db.sh           # take and verify one
```

It uses `pg_dump` when a compatible one is on the PATH, and otherwise the repository's own backup code (`packages/db/src/backup-lib.ts`), which verifies the archive by restoring it into a scratch database and comparing row counts. The embedded PostgreSQL has no `pg_dump`, so this fallback is the normal path there. The server's own scheduled backups also run (see [Database](/deploy/database)).

For a full restore you need more than the database. Keep copies of:

- `~/.config/agentdash/agentdash.env`
- `PAPERCLIP_HOME` (`~/.paperclip`): the embedded database, uploaded files, and `secrets/master.key`
- `~/.agentdash/backups`
- the commit SHA you were running

## Alternative: the Docker image under launchd

If the Mac has Docker, `scripts/deploy/agentdash-mac-mini-launchd.mjs` sets up the same kind of launchd service around `docker/docker-compose.production.yml` and a pinned `sha-<commit>` image instead of a source checkout. It takes `--target-image` and `--public-url`, defaults to `/opt/agentdash`, and adds `--load` to start the service after `--write`. Run it with `--help`. See [Docker](/deploy/docker) for the image.
