---
title: Dashboard
summary: One call for a company's state — agents, issues, this month's spend, pending decisions and recent run health.
---

The dashboard summary is the company at a glance: how many agents are working, how much work is open, what this month has cost, and what is waiting on a person. It is one read, computed when you ask for it, and the web app's home page is built from it.

**Source:** `server/src/routes/dashboard.ts` · **In the reference:** [Dashboard](/api/reference#tag/dashboard)

## Who may call it

| Operation | Who |
| --- | --- |
| `getDashboard` | a member of the company, or an agent in it |

The call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, and an agent from another company answers 403 `Agent key cannot access another company`.

The agent and issue counts follow visibility (`server/src/routes/visibility.ts`): they cover only the agents and issues you can see, so two members can get different numbers. Every other figure is company-wide. See [Conventions](/api/conventions).

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## Get the dashboard

`GET /api/companies/{companyId}/dashboard` · [`getDashboard`](/api/reference#tag/dashboard/getDashboard)

```bash
curl https://your-instance.example/api/companies/$COMPANY_ID/dashboard \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — a `DashboardSummary` (below).

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Company not found`. |

## The `DashboardSummary` object

From `packages/shared/src/types/dashboard.ts`; computed in `server/src/services/dashboard.ts`, which is where the windows below are set. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `companyId` | UUID | |
| `agents` | object | Counts by status: `active`, `running`, `paused`, `error`. An `idle` agent counts as `active`. An agent in any other status adds a key of that name, such as `terminated`. |
| `tasks` | object | Issue counts: `open` (every status except `done` and `cancelled`), `inProgress`, `blocked`, `done`. |
| `costs` | object or null | `null` for a member who cannot read the cost routes (no `agents:create` permission); the field is withheld rather than reported as zero. Otherwise the object below. |
| `costs.monthSpendCents` | number | Spend since the start of the current UTC month. |
| `costs.monthBudgetCents` | integer | The company's `budgetMonthlyCents`. |
| `costs.monthUtilizationPercent` | number | Spend over budget × 100, two decimals; 0 when there is no budget. |
| `pendingApprovals` | integer | Approvals in the company with status `pending`. |
| `budgets` | object | `activeIncidents`, `pendingApprovals`, `pausedAgents`, `pausedProjects` — from the company's budget policies. |
| `runActivity` | array | One entry per UTC day for the last 14 days: `date` (`YYYY-MM-DD`), `succeeded`, `failed` (failed or timed out), `other`, `total`. |
| `harness` | object | Run health over the last 24 hours, overall and per adapter type: `overallStatus` (`ok` · `warn` · `critical`), `totalRuns`, `failedRuns`, `failureRatePercent`, and `adapters[]`. A status is `warn` when any run failed and `critical` when at least 3 failed and the failure rate is at least 50%. |
| `taskQuality` | object | Review outcomes over the last 30 days: `issuesInScope`, `acceptanceRatePercent`, `dodCoveragePercent`, `unreviewedDoneIssues`, `spendPerAcceptedIssueCents`, and related counts. Its four spend figures (`issueLinkedSpendCents`, `issueLinkedTokens`, `issueLinkedCachedTokens`, `spendPerAcceptedIssueCents`) are `null` under the same cost-route rule as `costs`. |

The month spend here counts every cost event since the month began. For a chosen date range, or spend per agent, use [Costs](/api/costs). The complete schema is in [the reference](/api/reference#tag/dashboard/getDashboard).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (the live "working now" run list) are internal — see [the route index](/api/route-index), under `dashboard`.
