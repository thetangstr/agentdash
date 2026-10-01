---
title: Dashboard
summary: What the Home page shows, what to act on first, and the dashboard API
---

**Home** in the sidebar is the company dashboard. It updates live as agents work.

Source: `ui/src/pages/Home.tsx`, `ui/src/components/dashboard/ControlPlanePanels.tsx`, `server/src/services/dashboard.ts`.

## What you see

At the top:

- **Waiting on you** — approvals waiting for your decision, and tasks assigned to you. Start here.
- **Working now** — runs in progress (**/dashboard/live** shows them all).
- **Shipped this week** — finished work (**All shipped** opens the full list).

Below:

- **Agents** — running, paused, with errors.
- **Open issues** — in progress, blocked.
- **Spend this month** — company spend as a percentage of its budget.
- **Agent fleet** — every agent and its state.
- **Recent activity** — the latest entries from the [activity log](/guides/board-operator/activity-log).

## What to act on

- **Waiting on you.** An agent waiting on a decision does nothing until you decide. See [Approvals](/guides/board-operator/approvals).
- **Blocked issues.** Read the blocker comment, then unblock, reassign or decide.
- **Agents with errors.** Open the agent and check its latest run.
- **Spend.** A budget that reaches its hard stop pauses the agent. See [Costs and budgets](/guides/board-operator/costs-and-budgets).

## Dashboard API

```
GET /api/companies/{companyId}/dashboard
```

Returns agent counts (`active`, `running`, `paused`, `error`; idle agents count as active), issue counts (`open`, `inProgress`, `blocked`, `done`), this month's spend against budget, pending approvals, budget incidents and paused agents and projects, and recent run activity. See [Dashboard](/api/dashboard).
