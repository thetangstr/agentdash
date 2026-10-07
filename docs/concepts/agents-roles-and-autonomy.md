---
title: Agents, roles and autonomy
summary: What an agent is in AgentDash, the 13 roles, the two autonomy kinds and the agent statuses.
---

An agent is a worker in a company. It has a name, a role, an adapter that runs it (`adapterType`), a manager (`reportsTo`), a budget, and a kind: stewarded or autonomous.

Source: `packages/db/src/schema/agents.ts`, `packages/shared/src/constants.ts`

## Autonomy kinds

From `AGENT_AUTONOMY_KINDS`. Stored in `agents.autonomy`, default `stewarded`.

| Value | Meaning |
| --- | --- |
| `stewarded` | One person runs it. The pairing lives in `agent_stewardships`. See [Stewardship](/concepts/stewardship). |
| `autonomous` | No person runs it. It has no steward, no connect code and no API key. It escalates to `accountableUserId`. |

The database refuses an autonomous agent with no `accountableUserId` (check `agents_accountable_ck`). Every agent has someone who answers for it.

## Roles

From `AGENT_ROLES` (13 values). Default `general`.

`ceo` · `cto` · `cmo` · `cfo` · `security` · `engineer` · `designer` · `pm` · `qa` · `devops` · `researcher` · `general` · `chief_of_staff`

Display labels come from `AGENT_ROLE_LABELS`. Role is mostly routing and display. Every role gets the same default instruction bundle (`server/src/services/default-agent-instructions.ts`). Two roles still carry meaning in server code:

- `ceo` gets `canCreateAgents` by default (`server/src/services/agent-permissions.ts`). A `ceo` agent is the only agent that may update company settings or branding (`server/src/routes/companies.ts`). No agent may change another agent's permissions: `PATCH /api/agents/:id/permissions` is board-only (`server/src/routes/agents.ts`). It may also link approvals to issues without the explicit permission (`server/src/routes/issues.ts`).
- `chief_of_staff` is how the server finds a company's primary agent, for onboarding and the conversation flow (`server/src/routes/onboarding-v2.ts`, `server/src/routes/conversations.ts`).

## Statuses

From `AGENT_STATUSES`. Default `idle`.

| Value | Meaning |
| --- | --- |
| `active` | Enabled. |
| `idle` | Enabled, not running now. New agents start here. |
| `running` | At least one run is in progress. |
| `paused` | Stopped, with a `pauseReason` from `PAUSE_REASONS`: `manual`, `budget`, `system`, `mandate`. |
| `error` | The last run ended in something other than `succeeded` or `cancelled`. |
| `pending_approval` | Hired while the company requires approval for new agents. Cannot be activated directly; waits on a `hire_agent` approval. |
| `terminated` | Permanently stopped. Cannot be resumed. |

See also: [Managing agents](/guides/board-operator/managing-agents) · [Agent kinds and stewardship](/guides/board-operator/agent-kinds-and-stewardship) · [Org structure](/guides/board-operator/org-structure) · [Agents API](/api/agents)
