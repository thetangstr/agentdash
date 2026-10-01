---
title: Codex Local
summary: Run the OpenAI Codex CLI on the AgentDash server host as an agent's runtime
---

The `codex_local` adapter runs `codex exec --json` on the machine that runs the AgentDash server. The prompt goes in on stdin. The adapter resumes Codex sessions across heartbeats, runs each company with its own managed `CODEX_HOME`, and links the agent's skills into that home.

Source: `packages/adapters/codex-local/src/` (`index.ts` for fields, `server/execute.ts`, `server/codex-args.ts`, `server/codex-home.ts`, `server/command.ts`).

## Prerequisites

- The Codex CLI installed on the server host.
- Credentials Codex can use: `OPENAI_API_KEY` in the server environment or the agent's `env`, or a `codex` login whose `auth.json` is in the shared Codex home (`CODEX_HOME`, or `~/.codex`).

## Configuration fields

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Absolute working directory. Created if missing when permissions allow. |
| `model` | string | Codex model id, passed as `--model`. |
| `modelReasoningEffort` | string | `minimal`, `low`, `medium`, `high` or `xhigh`, passed as `-c model_reasoning_effort=...`. |
| `promptTemplate` | string | Prompt for each run. |
| `instructionsFilePath` | string | Absolute path to a markdown instructions file prepended to the stdin prompt. |
| `search` | boolean | Run with `--search`. |
| `fastMode` | boolean | Codex Fast mode. See below. |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | Pass `--dangerously-bypass-approvals-and-sandbox`. |
| `command` | string | Binary to run. Default `codex`. |
| `extraArgs` | string[] | Extra CLI arguments. |
| `env` | object | Environment variables. Values can be secret references. Setting `CODEX_HOME` here turns off the managed home. |
| `timeoutSec` | number | Run timeout in seconds. |
| `graceSec` | number | Seconds between SIGTERM and SIGKILL. |
| `workspaceStrategy` | object | Execution workspace strategy. Supports `{ type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }`. |

Every run also passes `--skip-git-repo-check`, because agent workspaces start as empty directories that Codex would otherwise refuse to run in.

## Command resolution

The binary is resolved the same way for the environment test and for the run (`resolveCodexCommand` in `server/command.ts`):

1. `adapterConfig.command`
2. `AGENTDASH_CODEX_COMMAND` in the server environment
3. `codex`

## Sessions

The adapter stores the Codex session id and resumes with `codex exec ... resume <session-id> -` on the next wake. Resume is cwd-aware: if the working directory changed, a fresh session starts. If Codex reports the session as unavailable, the adapter retries once with a fresh session.

## Managed `CODEX_HOME`

Unless the agent's `env` sets `CODEX_HOME`, each run uses a per-company Codex home:

```
$PAPERCLIP_HOME/instances/<instance-id>/companies/<company-id>/codex-home
```

`PAPERCLIP_HOME` defaults to `~/.paperclip` and the instance id to `default`. The managed home is seeded from the shared Codex home: `auth.json` is symlinked; `config.json`, `config.toml` and `instructions.md` are copied. Source: `server/codex-home.ts`.

## Skills

The agent's selected skills are linked into `<effective CODEX_HOME>/skills/` before each run. Broken links that point into an AgentDash skills directory are removed. Other entries, including skills you installed yourself, are left alone.

## Fast mode

With `fastMode` on, the adapter adds:

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

It applies them only for the models in `CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS` (`index.ts`) and for model ids the adapter does not know. For any other model the setting is kept but ignored, and the environment test warns.

## Instructions

If `instructionsFilePath` is set, its contents are prepended to the stdin prompt. On a resumed session that only carries a wake update, they are not sent again.

Codex also loads any repo-level `AGENTS.md` in the working directory on its own. The adapter cannot turn that off, so a repository's `AGENTS.md` may apply in addition to the agent's [mandate](/concepts/mandates-directives-and-the-agent-bundle).

## Manual local CLI

To run Codex by hand as an agent, outside a heartbeat, use the CLI from a checkout:

```sh
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

It installs the repository's skills into `~/.codex/skills` and `~/.claude/skills`, creates an agent API key, and prints the `PAPERCLIP_*` shell exports for that agent.

## Environment test

The **Test** button in the Adapter section of the agent's configuration form checks:

- the configured command resolves
- the working directory is absolute and usable
- an auth signal: `OPENAI_API_KEY`, or a native Codex login in `auth.json`
- Fast mode against the selected model
- a live hello probe: the same `codex exec --json` arguments a run uses (with Fast mode off) and `Respond with hello.` on stdin. Skipped when `command` is not `codex`.

Source: `packages/adapters/codex-local/src/server/test.ts`.
