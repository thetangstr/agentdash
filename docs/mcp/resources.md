---
title: "Resources"
summary: "The agentdash:// resources and resource templates the MCP server lists, and to whom."
---

> Generated at commit `c69c37f49` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

Measured: `resources/list` and `resources/templates/list` against a server started in each connection shape. "Listed on" names the toolsets whose listing includes the resource. The read handler is in `packages/mcp-server/src/index.ts`; the descriptions and the derivation templates are in `src/resources.ts`. On the assistant and human toolsets a read of anything other than `agentdash://playbook` fails (`src/index.ts`).

## Resources

### `agentdash://playbook`

The goal-oriented operating contract: the setup-status loop, the approval boundaries, and what to do when blocked. Read this before operating.

Name: Operating Playbook. MIME type: `text/markdown`.

Listed on: [setup](/mcp/tools/setup), [agent](/mcp/tools/agent), [assistant](/mcp/tools/assistant), [human](/mcp/tools/human), [bridge](/mcp/tools/bridge).

### `agentdash://dashboard`

The AgentDash dashboard URL for this workspace

Name: Dashboard URL. MIME type: `text/plain`.

Listed on: [setup](/mcp/tools/setup), [agent](/mcp/tools/agent), [bridge](/mcp/tools/bridge).

### `agentdash://agents`

Current list of agents and their statuses

Name: Agent Roster. MIME type: `application/json`.

Listed on: [setup](/mcp/tools/setup), [agent](/mcp/tools/agent), [bridge](/mcp/tools/bridge).

### `agentdash://tasks`

Current tasks and their statuses

Name: Task Board. MIME type: `application/json`.

Listed on: [setup](/mcp/tools/setup), [agent](/mcp/tools/agent), [bridge](/mcp/tools/bridge).

## Resource templates

### `agentdash://facts/{key}`

Where one figure comes from: its current value, the exact call that produced it, its derivation in words, every correction recorded against it, how old it is, and who last confirmed it. Read-only shared context — nothing verifies that this was read and nothing here is enforced. `{key}` is the fact key; prefix it with `deliverable/` when the same fact key exists on more than one deliverable.

Name: Fact derivation record. MIME type: `application/json`.

Listed on: [setup](/mcp/tools/setup), [agent](/mcp/tools/agent), [bridge](/mcp/tools/bridge).

### `agentdash://deliverables/{key}/latest`

The most recent approved and shipped cycle of a deliverable, with provenance and age on every figure and both approvals named. Read-only shared context — nothing verifies that this was read, and it is not policy.

Name: Last shipped deliverable. MIME type: `application/json`.

Listed on: [setup](/mcp/tools/setup), [agent](/mcp/tools/agent), [bridge](/mcp/tools/bridge).
