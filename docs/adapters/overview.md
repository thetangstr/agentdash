---
title: Adapters overview
summary: What an adapter is, the 11 built-in adapter types, and how to add your own
---

An adapter is how AgentDash runs an agent. Each agent has an `adapterType` and an `adapterConfig`. When a heartbeat fires, the server looks up the adapter for that type and calls its `execute()` with the run context. The adapter starts the agent runtime (a local CLI, a script, a remote endpoint), streams its output into the run log, and returns a structured result: exit code, usage and cost where the runtime reports them, and session state to resume next time. See [Heartbeats and runs](/concepts/heartbeats-and-runs) for the run lifecycle.

Source: `server/src/adapters/registry.ts`, `packages/adapter-utils/src/types.ts` (`ServerAdapterModule`).

## Built-in adapter types

These 11 types ship with AgentDash (`server/src/adapters/builtin-adapter-types.ts`). Packages live in `packages/adapters/*`, except `hermes_local` (the npm package `hermes-paperclip-adapter`, wrapped in `server/src/adapters/registry.ts`) and `process` / `http` (in `server/src/adapters/`).

| Type key | What it runs |
|---|---|
| `claude_local` | Claude Code CLI on the server host. See [Claude Local](/adapters/claude-local). |
| `codex_local` | OpenAI Codex CLI (`codex exec`) on the server host. See [Codex Local](/adapters/codex-local). |
| `hermes_local` | Hermes Agent CLI on the server host. See [Hermes Local](/adapters/hermes-local). |
| `gemini_local` | Gemini CLI on the server host. See [Gemini Local](/adapters/gemini-local). |
| `opencode_local` | OpenCode CLI on the server host, with `provider/model` routing. |
| `cursor` | Cursor Agent CLI on the server host. |
| `pi_local` | Pi coding agent CLI on the server host. |
| `acpx_local` | An Agent Client Protocol server through ACPX: Claude, Codex, or a custom ACP command. Marked experimental in the UI; needs Node 22.12 or later. |
| `openclaw_gateway` | Calls an OpenClaw gateway over its WebSocket protocol. |
| `process` | Runs a shell command you configure. See [Process](/adapters/process). |
| `http` | Sends one HTTP request to a service you run. See [HTTP](/adapters/http). |

The web UI's agent picker does not offer `openclaw_gateway`, `process` or `http`. They are marked "coming soon" in `ui/src/adapters/adapter-display-registry.ts`. You can still set them through the [agents API](/api/agents).

The `*_local` adapters run the CLI on the machine that runs the AgentDash server. That CLI must be installed and signed in there.

## External adapters

An external adapter is an npm package (or a local directory) that exports `createServerAdapter()`. An instance admin installs it from **Instance settings → Adapters**, or with `POST /api/adapters/install`. The server records it in `~/.paperclip/adapter-plugins.json` and loads it at every start. See [External adapters](/adapters/external-adapters).

## What an adapter package contains

```
my-adapter/
  src/
    index.ts            # type, label, models, agentConfigurationDoc
    server/
      index.ts          # createServerAdapter()
      execute.ts        # runs the agent
      test.ts           # environment checks
    ui-parser.ts        # optional: turns stdout into transcript entries (external adapters)
    cli/
      format-event.ts   # optional: terminal output for `paperclipai heartbeat run` (built-in adapters)
```

| Consumer | What it uses | Source |
|---|---|---|
| Server | `execute`, `testEnvironment`, optional session codec, skills and model hooks | `server/src/adapters/registry.ts` |
| Web UI | Transcript parser and config form. Built-ins are imported statically; external adapters ship `ui-parser.js` and an optional config schema. | `ui/src/adapters/registry.ts` |
| CLI | A stdout formatter for `paperclipai heartbeat run` | `cli/src/adapters/registry.ts` |

## Choosing an adapter

- **A coding agent on the server host:** `claude_local`, `codex_local`, `hermes_local`, `gemini_local`, `opencode_local`, `cursor` or `pi_local`. Pick the one whose CLI and credentials are already on that machine.
- **A script you wrote:** `process`.
- **A service that runs somewhere else:** `http`.
- **Anything else:** [build an adapter](/adapters/creating-an-adapter) and install it as an [external adapter](/adapters/external-adapters).

To connect Claude Code or Codex running on your own laptop, rather than on the server, use [agentdash-connect](/cli/agentdash-connect). It is not an adapter type.

## Related

- [UI parser contract](/adapters/adapter-ui-parser): how an external adapter tells the web UI to render its output
- [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy)
