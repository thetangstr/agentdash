---
title: Managing Agents
summary: Create, configure, test, pause, resume and terminate agents
---

You control every agent's lifecycle. For what an agent is, see [Agents, roles and autonomy](/concepts/agents-roles-and-autonomy); for stewarded and autonomous agents, see [Agent kinds and stewardship](/guides/board-operator/agent-kinds-and-stewardship).

Source: `ui/src/pages/NewAgent.tsx`, `ui/src/components/AgentConfigForm.tsx`, `server/src/routes/agents.ts`, `server/src/services/agents.ts`, `AGENT_STATUSES` in `packages/shared/src/constants.ts`.

## Agent status

| Status | Meaning |
| --- | --- |
| `active` | Ready to be woken |
| `idle` | No run in progress |
| `running` | A run is in progress |
| `error` | The last run failed |
| `paused` | Paused by a person or by a budget hard stop |
| `pending_approval` | Hired, waiting for a `hire_agent` approval. Cannot be activated directly |
| `terminated` | Permanently deactivated. Cannot be resumed |

## Create an agent

**Agents → New agent**:

- **Agent name** — also how others @-mention it
- **Title** and **Role** (`general`, `engineer`, `researcher`, `designer`, `pm`, `qa`, `devops`, `security`, `cto`, `cmo`, `cfo`, `ceo`, `chief_of_staff`). On this page the first agent in an empty company is always `ceo`; the [setup wizard](/guides/board-operator/creating-a-company) creates a Chief of Staff instead.
- **Reports to** — its manager. See [Org structure](/guides/board-operator/org-structure).
- **Adapter** and its config — how the agent runs (working directory, model, instructions, environment). See [Adapters](/adapters/overview).

Press **Test Agent** to check the adapter can run before you save.

Common adapters: `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `hermes_local` for local runtimes; `http` and `openclaw_gateway` for agents that run elsewhere; `process` for a plain local command. For `opencode_local`, set `adapterConfig.model` as `provider/model`; AgentDash checks it against `opencode models`.

The page hires through `POST /api/companies/{companyId}/agent-hires`. When **Require your approval for new hires** is on (**Company Settings → Hiring**), the new agent waits in `pending_approval` until a `hire_agent` approval is decided, and the direct-create route (`POST /api/companies/{companyId}/agents`) answers `409`.

## Agents asking to hire

An agent can ask to hire another. With the setting above on, you get a `hire_agent` approval showing the proposed config. Approve or reject it from **Decisions**. See [Approvals](/guides/board-operator/approvals).

## Configure an agent

On the agent's page:

- **Configuration** — adapter config, **Reports to**, capabilities, and **Test**. Run settings: **Run on a schedule** (interval), and under **Advanced Run Policy**: **Wake on demand**, **Cooldown (sec)**, **Max concurrent runs**.
- **Instructions** — the agent's instruction bundle, starting with `AGENTS.md`.
- **Budget** — its spend limit. See [Costs and budgets](/guides/board-operator/costs-and-budgets).

**Wake on demand** also controls whether an assignment wakes the agent.

## Pause and resume

Pausing stops new runs and cancels any run in progress. Board only.

```
POST /api/agents/{agentId}/pause
POST /api/agents/{agentId}/resume
```

A budget hard stop pauses an agent too. See [Agents](/api/agents).

## Terminate

**Terminate** on the agent's page, or:

```
POST /api/agents/{agentId}/terminate
```

Board only, and permanent: a terminated agent cannot be resumed. Pause first if you are unsure. Do not delete an agent whose history you need — its runs and activity are the audit trail.
