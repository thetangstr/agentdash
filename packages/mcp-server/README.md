# AgentDash MCP Server

Run the AgentDash onboarding interview and manage your AI company from any MCP-compatible tool (Claude Desktop, Cursor, Codex, the agent, Windsurf, etc.).

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentdash": {
      "command": "npx",
      "args": ["-y", "@agentdash/mcp-server"],
      "env": {
        "AGENTDASH_API_URL": "http://localhost:3100/api",
        "AGENTDASH_API_KEY": "your-agent-api-key"
      }
    }
  }
}
```

Restart Claude Desktop. You can now say:

> "Start onboarding my company in AgentDash. We're called MKThink and we do strategy consulting."

Claude will run the deep interview, propose an agent team, and provision it — all in conversation.

### the agent Agent

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  agentdash:
    command: "npx"
    args: ["-y", "@agentdash/mcp-server"]
    env:
      AGENTDASH_API_URL: "http://localhost:3100/api"
      AGENTDASH_API_KEY: "your-agent-api-key"
```

### Cursor / Windsurf

Add via Settings → MCP Servers with the same config.

## Tools Exposed

| Tool | Description |
|------|-------------|
| `agentdash_start_interview` | Begin the onboarding deep interview |
| `agentdash_interview_turn` | Submit an answer, get next question |
| `agentdash_get_plan` | Get the proposed agent team plan |
| `agentdash_confirm_plan` | Approve and create the agents |
| `agentdash_revise_plan` | Request changes to the plan |
| `agentdash_list_agents` | List all agents and their status |
| `agentdash_list_tasks` | List tasks, optionally filtered by status |
| `agentdash_create_task` | Create a new task and optionally assign it |
| `agentdash_get_dashboard` | Get dashboard summary (counts, spend, approvals) |
| `agentdash_pause_agent` | Pause an agent |
| `agentdash_resume_agent` | Resume a paused agent |
| `agentdash_install_local` | Get on-prem installation instructions |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTDASH_API_URL` | `http://localhost:3100/api` | AgentDash API endpoint |
| `AGENTDASH_API_KEY` | (none) | Agent API key for authentication |

## How the Onboarding Flow Works via MCP

```
User: "Set up my company in AgentDash"
  ↓
AI tool calls: agentdash_start_interview({ companyName: "MKThink" })
  ← Returns: conversationId
  ↓
AI tool calls: agentdash_interview_turn({ userMessage: "We do strategy consulting" })
  ← Returns: next question
  ↓
... 3-5 rounds of interview ...
  ↓
AI tool calls: agentdash_get_plan({ conversationId })
  ← Returns: proposed agent team
  ↓
User: "Looks great, set them up"
  ↓
AI tool calls: agentdash_confirm_plan({ conversationId })
  ← Returns: agents created, dashboard URL
  ↓
User: "Create a task to research our competitors"
  ↓
AI tool calls: agentdash_create_task({ title: "...", assigneeAgentId: "..." })
```

The entire onboarding — from "I want to try AgentDash" to a working agent team — happens in conversation. No browser, no dashboard, no terminal. Just chat.
