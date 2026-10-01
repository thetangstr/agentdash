---
title: Local development
summary: Run AgentDash from a clone of the repository to work on it
---

This page is for contributors running AgentDash from source. To use AgentDash, start with [AgentDash Cloud](/start/quickstart); to self-host it, see the [Deploy overview](/deploy/overview).

## Prerequisites

- Node.js 20 or later (`engines.node` in the root `package.json`)
- pnpm 9 (the repository pins `pnpm@9.15.4` in `packageManager`; `corepack enable` picks it up)
- Git

No Docker or external database is needed. With no `DATABASE_URL`, the server starts an embedded PostgreSQL.

## Clone and start

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
pnpm install
pnpm dev
```

`pnpm dev` starts the API server on `http://localhost:3100` and serves the UI from the same origin through dev middleware. It watches for changes and restarts. Unless your instance config says otherwise, it runs in `local_trusted` mode, bound to loopback, with no sign-in.

Other dev scripts from the root `package.json`:

| Command | What it does |
|---|---|
| `pnpm dev:once` | Start once, without watching |
| `pnpm dev:list` | List running dev servers |
| `pnpm dev:stop` | Stop a running dev server |
| `pnpm dev:server` / `pnpm dev:ui` | Run only the server or only the UI package |
| `pnpm db:migrate` | Apply pending database migrations |
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Build the packages and run the Vitest suite |

The dev runner applies pending migrations automatically (it sets `PAPERCLIP_MIGRATION_AUTO_APPLY=true`). Source: `scripts/dev-runner.ts`.

## The repository CLI

The repository's CLI runs from the clone as `pnpm paperclipai <command>` (the `paperclipai` script in the root `package.json`). Do not use `npx paperclipai`: that npm package is not AgentDash.

```sh
pnpm paperclipai run
```

`run` writes a config with the setup wizard if none exists, runs `doctor` with repairs on, and starts the server if the checks pass. Source: `cli/src/commands/run.ts`. More commands: [Setup commands](/cli/setup-commands).

## Open the dev server to other devices

By default the dev server listens on loopback only. To listen on other interfaces, pass a bind preset. Any preset other than `loopback` switches the server to `authenticated` + `private`, so sign-in is required, and the server will not start without `BETTER_AUTH_SECRET` in the environment (source: `server/src/auth/better-auth.ts`).

```sh
pnpm dev --bind lan       # all interfaces
pnpm dev --bind tailnet   # the machine's Tailscale address only
pnpm dev --bind custom --bind-host 10.0.0.5
```

`--tailscale-auth` and `--authenticated-private` still work as aliases for `--bind lan`. To allow an extra private hostname:

```sh
pnpm paperclipai allowed-hostname my-laptop
```

See [Tailscale private access](/deploy/tailscale-private-access) for the full setup.

## Check it is running

```sh
curl http://localhost:3100/api/health
```

The response is JSON with `"status": "ok"`. Source: `server/src/routes/health.ts`.

## Where data lives

All instance data sits under `PAPERCLIP_HOME` (default `~/.paperclip`), in `instances/<PAPERCLIP_INSTANCE_ID>` (default `default`). Source: `server/src/home-paths.ts`.

| Data | Default path |
|---|---|
| Config | `~/.paperclip/instances/default/config.json` |
| Embedded database | `~/.paperclip/instances/default/db` |
| Database backups | `~/.paperclip/instances/default/data/backups` |
| Uploaded files | `~/.paperclip/instances/default/data/storage` |
| Secrets master key | `~/.paperclip/instances/default/secrets/master.key` |
| Logs | `~/.paperclip/instances/default/logs` |
| Agent workspaces | `~/.paperclip/instances/default/workspaces` |

Run a second, separate instance by changing either variable:

```sh
PAPERCLIP_HOME=/tmp/agentdash-scratch PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## Reset local data

Stop the server, then remove the embedded database:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

This deletes every company, agent and issue in that instance. Uploaded files and the secrets key are separate and stay.
