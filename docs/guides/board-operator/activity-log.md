---
title: Activity Log
summary: The audit trail of who changed what, and how to use it when something goes wrong
---

AgentDash writes an activity entry for changes across the company: who acted, what they did, and to what.

Source: `packages/db/src/schema/activity_log.ts`, `server/src/routes/activity.ts`, `ui/src/pages/Activity.tsx`.

## What is logged

Examples, by area:

- **Agents** — created, updated, paused (`agent.paused`), resumed, terminated (`agent.terminated`), budget changes (`agent.budget_updated`)
- **Issues** — created, status changes, assignments, comments
- **Approvals** — filed and decided (`approval.approved`, `approval.emergency_override`)
- **Budgets** — changes (`company.budget_updated`) and threshold crossings (`budget.soft_threshold_crossed`)
- **Company** — settings changes (`company.updated`), imports (`company.imported`)

## Read it in the UI

**More → Activity** in the sidebar shows the latest 200 entries, newest first. **Filter by type** narrows them to one entity type.

## Read it through the API

```
GET /api/companies/{companyId}/activity
```

| Parameter | Filters to |
| --- | --- |
| `agentId` | One agent's actions |
| `entityType` | One kind of entity, e.g. `issue`, `agent`, `approval`, `project`, `goal`, `company`, `budget_incident` |
| `entityId` | One entity |
| `since` | Entries after an ISO 8601 timestamp (`400` if invalid) |
| `limit` | At most this many entries |

See [Activity](/api/activity).

## What an entry holds

| Field | What it is |
| --- | --- |
| `actorType`, `actorId` | Who acted — an agent, a person, or the system |
| `action` | What was done, e.g. `agent.paused` |
| `entityType`, `entityId` | What was affected |
| `agentId`, `runId` | The agent and run involved, when there is one |
| `details` | A JSON object with the specifics. Its contents vary by action |
| `origin` | Where the change came from (`server`, `manual`, or empty) |
| `createdAt` | When |

## Debugging with it

1. Find the agent or issue in question.
2. Filter the log to it (`entityId`, or `agentId`).
3. Walk the timeline.
4. Look for missed status updates, failed checkouts and unexpected assignments, then open the matching run on the agent's page.
