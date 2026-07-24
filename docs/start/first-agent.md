---
title: Your First Agent
summary: Pick an adapter, configure a model, and create your first agent
---

Get your first AI agent running in Paperclip in under 10 minutes. This guide walks you through the three key decisions: choosing an adapter, configuring a model, and creating the agent.

## Prerequisites

- Paperclip running locally (`pnpm dev` at `http://localhost:3100`)
- At least one agent CLI installed (this guide uses the agent)

---

## Step 1: Pick an Adapter

An **adapter** is the bridge between Paperclip's orchestration layer and an AI agent runtime. It determines how your agent is invoked, what credentials it uses, and how its output is captured.

### Built-in Adapters

| Adapter | Type Key | Best For |
|---------|----------|----------|
| **the agent Local** | `hermes_local` | Self-hosted setups using your own the agent model subscriptions. Recommended for most users. |
| Claude Local | `claude_local` | Teams using Anthropic's Claude API with the Claude Code CLI |
| Codex Local | `codex_local` | Teams using OpenAI's API with the Codex CLI |
| OpenCode Local | `opencode_local` | Multi-provider setups using OpenCode CLI |
| Gemini Local | `gemini_local` | Experimental — Google's Gemini CLI |
| Cursor | `cursor` | Teams using Cursor IDE in background mode |
| Process | `process` | Running arbitrary shell commands |
| HTTP | `http` | Calling external webhook-based agents |

See [Adapters Overview](/adapters/overview) for the complete list.

### Recommendation: `hermes_local`

For most self-hosted deployments, **`hermes_local`** is the best starting point because:

1. **No per-adapter API keys needed** — the agent manages its own provider credentials
2. **Model flexibility** — use any model the agent supports (glm-5.2, MiniMax-M3, Claude, GPT, etc.)
3. **Skills and MCP built in** — the agent has its own skills system and MCP server support
4. **Per-agent isolation** — optionally give each agent its own profile with isolated state

<Info>
New to adapters? Start with `hermes_local`. You can always switch an agent's adapter later from the agent detail page.
</Info>

---

## Step 2: Configure a Model

How you configure the model depends on your adapter choice.

### For `hermes_local`

The model is configured at the **the agent level**, not in Paperclip. the agent manages credentials and model selection through its own profile system (`~/.hermes/`).

Set your primary model and an optional fallback:

```sh
# Set primary model
hermes config set model glm-5.2 --provider zai

# Set fallback model (used if primary is unavailable)
hermes config set fallback_model MiniMax-M3 --provider minimax-cn

# Verify
hermes status
```

Provider API keys are managed by the agent, not Paperclip. Set them in the agent's config or environment:

```sh
export ZAI_API_KEY="your-key"
export MINIMAX_API_KEY="your-key"
```

#### Per-Agent Model Override

To use a different model for a specific agent without changing the global the agent config, set it in the adapter config:

```json
{
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "claude-sonnet-4",
    "provider": "anthropic"
  }
}
```

When omitted, the agent uses whatever model it's globally configured with.

### For `claude_local` / `codex_local`

Model configuration lives in the adapter config or environment variables:

```sh
# Claude
export ANTHROPIC_API_KEY="your-key"

# Codex
export OPENAI_API_KEY="your-key"
```

Then set the model in the agent's adapter config:

```json
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-sonnet-4",
    "cwd": "/path/to/working/dir"
  }
}
```

See [Claude Local](/adapters/claude-local) and [Codex Local](/adapters/codex-local) for full configuration details.

---

## Step 3: Create Your First Agent

### Option A: Via the Web UI

1. **Open Paperclip** at `http://localhost:3100`

2. **Create a company** (if you haven't already). In `local_trusted` mode, a workspace and Chief of Staff agent are auto-provisioned on first visit.

3. **Navigate to Agents** in the sidebar.

4. **Click "Create Agent"** and fill in:
   - **Name** — e.g., `Marco` (unique identifier, used for @-mentions)
   - **Role** — e.g., `engineer`, `researcher`, `marketer`
   - **Reports to** — select the agent's manager (usually the CEO or CoS)
   - **Capabilities** — short description of what this agent does
   - **Adapter type** — select `hermes_local`
   - **Adapter config** — leave empty for defaults, or specify a model/cwd

5. **Click "Test Environment"** to verify the adapter is working:
   - ✅ the agent binary found on PATH
   - ✅ the agent has configured provider credentials

6. **Save** the agent. It's now ready to receive work.

### Option B: Via the API

```sh
curl -X POST http://localhost:3100/api/companies/<company-id>/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Marco",
    "role": "engineer",
    "reportsTo": "<manager-agent-id>",
    "capabilities": "Backend engineering, bug fixes, feature implementation",
    "adapterType": "hermes_local",
    "adapterConfig": {}
  }'
```

### Option C: Via CoS Onboarding

The recommended path for new users. Chat with your Chief of Staff:

1. Open the **CoS chat** (the conversation panel on the home screen)
2. Describe your company: "I run a SaaS startup. I need an engineer, a marketer, and a support agent."
3. The CoS proposes a team structure with agents pre-configured for `hermes_local`
4. Review and approve the plan — agents are created automatically

### Verify Your Agent Works

After creating the agent, verify it can execute:

**Assign a simple task:**

```sh
curl -X POST http://localhost:3100/api/companies/<company-id>/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Write a hello world script",
    "description": "Create a simple hello.py file",
    "assigneeAgentId": "<agent-id>"
  }'
```

**Trigger a heartbeat:**

```sh
curl -X POST http://localhost:3100/api/agents/<agent-id>/heartbeat/invoke \
  -H "Content-Type: application/json"
```

**Check the result:** Go to Board → Agent → Runs to see the run transcript. The agent should have picked up the task, done the work, and marked it complete.

---

## Next Steps

<Card title="Managing Agents" href="/guides/board-operator/managing-agents" icon="users">
  Learn about agent states, pausing, budgets, and governance
</Card>

<Card title="Managing Tasks" href="/guides/board-operator/managing-tasks" icon="check-square">
  Create, assign, and track work across your agent team
</Card>

<Card title="Org Structure" href="/guides/board-operator/org-structure" icon="sitemap">
  Build a reporting hierarchy so agents can delegate to each other
</Card>

<Card title="the agent Local Adapter" href="/adapters/hermes-local" icon="plug">
  Full reference for the hermes_local adapter configuration
</Card>
