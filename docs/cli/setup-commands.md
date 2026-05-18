---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `agentdash run`

One-command bootstrap and start:

```sh
pnpm agentdash run
```

Does:

1. Auto-onboards if config is missing
2. Runs `agentdash doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm agentdash run --instance dev
```

## `agentdash onboard`

Interactive first-time setup:

```sh
pnpm agentdash onboard
```

If AgentDash is already configured, rerunning `onboard` keeps the existing config in place. Use `agentdash configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm agentdash onboard --run
```

Non-interactive defaults + immediate start (opens browser on server listen):

```sh
pnpm agentdash onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts AgentDash with that setup.

## `agentdash doctor`

Health checks with optional auto-repair:

```sh
pnpm agentdash doctor
pnpm agentdash doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration
- Storage configuration
- Missing key files

## `agentdash configure`

Update configuration sections:

```sh
pnpm agentdash configure --section server
pnpm agentdash configure --section secrets
pnpm agentdash configure --section storage
```

## `agentdash env`

Show resolved environment configuration:

```sh
pnpm agentdash env
```

This now includes bind-oriented deployment settings such as `PAPERCLIP_BIND` and `PAPERCLIP_BIND_HOST` when configured.

## `agentdash allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm agentdash allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Logs | `~/.paperclip/instances/default/logs` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |

Override with:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm agentdash run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm agentdash run --data-dir ./tmp/agentdash-dev
pnpm agentdash doctor --data-dir ./tmp/agentdash-dev
```
