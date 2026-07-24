---
title: the agent Local
summary: the agent CLI local adapter setup and configuration
---

The `hermes_local` adapter runs the the agent CLI locally. It supports session persistence, skills injection, local agent JWT identity, and optional per-agent profile isolation.

This is the recommended adapter for self-hosted deployments where you want agents to use your own the agent installation and model configuration.

## Why Choose `hermes_local`?

Use `hermes_local` when you want to:

- Run agents against your own the agent installation and model subscriptions
- Let agents inherit your the agent provider config, skills, and MCP servers
- Avoid per-adapter API key setup (the agent manages its own credentials)
- Give each agent a distinct the agent profile with isolated state (optional)

If you're using a cloud-hosted model API directly (e.g. Anthropic, OpenAI), consider `claude_local` or `codex_local` instead. See [Adapters Overview](/adapters/overview) for the full list.

## Prerequisites

1. **the agent CLI installed** — the `hermes` binary must be on your `PATH`:

```sh
which hermes          # should return a path
hermes --version      # should print version info
```

2. **the agent configured with at least one provider** — the agent manages its own credentials via `~/.hermes/` profiles:

```sh
hermes status         # shows configured providers
```

If `hermes status` shows no providers, set one up before creating agents. AgentDash does not need LLM API keys in its own environment — it delegates to the agent.

3. **Paperclip / AgentDash running**:

```sh
pnpm dev
# Server starts at http://localhost:3100
```

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hermesCommand` | string | No | Path to the `hermes` binary. Defaults to `hermes` on `PATH`. Override only if installed at a non-standard location. |
| `model` | string | No | Override the model for this agent. If omitted, uses the agent's globally configured model. |
| `provider` | string | No | Override the provider for this agent. If omitted, uses the agent's globally configured provider. |
| `promptTemplate` | string | No | Custom prompt template for the agent. If omitted, a sensible default is used. |
| `env` | object | No | Environment variables passed to the the agent process. Supports secret refs. |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `instructionsFilePath` | string | No | Path to a file whose contents are prepended to the agent prompt on every run |

### Minimal config

In most cases, an empty config is all you need — the agent uses its global defaults:

```json
{
  "adapterType": "hermes_local",
  "adapterConfig": {}
}
```

### Per-agent model override

To use a different model for a specific agent:

```json
{
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "glm-5.2",
    "provider": "zai"
  }
}
```

### Custom binary path

If the agent is installed outside `PATH`:

```json
{
  "adapterType": "hermes_local",
  "adapterConfig": {
    "hermesCommand": "/opt/homebrew/bin/hermes"
  }
}
```

Alternatively, set it globally for all agents:

```sh
export AGENTDASH_HERMES_COMMAND=/path/to/hermes
```

The resolution order is:
1. `adapterConfig.hermesCommand` (per-agent)
2. `adapterConfig.command` (per-agent, legacy alias)
3. `AGENTDASH_HERMES_COMMAND` environment variable (global)
4. `hermes` on `PATH` (default)

## Session Persistence

The adapter persists the agent session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context across runs.

If a resume fails with an unknown session error, the adapter automatically retries with a fresh session.

## Local Agent JWT

The `hermes_local` adapter supports `supportsLocalAgentJwt: true`. This means Paperclip injects a signed JWT token as `PAPERCLIP_API_KEY` into the agent's environment, allowing the agent to authenticate API calls back to Paperclip without a manually-issued API key.

If you provide an explicit `PAPERCLIP_API_KEY` in `adapterConfig.env`, that takes precedence over the auto-injected JWT.

## Environment Test

Use the "Test Environment" button on the agent detail page to validate the adapter config. The test checks:

- the agent binary is installed and accessible
- the agent has configured provider credentials (via `hermes status`)
- If the agent has local provider config (`~/.hermes/` profiles), any missing-env-key warning is automatically downgraded to "info" level — the check passes
- Optionally, a live round-trip probe (see below)

### Round-Trip Probe

To catch an installed-but-broken the agent (e.g., expired auth), enable a live round-trip check:

```sh
export AGENTDASH_HERMES_ROUNDTRIP_PROBE=true
```

This spawns the agent with a simple "Respond with hello" prompt and verifies it returns a reply. Off by default because it spawns a real process.

## Optional: Per-Agent Profiles

For agent isolation, Paperclip can provision each agent into its own the agent profile:

```sh
export AGENTDASH_HERMES_MANAGED_PROFILES=true
```

When enabled:

- Each agent gets a dedicated the agent profile (`hermes -p agentdash-<agentId>`)
- Isolated model config, MCP servers, skills, and conversation state
- The profile is provisioned automatically when the agent is hired (via governance approval) or on first run
- The system writes an alias wrapper script that resolves to the correct profile

**When to use:** Production deployments where agents should not share conversation history or tool state.

**When NOT to use:** Local dev where you want all agents to share the same the agent config.

## CoS Chat Integration

When `AGENTDASH_DEFAULT_ADAPTER=hermes_local`, the Chief of Staff's chat replies are dispatched through the agent (`hermes chat -q "<prompt>" -Q`). This powers the conversational onboarding flow.

```sh
export AGENTDASH_DEFAULT_ADAPTER=hermes_local
```

Without this, CoS chat falls back to a stub or another configured adapter.

## Skills

The `hermes_local` adapter supports skills via the agent's native skills system. Paperclip syncs skills to the agent on each run:

- `listSkills` — queries available the agent skills
- `syncSkills` — ensures Paperclip-managed skills are installed in the agent

Skills are not materialized as runtime files (unlike some other adapters) — the agent handles skill discovery natively.

## Troubleshooting

### "hermes not found" / environment test fails

```sh
# Check PATH
which hermes

# If installed elsewhere, tell Paperclip:
export AGENTDASH_HERMES_COMMAND=/full/path/to/hermes
```

### Environment test warns "no API keys"

This is expected in local dev. The agent uses its own `~/.hermes/` provider config. Verify:

```sh
hermes status                    # should show at least one configured provider
hermes chat -q "Say hello" -Q    # should return a reply
```

### Agent runs succeed but produce no useful output

Check the run transcript in the UI (Board → Agent → Runs). The agent CLI output is streamed to the run log. If output is empty, the model provider may be returning errors — check the agent's own logs.

### CoS chat returns a stub reply

This means `AGENTDASH_DEFAULT_ADAPTER` is not set to `hermes_local`, or dispatch failed and fell back. Set the env var and restart the server.

## Comparison with Other Adapters

| Feature | `hermes_local` | `claude_local` | `codex_local` |
|---------|----------------|----------------|---------------|
| Credential management | the agent profiles (`~/.hermes/`) | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
| Model flexibility | Any the agent-configured model | Claude models | OpenAI models |
| Skills | the agent native skills system | Claude skills dir | Codex skills dir |
| Session persistence | Yes | Yes | Yes |
| Per-agent profiles | Yes (opt-in) | Worktree isolation | `CODEX_HOME` isolation |
| Local JWT auth | Yes | No | No |
| Instructions bundle | No | No | Yes |
