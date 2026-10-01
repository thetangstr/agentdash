---
title: Process adapter
summary: Run a shell command of your own as an agent's runtime
---

The `process` adapter runs a command you configure as a child process on the AgentDash server host. Use it for a script or a custom agent loop that you start from the command line. The web UI's agent picker does not offer it; set it through the [agents API](/api/agents).

Source: `server/src/adapters/process/` (`index.ts`, `execute.ts`, `test.ts`).

## When to use it

- A script that calls the AgentDash API and exits.
- A custom agent loop you already run from a shell.

It keeps no session between runs. If the agent needs conversation context across heartbeats, use a CLI adapter such as [`claude_local`](/adapters/claude-local) or [`codex_local`](/adapters/codex-local).

## Configuration fields

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | string | Yes | Command to run. |
| `args` | string[] or string | No | Command arguments. |
| `cwd` | string | No | Working directory. Defaults to the server's working directory. |
| `env` | object | No | Environment variables. Secret references are resolved before the run. |
| `timeoutSec` | number | No | Run timeout in seconds. `0` or unset means none. |
| `graceSec` | number | No | Seconds between SIGTERM and SIGKILL. Default `15`. |

## How a run works

1. The server spawns `command` with `args` in `cwd`.
2. It sets `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID` and `PAPERCLIP_API_URL`, then your `env` on top (`buildPaperclipEnv` in `packages/adapter-utils/src/server-utils.ts`).
3. Stdout and stderr stream into the run log.
4. Exit code `0` is success. Any other code fails the run. A timeout fails it as timed out.

The adapter does not mint an API key for the run. To call the AgentDash API, give the script an [agent API key](/api/api-keys) through `env`, for example `PAPERCLIP_API_KEY` as a secret reference.

## Example

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3",
    "args": ["/srv/agents/triage.py"],
    "cwd": "/srv/agents",
    "timeoutSec": 300
  }
}
```

## Environment test

The test checks that `command` is set and resolves, and that `cwd` is a valid absolute directory. Source: `server/src/adapters/process/test.ts`.
