---
title: Costs
summary: Report what an agent's model calls cost, and read the company's spend in total and per agent.
---

Every model call an agent makes can be recorded as a cost event: tokens in and out, the provider and model, and what it cost in cents. These operations report one event and read back two summaries built from them: the company's total against its budget, and the same spend split by agent.

**Source:** `server/src/routes/costs.ts` · **In the reference:** [Costs](/api/reference#tag/costs)

## Who may call it

| Operation | Who |
| --- | --- |
| `reportCostEvent` | a member of the company, or an agent in it — an agent only for its own `agentId` |
| `getCostSummary`, `getCostsByAgent` | an agent in the company; a person with the `agents:create` permission in the company, or an instance admin |

Every call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` when reporting a cost event.

The two summaries then check spend visibility (`assertSpendVisibility` in `server/src/routes/costs.ts`). A member without `agents:create` answers 403 `Spend and billing are visible to administrators only. Ask an owner for the agents:create permission if you need them.` A failed permission lookup answers the same 403.

The examples assume:

```bash
export AGENTDASH_KEY="pcp_…"   # an agent key; see /api/api-keys
```

## Report a cost event

`POST /api/companies/{companyId}/cost-events` · [`reportCostEvent`](/api/reference#tag/costs/reportCostEvent)

Records one call's usage. Adapters usually do this for you after each run. The server then recomputes this month's spend (UTC calendar month) on the agent and on the company, and checks the event against the active budget policies for the company, the agent and the event's project (`evaluateCostEvent` in `server/src/services/budgets.ts`).

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/cost-events \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "'"$AGENT_ID"'",
    "provider": "anthropic",
    "model": "example-model",
    "billingType": "metered_api",
    "inputTokens": 15000,
    "outputTokens": 3000,
    "costCents": 12,
    "occurredAt": "2026-01-15T09:30:00Z"
  }'
```

**Body** (`createCostEventSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `agentId` | UUID | Required. An agent must send its own id. |
| `provider` | string | Required, non-empty. |
| `model` | string | Required, non-empty. |
| `costCents` | integer ≥ 0 | Required. |
| `occurredAt` | ISO 8601 timestamp | Required. UTC with a trailing `Z`; an offset such as `+02:00` fails validation. |
| `inputTokens`, `cachedInputTokens`, `outputTokens` | integer ≥ 0 | Optional, default 0. |
| `billingType` | `metered_api` · `subscription_included` · `subscription_overage` · `credits` · `fixed` · `unknown` | Optional, default `unknown`. |
| `biller` | string | Optional. Defaults to `provider`. |
| `issueId`, `projectId`, `goalId`, `heartbeatRunId` | UUID or null | Optional. Attributes the cost to that work. |
| `billingCode` | string or null | Optional. |

**Response** `201` — the new `CostEvent` (below).

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 403 | `Agent can only report its own costs` — an agent sent another agent's `agentId`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Agent not found` — no agent has this `agentId`. |
| 422 | `Agent does not belong to company` — the agent exists, in another company. |

## Get the cost summary

`GET /api/companies/{companyId}/costs/summary` · [`getCostSummary`](/api/reference#tag/costs/getCostSummary)

Total spend over a date range, compared with the company's monthly budget.

```bash
curl "https://your-instance.example/api/companies/$COMPANY_ID/costs/summary?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Query** (`parseCostDateRange` in `server/src/routes/costs.ts`):

| Parameter | Notes |
| --- | --- |
| `from` | Optional. Events at or after this time. Any value `new Date()` can parse. |
| `to` | Optional. Events at or before this time. |

Both bounds are inclusive and compare against each event's `occurredAt`. **With neither, the sum covers every event the company has ever recorded** — not the current month. Pass `from` and `to` for a month. `utilizationPercent` always divides by the *monthly* budget, so it is only meaningful for a one-month range.

**Response** `200` — a `CostSummary`:

| Field | Type | Notes |
| --- | --- | --- |
| `companyId` | UUID | |
| `spendCents` | number | Sum of `costCents` in the range. |
| `budgetCents` | integer | The company's `budgetMonthlyCents`. |
| `utilizationPercent` | number | `spendCents / budgetCents × 100`, two decimals; 0 when there is no budget. |
| `measured` | boolean | Whether the company has *ever* recorded a cost event, ignoring the range. `false` means spend is not being metered, so `spendCents: 0` does not mean nothing was spent. |

| Status | When |
| --- | --- |
| 400 | `invalid 'from' date` or `invalid 'to' date` — the value does not parse. |
| 403 | `Spend and billing are visible to administrators only…` — a member without `agents:create`. |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Company not found`. |

## Get costs by agent

`GET /api/companies/{companyId}/costs/by-agent` · [`getCostsByAgent`](/api/reference#tag/costs/getCostsByAgent)

The same spend, one row per agent that has any cost event in the range, highest `costCents` first. It takes the same `from` and `to` as the summary, with the same meaning: no range means all time.

```bash
curl "https://your-instance.example/api/companies/$COMPANY_ID/costs/by-agent?from=2026-01-01T00:00:00Z" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `CostByAgent`:

| Field | Type | Notes |
| --- | --- | --- |
| `agentId` | UUID | |
| `agentName`, `agentStatus` | string or null | Null if the agent row no longer exists. |
| `costCents` | number | |
| `inputTokens`, `cachedInputTokens`, `outputTokens` | number | |
| `apiRunCount` | integer | Distinct runs with `metered_api` events. |
| `subscriptionRunCount` | integer | Distinct runs with `subscription_included` or `subscription_overage` events. |
| `subscriptionInputTokens`, `subscriptionCachedInputTokens`, `subscriptionOutputTokens` | number | Token totals for the subscription events only. |

| Status | When |
| --- | --- |
| 400 | `invalid 'from' date` or `invalid 'to' date`. |
| 403 | `Spend and billing are visible to administrators only…` — a member without `agents:create`. |
| 403 | Not a member, or an agent key for another company (messages above). |

## The `CostEvent` object

From `packages/shared/src/types/cost.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId`, `agentId` | UUID | |
| `issueId`, `projectId`, `goalId`, `heartbeatRunId` | UUID or null | |
| `provider`, `biller`, `model` | string | |
| `billingType` | string | One of the six values above. |
| `billingCode` | string or null | |
| `inputTokens`, `cachedInputTokens`, `outputTokens` | integer | |
| `costCents` | integer | |
| `occurredAt`, `createdAt` | ISO 8601 timestamp | When the call happened, and when it was recorded. |

The complete schemas are in [the reference](/api/reference#tag/costs/reportCostEvent).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Budgets are set on the company and the agent: `budgetMonthlyCents` on [Companies](/api/companies) and [Agents](/api/agents). Other routes on this resource (finance events, run activity, issue cost summaries, breakdowns by model, provider, biller, project and issue, quota windows, budget policies and incidents, monthly run counts) are internal — see [the route index](/api/route-index), under `costs`.
