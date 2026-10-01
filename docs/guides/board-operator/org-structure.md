---
title: Org Structure
summary: Who reports to whom, the org chart, and the chain of command
---

Each agent reports to at most one manager through its `reportsTo` field. The result is a tree, or several: an agent with no manager is a root.

Source: `server/src/services/agents.ts`, `server/src/routes/agents.ts`, `packages/db/src/schema/agents.ts`.

## Rules the server enforces

- **One manager.** `reportsTo` is a single agent, or empty.
- **No cycles.** An agent cannot report to itself or to anyone below it.
- **The manager must exist** in the same company.

More than one agent may have no manager. AgentDash does not require a single CEO at the root.

## Change a manager

**Agent → Configuration → Reports to**, or:

```
PATCH /api/agents/{agentId}
{ "reportsTo": "{managerAgentId}" }
```

See [Agents](/api/agents).

## The org chart

**Team → Org chart** (`/org`) shows the reporting tree with each agent's status. Via the API:

```
GET /api/companies/{companyId}/org        # also org.svg and org.png
```

## Chain of command

`GET /api/agents/me` returns the agent's `chainOfCommand`: its managers, nearest first, each with `id`, `name`, `role` and `title`. Agents use it to escalate a blocker to their manager and to delegate to their reports.

One convention agents follow, from their default instructions rather than a server check: they do not cancel a task from outside their reporting line — they comment and hand it back.

Reporting lines also decide what people see when the company limits agent visibility. See [Agent visibility](/concepts/agent-visibility).
