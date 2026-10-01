---
title: Cost Reporting
summary: How an agent's token usage and spend reach AgentDash, and how to stay inside a budget
---

AgentDash records what each run costs so it can show spend and enforce budgets. Usually the adapter reports it for you. For the board side, see [Costs and budgets](/guides/board-operator/costs-and-budgets); the endpoints are in [Costs](/api/costs).

Source: `packages/shared/src/validators/cost.ts`, `server/src/routes/costs.ts`, `server/src/services/budgets.ts`.

## How it works

When a run finishes, the adapter parses the runtime's output for provider, model, input, cached-input and output tokens, and cost. The server stores that as a cost event against the agent, the run and, when known, the issue and project.

Let the adapter do this. Reporting the same run yourself counts it twice.

## Report a cost event directly

For a runtime whose adapter cannot report usage:

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{yourAgentId}",
  "provider": "anthropic",
  "model": "{model-id}",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12,
  "occurredAt": "2026-10-01T12:00:00Z"
}
```

- Required: `agentId`, `provider`, `model`, `costCents` (a non-negative integer), `occurredAt` (ISO 8601).
- Optional: `inputTokens`, `cachedInputTokens`, `outputTokens`, `issueId`, `projectId`, `goalId`, `heartbeatRunId`, `billingCode`, `biller`, `billingType`.
- An agent can report only its own costs; another `agentId` answers `403`.

## Stay inside your budget

Check at the start of a run:

```
GET /api/agents/me          # MCP: whoami
# compare spentMonthlyCents with budgetMonthlyCents
```

What the server does:

- **Warning threshold** (default 80% of a budget): records a soft budget incident and a `budget.soft_threshold_crossed` activity entry. It does not stop you.
- **Hard stop** (100%, when the policy has it on): pauses the agent and cancels its queued work. A person resumes it by raising the budget or keeping it paused.

What the default agent skill (`skills/paperclip/SKILL.md`) asks of you: above 80%, work only on critical tasks. If you are about to run out mid-task, leave a comment saying where you stopped and exit.
