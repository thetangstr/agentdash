---
title: Hermes Local
summary: Run the Hermes Agent CLI on the AgentDash server host as an agent's runtime
---

The `hermes_local` adapter runs the Hermes Agent CLI (`hermes chat -q "<prompt>" -Q`) on the machine that runs the AgentDash server. Hermes keeps its own provider credentials, model config, skills and MCP servers, so AgentDash does not need LLM keys of its own for these agents. The web UI marks it as a recommended adapter, because on a self-hosted install it is often the only CLI present.

The adapter is the npm package `hermes-paperclip-adapter`, a server dependency patched by `patches/hermes-paperclip-adapter@0.3.0.patch`. AgentDash wraps it in `server/src/adapters/registry.ts` (`hermesLocalAdapter`) to add the agent's mandate, directives, auth, managed profiles and run metering.

## Prerequisites

- The `hermes` CLI installed on the server host (`which hermes`).
- At least one provider configured in Hermes (`hermes status`).

## Configuration fields

From the package's field list (`agentConfigurationDoc`) plus the fields AgentDash's wrapper reads:

| Field | Type | Description |
|---|---|---|
| `model` | string | Model in `provider/model` form. Blank uses Hermes's configured default. |
| `provider` | string | Hermes provider. Usually not needed; Hermes infers it from the model. |
| `promptTemplate` | string | Task prompt. AgentDash puts its API rules in front of it. Blank uses AgentDash's built-in template. |
| `hermesCommand` | string | Path to the `hermes` binary. See command resolution below. |
| `extraArgs` | string[] | Extra CLI arguments. |
| `toolsets` | string | Comma-separated Hermes toolsets to enable. Default: all. |
| `persistSession` | boolean | Resume the Hermes session across heartbeats. Default `true`. |
| `worktreeMode` | boolean | Use a git worktree for changes. Default `false`. |
| `checkpoints` | boolean | Filesystem checkpoints. Default `false`. |
| `verbose` | boolean | Verbose output. Default `false`. |
| `env` | object | Extra environment variables for the Hermes process. Plain values only (see below). |
| `timeoutSec` | number | Run timeout. Default `1800` (the adapter package's `DEFAULT_TIMEOUT_SEC`). |
| `graceSec` | number | Seconds between SIGTERM and SIGKILL. Default `10`. |
| `firstOutputDeadlineMode`, `firstOutputDeadlineSec` | string, number | Per-agent liveness settings. See below. |

An empty `adapterConfig` is a valid start: Hermes uses its own defaults.

**Secrets in `env`.** The wrapper reads `env` from the agent record, where values are stored as envelopes. Plain values are unwrapped. Secret references cannot be resolved there; they are dropped and the run log names the key. Put secrets in the server environment or in Hermes's own config instead. Source: `unwrapHermesEnvValues` in `server/src/adapters/registry.ts`.

## Command resolution

1. `adapterConfig.hermesCommand`
2. `adapterConfig.command` (older alias)
3. `AGENTDASH_HERMES_COMMAND` in the server environment
4. `hermes`

The default, by bare name, is pinned at server start to the absolute path found on the server's `PATH`, so a run cannot pick up a different `hermes` from its own `PATH`. Source: `server/src/services/adapter-command-resolution.ts`.

## What each run receives

AgentDash builds the Hermes prompt from, in order (`hermesLocalAdapter.execute`):

1. the agent's [mandate](/concepts/mandates-directives-and-the-agent-bundle), the `AGENTS.md` entry file of its instructions bundle
2. the steward's directives, on workspaces where stewardship is switched on
3. workforce notes, when the agent has them
4. a rule for how to ask a human a question
5. the task template, led by AgentDash's API rules

The run's environment gets `PAPERCLIP_API_KEY` (a local agent JWT, unless `env` already sets one) and `PAPERCLIP_RUN_ID`. The model and provider the heartbeat resolved for the run (agent config, model profile, issue override) are passed through to Hermes.

All of this needs an agent JWT secret on the server (`PAPERCLIP_AGENT_JWT_SECRET`, or `BETTER_AUTH_SECRET` as a fallback; `server/src/agent-auth-jwt.ts`). Without it the heartbeat mints no token, and the run gets only the task prompt and any workforce notes: no mandate, no directives, no API key.

## Sessions

With `persistSession` on, the adapter stores the Hermes session id and passes `--resume <id>` on the next wake.

## Managed per-agent profiles

AgentDash can give each agent its own Hermes profile, with its own model config, MCP servers, skills and state.

- On when `AGENTDASH_HERMES_MANAGED_PROFILES=true`, and always on for a hosted deployment (`AGENTDASH_DEPLOYMENT_KIND=hosted`).
- The profile is named `agentdash-<agentId>` (non-alphanumerics stripped). It is provisioned when a hire is approved, and on first run or environment test if it is missing.
- Runs invoke the profile's alias wrapper (`hermes -p <profile>`). Any other `-p`/`--profile` in the agent's config is removed, with a log line, so one agent cannot borrow another profile's credentials.
- On a hosted deployment, a profile that cannot be provisioned fails the run (`hermes_profile_provision_failed`). Elsewhere the run falls back to the default command.

Source: `server/src/services/hermes-profile.ts`.

## Liveness and the first-output deadline

Hermes runs with `-Q` and prints nothing until it exits. AgentDash therefore judges a running Hermes run by its process and by Hermes's usage ledger (`state.db` in the profile), not by output silence. A run whose process is alive and whose ledger moved in the last hour does not get a stale-run review. Source: `server/src/services/run-liveness-probe.ts`.

A run whose process is up but whose ledger has no usage row 10 minutes after start is treated as a zero-turn hang:

| Setting | Where | Values |
|---|---|---|
| `AGENTDASH_FIRST_OUTPUT_DEADLINE_MODE` | server env | `shadow` (default), `enforce`, `off` |
| `firstOutputDeadlineMode` | agent `adapterConfig` | same values; wins over the env |
| `AGENTDASH_FIRST_OUTPUT_DEADLINE_MS` | server env | deadline in ms; `0` disables |
| `firstOutputDeadlineSec` | agent `adapterConfig` | deadline in seconds; `0` disables; wins over the env |

- `shadow` stops nothing. It records a `would_stop_no_first_output` run event and a run-log line.
- `enforce` stops the run with `no_first_output`, but only when the ledger location is certain and the evidence ties the session to this run's process. Anything less is reported as in `shadow`.

The ledger location is certain when it comes from `AGENTDASH_HERMES_STATE_DB`, `HERMES_HOME` (agent `env` or server env), `-p`/`--profile` in `extraArgs`, or a wrapper script that runs `hermes -p <profile>` or sets `HERMES_HOME`. Hermes's sticky `active_profile` and the root `~/.hermes/state.db` are never enough to stop a run. Source: `server/src/adapters/hermes-usage.ts`.

Review a week of shadow events before you turn on `enforce`.

## Skills

The skills view lists the AgentDash-managed skills for the agent and the skills already in `~/.hermes/skills/`. Hermes loads all of its own skills; AgentDash shows them read-only.

## Environment test

The **Test** button in the Adapter section of the agent's configuration form runs the package's checks against the resolved command (the agent's profile wrapper when managed profiles are on). Two AgentDash changes:

- If the package warns that no API keys are set but `hermes status` reports a configured provider or login, the warning becomes info.
- With `AGENTDASH_HERMES_ROUNDTRIP_PROBE=true`, the test also runs a real round trip through Hermes. It is off by default because it spawns a real process.

## Chief of Staff chat

When `AGENTDASH_DEFAULT_ADAPTER=hermes_local`, Chief of Staff chat replies go through `hermes chat -q`. When it is unset, chat dispatch falls back to `minimax`. Source: `server/src/services/dispatch-llm.ts`.

## Troubleshooting

**`hermes` not found.** Check `which hermes` as the user that runs the server. If it is installed elsewhere, set `AGENTDASH_HERMES_COMMAND` to the full path and restart the server.

**"No API keys" warning.** Expected when Hermes owns the credentials. Confirm with:

```sh
hermes status
hermes chat -q "Say hello" -Q
```

**An env value has no effect.** If it was a secret reference, the run log says it was dropped. See "Secrets in `env`" above.
