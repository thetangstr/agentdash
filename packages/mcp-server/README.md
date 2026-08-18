# @agentdash/mcp-server

The AgentDash MCP server: plug an AI coding agent (Claude Code, Claude Desktop, Cursor, Codex) into an AgentDash workspace over the Model Context Protocol.

It powers the full launch journey — an agent on a fresh machine installs AgentDash, runs the deep-interview onboarding to capture your intent, provisions the company + agent team, and keeps operating **goal-oriented and self-driving**, while risky actions stay gated behind **human approval in the AgentDash UI**.

## Two toolsets, one server

| Toolset | Prefix | What it covers |
|---|---|---|
| Journey | `agentdash_*` | Install checklist → onboarding interview → plan review → provisioning → self-driving operation with approval gates. Anchored by `agentdash_setup_status`, which always returns the single deterministic `nextAction`. |
| Control plane | `paperclip*` | The full zod-validated API surface: issues, comments, documents, agents, projects, goals, workspace runtime services, and the complete approvals flow (list / create / get / decide / comment / link). |

The server also exposes MCP resources, most importantly **`agentdash://playbook`** — the operating contract the calling agent follows (operating loop, boundaries, approval discipline). The same text is served as the MCP `instructions` string, so compliant clients pick it up automatically.

## Setup — Claude Code

```sh
claude mcp add agentdash \
  --env PAPERCLIP_API_URL=http://localhost:3100 \
  --env PAPERCLIP_API_KEY=<your-board-or-agent-key> \
  -- node <path-to-repo>/packages/mcp-server/dist/stdio.js
```

Dev variant (no build step, runs TypeScript directly):

```sh
claude mcp add agentdash \
  --env PAPERCLIP_API_URL=http://localhost:3100 \
  --env PAPERCLIP_API_KEY=<your-key> \
  -- npx tsx <path-to-repo>/packages/mcp-server/src/stdio.ts
```

## Setup — Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentdash": {
      "command": "node",
      "args": ["<path-to-repo>/packages/mcp-server/dist/stdio.js"],
      "env": {
        "PAPERCLIP_API_URL": "http://localhost:3100",
        "PAPERCLIP_API_KEY": "<your-key>"
      }
    }
  }
}
```

## Kickoff prompt

Point the agent at the playbook and let the state machine drive:

> Read the `agentdash://playbook` resource and follow it. Call `agentdash_setup_status`, do the `nextAction` it returns, verify, and repeat — from install (if needed) through the onboarding interview to a provisioned, operating agent team. Anything the playbook marks as gated goes through `agentdash_request_approval` first; never proceed until `agentdash_check_approval` returns approved.

## The approval flow

1. The agent hits a gated action (hiring beyond the confirmed plan, deletions, budget changes, pausing/resuming the fleet, anything outside the confirmed goals).
2. It calls `agentdash_request_approval` → creates a `request_board_approval` and returns an `approveUrl`.
3. **A human decides at `/approvals` in the AgentDash UI** (approve / reject / request revision, with comments).
4. The agent polls `agentdash_check_approval` and proceeds **only** on `status: "approved"`. On rejection or revision requests it reads the comments (`list_approval_comments`) and revises or drops the action. Blocked for more than 2 polls → it creates a task for the human instead.

`agentdash_start_interview` additionally sets `requireBoardApprovalForNewAgents=true` on the freshly bootstrapped company, so agent hires are gated server-side from day one (if the PATCH is not permitted for your key, the tool returns the required manual step instead of silently skipping it).

## Environment variables

| Variable | Alias | Required | Purpose |
|---|---|---|---|
| `PAPERCLIP_API_URL` | `AGENTDASH_API_URL` | yes | AgentDash server URL, e.g. `http://localhost:3100` (`/api` is appended automatically) |
| `PAPERCLIP_API_KEY` | `AGENTDASH_API_KEY` | yes | Bearer key (board key for onboarding; agent key for operating) |
| `PAPERCLIP_COMPANY_ID` | `AGENTDASH_COMPANY_ID` | no | Default company; when unset, tools take a `companyId` input and `agentdash_setup_status` discovers the first listed company |
| `PAPERCLIP_AGENT_ID` | — | no | Default agent id; stamped as `requestedByAgentId` on approval requests |
| `PAPERCLIP_RUN_ID` | — | no | Run id attached to mutating requests (`X-Paperclip-Run-Id`) |

Aliases follow first-non-empty-wins with the `PAPERCLIP_*` name checked first.

## Development

```sh
pnpm --filter @agentdash/mcp-server build   # tsc → dist/
npx vitest run                              # unit tests (mocked fetch, no server needed)
npx tsc --noEmit                            # typecheck
```

Key modules: `src/index.ts` (composition + resources), `src/journey.ts` (journey tools + `computeNextAction` state machine), `src/tools.ts` (control-plane tools), `src/playbook.ts` (operating contract), `src/schema.ts` (zod → JSON Schema), `src/client.ts` / `src/config.ts` (API client + env config), `src/stdio.ts` (entry point).
