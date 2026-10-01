---
title: Setup commands
summary: Set up, start, diagnose and configure a self-hosted instance with the operator CLI
---

Commands for setting up and running a self-hosted instance. Run them from a checkout as `pnpm paperclipai <command>` (see the [CLI overview](/cli/overview)). Each one takes `-c, --config <path>` and `-d, --data-dir <path>`. Source: `cli/src/index.ts`, `cli/src/commands/`.

## `setup`

The first-run wizard:

```sh
pnpm paperclipai setup
```

If there is no config yet, it writes one with safe defaults: embedded PostgreSQL, local-disk storage, local encrypted secrets, port 3100. The bind mode is `tailnet` when Tailscale is running, otherwise `loopback`. On a machine with a LAN address and no Tailscale, it asks whether to stay local or listen on the network. It then asks for an adapter, checks that its CLI is installed, and saves the choice as `AGENTDASH_DEFAULT_ADAPTER` in the instance's env file. It also creates the agent JWT secret if missing. Source: `cli/src/commands/setup.ts`.

| Flag | Description |
|---|---|
| `--adapter <type>` | Adapter for the first agent; skips the prompt |
| `-y, --yes` | Non-interactive. The adapter defaults to `claude_local`. |

Subcommands re-run one step:

```sh
pnpm paperclipai setup adapter [--type <adapter>] [--yes]
pnpm paperclipai setup server [--bind loopback|lan|tailnet] [--port <n>] [--yes]
pnpm paperclipai setup bootstrap [--force] [--expires-hours <n>] [--base-url <url>] [--no-open]
```

`setup bootstrap` creates the first-admin invite for an authenticated instance and opens it in the browser.

## `run`

Start the instance:

```sh
pnpm paperclipai run
```

1. If there is no config, it runs `setup` (interactive terminals only).
2. It runs `doctor` with repair on.
3. It starts the server when the checks pass.

| Flag | Description |
|---|---|
| `-i, --instance <id>` | Local instance id. Default `default`. |
| `--bind <mode>` | On first run, the reachability preset (`loopback`, `lan`, `tailnet`) |
| `--no-repair` | Run doctor without repairs |

## `onboard`

The advanced setup wizard, with prompts for database, LLM, storage and server:

```sh
pnpm paperclipai onboard
```

The first prompt is **Quickstart** (local defaults) or **Advanced setup**. If a config already exists, `onboard` keeps it unchanged; use `configure` to change it.

| Flag | Description |
|---|---|
| `--run` | Start the server after saving the config |
| `-y, --yes` | Accept Quickstart defaults and start |
| `--bind <mode>` | Quickstart reachability preset (`loopback`, `lan`, `tailnet`) |

## `doctor`

Health checks, with optional repair:

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair [--yes]
```

It checks the config file, deployment and auth mode, the agent JWT secret, secrets, storage, the database, the LLM provider, the log directory and the server port. Source: `cli/src/commands/doctor.ts`, `cli/src/checks/`.

## `configure`

Change one section of the config:

```sh
pnpm paperclipai configure --section server
```

Sections: `llm`, `database`, `logging`, `server`, `storage`, `secrets`.

## `env`

Print the environment variables a deployment needs, resolved from the current config (database URL, port, origins, agent JWT, secrets and storage settings):

```sh
pnpm paperclipai env
```

## `db:backup`

Make a one-off database backup:

```sh
pnpm paperclipai db:backup [--dir <path>] [--retention-days <n>] [--filename-prefix <prefix>] [--json]
```

## `allowed-hostname`

Allow a hostname for authenticated or private access:

```sh
pnpm paperclipai allowed-hostname <host>
```

## `auth bootstrap-ceo`

Create a one-time invite URL for the first instance admin:

```sh
pnpm paperclipai auth bootstrap-ceo [--force] [--expires-hours <n>] [--base-url <url>]
```

`setup bootstrap` does the same and opens the link.

## Local paths

| Data | Default path |
|---|---|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Logs | `~/.paperclip/instances/default/logs` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Backups | `~/.paperclip/instances/default/data/backups` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

Source: `cli/src/config/home.ts`. Override the root and instance with environment variables:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

or pass `--data-dir` on any command:

```sh
pnpm paperclipai run --data-dir ./tmp/agentdash-dev
pnpm paperclipai doctor --data-dir ./tmp/agentdash-dev
```

For running from source day to day, see [Local development](/deploy/local-development). For a container, see [Docker](/deploy/docker).
