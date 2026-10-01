---
title: Claude Local
summary: Run Claude Code on the AgentDash server host as an agent's runtime
---

The `claude_local` adapter runs Anthropic's Claude Code CLI in headless `--print` mode on the machine that runs the AgentDash server. It resumes sessions across heartbeats, gives the agent its skills and instructions bundle, and parses Claude's `stream-json` output into the run transcript.

Source: `packages/adapters/claude-local/src/` (`index.ts` holds the field list, `server/execute.ts` the run logic).

## Prerequisites

- The `claude` CLI installed on the server host.
- Credentials Claude Code can use there: `ANTHROPIC_API_KEY` in the server environment or the agent's `env`, or a Claude subscription login on that machine.

## Configuration fields

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Absolute working directory. Created if missing when permissions allow. |
| `model` | string | Claude model id. |
| `effort` | string | Reasoning effort passed as `--effort` (`low`, `medium`, `high`). |
| `chrome` | boolean | Pass `--chrome`. |
| `promptTemplate` | string | Prompt for each run. |
| `instructionsFilePath` | string | Absolute path to a markdown instructions file. AgentDash sets this for agents with a managed instructions bundle. |
| `maxTurnsPerRun` | number | Passed as `--max-turns`. `0` or unset sends no limit. The UI form fills in `1000` for new agents. |
| `dangerouslySkipPermissions` | boolean | Pass `--dangerously-skip-permissions`. Default `true`, because a headless run cannot answer permission prompts. |
| `command` | string | Binary to run. Default `claude`. |
| `extraArgs` | string[] | Extra CLI arguments. |
| `env` | object | Environment variables. Values can be secret references. |
| `timeoutSec` | number | Run timeout in seconds. `0` means none. |
| `graceSec` | number | Seconds between SIGTERM and SIGKILL. |
| `workspaceStrategy` | object | Execution workspace strategy. Supports `{ type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }`. |

## Prompt templates

`promptTemplate` uses `{{variable}}` substitution. The template receives `agentId`, `companyId`, `runId`, `agent` (the agent record, so `{{agent.name}}` works), `company.id`, `run.id` and `context`. Source: `templateData` in `server/execute.ts`.

## Sessions

The adapter stores the Claude session id after each run and resumes it on the next wake. Resume is cwd-aware: if the working directory changed, a fresh session starts. If Claude reports the saved session as unknown, the adapter retries once with a fresh session.

## Skills and instructions

Each run gets a per-company prompt bundle directory with the agent's selected skills. It is passed to Claude with `--add-dir`, so the agent's working directory is not touched. On a fresh session the instructions file is passed with `--append-system-prompt-file`.

To run Claude Code by hand as an agent, outside a heartbeat, use the CLI from a checkout:

```sh
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

It installs the repository's skills into `~/.claude/skills` and `~/.codex/skills`, creates an agent API key, and prints the `PAPERCLIP_*` shell exports for that agent. Source: `cli/src/commands/client/agent.ts`.

## Environment test

The **Test** button in the Adapter section of the agent's configuration form runs the adapter's environment test. For `claude_local` it checks:

- the `claude` command resolves
- the working directory is absolute and usable
- which auth mode applies (`ANTHROPIC_API_KEY`, a subscription login, or Bedrock)
- a live hello probe: `claude --print - --output-format stream-json --verbose` with the prompt `Respond with hello.` The probe is skipped when `command` is not `claude`.

Source: `packages/adapters/claude-local/src/server/test.ts`.
