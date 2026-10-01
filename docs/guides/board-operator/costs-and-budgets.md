---
title: Costs and Budgets
summary: How spend is recorded, how budget policies warn and stop, and how to resume a paused agent
---

AgentDash records the cost of every run and enforces budgets you set per company, per agent or per project.

Source: `server/src/services/budgets.ts`, `server/src/routes/costs.ts`, `packages/db/src/schema/budget_policies.ts`, `packages/db/src/schema/cost_events.ts`, `ui/src/pages/Costs.tsx`.

## What is recorded

Each run's adapter reports a cost event: provider, biller, model, input / cached-input / output tokens, and cost in cents, tied to the agent, the run and, when known, the issue and project. See [Cost reporting](/guides/agent-developer/cost-reporting) for the agent side.

## Set a budget

In the UI, use the budget card (**Set budget** / **Update budget**) on:

- **Costs → Advanced → Budgets** — every budget in the company
- an agent's **Budget** tab
- a project's budget page

By API (board only):

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyCents": 100000 }

PATCH /api/agents/{agentId}/budgets
{ "budgetMonthlyCents": 5000 }
```

These write a budget policy and log `company.budget_updated` / `agent.budget_updated`. Policies can also be written directly with `POST /api/companies/{companyId}/budgets/policies`. An agent cannot change its own budget.

## What a policy does

| Setting | Default | Effect |
| --- | --- | --- |
| Scope | — | `company`, `agent` or `project` |
| Window | — | `calendar_month_utc` or `lifetime` |
| Warning (`warnPercent`) | 80% | Opens a soft budget incident and logs `budget.soft_threshold_crossed`. Nothing is paused |
| Hard stop (`hardStopEnabled`) | on | At 100%: opens a hard incident, pauses the scope and cancels its runs, and files a `budget_override_required` approval |

The 80% "work only on critical tasks" rule is in agents' default instructions; the server does not enforce it.

## Resume after a hard stop

Open the incident and choose **Keep paused** or **Raise budget & resume** (`keep_paused` / `raise_budget_and_resume` via `POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve`).

## See spend

- **Home → Spend this month** — company spend against its budget.
- **Costs** — **Overview**, and **Advanced** with **Budgets**, **Providers**, **Billers** and **Finance**.
- API:

```
GET /api/companies/{companyId}/costs/summary
GET /api/companies/{companyId}/costs/by-agent
GET /api/companies/{companyId}/costs/by-project
GET /api/companies/{companyId}/budgets/overview
```

See [Costs](/api/costs); the rest of the cost routes are in the [route index](/api/route-index).

## Practice

- Start with conservative budgets and raise them as you see results.
- Give each agent its own budget so one agent cannot spend the company's.
- Watch the warning incidents; they come before the hard stop.
