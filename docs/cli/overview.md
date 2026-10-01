---
title: Operator CLI overview
summary: The operator CLI for a self-hosted AgentDash instance, run from a checkout of the repository
---

Most people do not need this CLI.

- To connect Claude Code or Codex on your machine to your AgentDash agent, use [agentdash-connect](/cli/agentdash-connect).
- To give an MCP client the AgentDash tools over stdio, use the [MCP server](/cli/agentdash-mcp).

`paperclipai` is the self-host and operator CLI. It sets up and diagnoses an instance, and has client commands for issues, agents, approvals and more. It runs from a clone of the repository:

```sh
git clone https://github.com/thetangstr/agentdash.git
cd agentdash
pnpm install
pnpm paperclipai --help
```

`pnpm paperclipai` is a root `package.json` script that runs `cli/src/index.ts` with `tsx`. Do not use `npx paperclipai`: that npm package is not AgentDash. Source: `cli/src/index.ts`.

See [Local development](/deploy/local-development) for prerequisites.

## Common options

Setup commands (`setup`, `onboard`, `run`, `doctor`, `configure`, `env`, `db:backup`, `allowed-hostname`) take:

| Flag | Description |
|---|---|
| `-c, --config <path>` | Config file path |
| `-d, --data-dir <path>` | Data root, instead of `~/.paperclip` |

Client commands (`issue`, `agent`, `approval`, `company`, `activity`, `dashboard`) also take (`cli/src/commands/client/common.ts`):

| Flag | Description |
|---|---|
| `--context <path>` | CLI context file |
| `--profile <name>` | Context profile |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | Bearer token |
| `--json` | Raw JSON output |
| `-C, --company-id <id>` | Company id, on company-scoped commands |

For a throwaway local instance, pass `--data-dir`:

```sh
pnpm paperclipai run --data-dir ./tmp/agentdash-dev
```

## Context profiles

Store defaults so you do not repeat flags:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

To keep the API key out of the context file, store the name of an env var instead:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

Context lives in `~/.paperclip/context.json` (under `PAPERCLIP_HOME` when set).

## Command groups

1. [Setup commands](/cli/setup-commands): first-run setup, start, diagnostics, configuration.
2. [Control-plane commands](/cli/control-plane-commands): issues, agents, approvals, companies, activity, dashboard, heartbeats.
