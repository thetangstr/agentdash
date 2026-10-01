---
title: Gemini Local
summary: Run the Gemini CLI on the AgentDash server host as an agent's runtime
---

The `gemini_local` adapter runs Google's Gemini CLI on the machine that runs the AgentDash server. It passes the prompt with `--prompt`, reads `--output-format stream-json`, and resumes sessions across heartbeats with `--resume`.

Source: `packages/adapters/gemini-local/src/` (`index.ts` for fields, `server/execute.ts`, `server/test.ts`).

## Prerequisites

- The `gemini` CLI installed on the server host.
- Credentials: `GEMINI_API_KEY` or `GOOGLE_API_KEY` in the server environment or the agent's `env`, or a local Gemini CLI login.

## Configuration fields

| Field | Type | Description |
|---|---|---|
| `cwd` | string | Absolute working directory. Created if missing when permissions allow. |
| `model` | string | Gemini model id. Default `auto`, which sends no `--model` flag. |
| `promptTemplate` | string | Prompt for each run. |
| `instructionsFilePath` | string | Absolute path to a markdown instructions file prepended to the prompt. |
| `sandbox` | boolean | `true` passes `--sandbox`. Default `false`, which passes `--sandbox=none`. |
| `command` | string | Binary to run. Default `gemini`. |
| `extraArgs` | string[] | Extra CLI arguments. |
| `env` | object | Environment variables. Values can be secret references. |
| `timeoutSec` | number | Run timeout in seconds. `0` or unset means none. |
| `graceSec` | number | Seconds between SIGTERM and SIGKILL. Default `20`. |

Every run passes `--approval-mode yolo`, because an unattended run cannot answer approval prompts. There is no setting to turn it off.

## Sessions

The adapter stores the Gemini session id and resumes it with `--resume` on the next wake. Resume is cwd-aware: if the working directory changed, a fresh session starts. If Gemini reports the session as unavailable, the adapter retries once with a fresh session.

## Skills

The agent's selected skills are symlinked into `~/.gemini/skills/` on the server host, so the CLI finds them next to its own credentials. An existing directory with the same name is left alone; a broken link is repaired.

## Environment test

The **Test** button in the Adapter section of the agent's configuration form checks:

- the configured command resolves
- the working directory is absolute and usable
- whether `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set
- a live hello probe: `gemini --output-format stream-json --prompt "Respond with hello."`, with a separate timeout (`helloProbeTimeoutSec`, default 10 seconds). It reports quota exhaustion, timeouts and auth failures separately. Skipped when `command` is not `gemini`.

Source: `packages/adapters/gemini-local/src/server/test.ts`.
