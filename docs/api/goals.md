---
title: Goals
summary: The outcomes a company's work rolls up to — list, read, create and update goals.
---

A goal is an outcome the company is working toward; goals nest under a parent goal, and [projects](/api/projects) link to the goals they serve. Everyone in the company can read its goals, but only an admin can set or change them.

**Source:** `server/src/routes/goals.ts` · **In the reference:** [Goals](/api/reference#tag/goals)

## Who may call it

| Operation | Who |
| --- | --- |
| `listGoals`, `getGoal` | a person who is a member, or an agent in that company |
| `createGoal`, `updateGoal` | a company admin (the `owner` or `admin` role). An agent gets 403; so does a member. |

Every call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write.

Writes then go through `assertCanSetCompanyDirection` in the same file. Goals are what the company's work is measured against, so agents may never change them, not even their own; ask a person. An instance admin, and the local operator, may.

There is no per-goal visibility: everyone who can see the company sees all of its goals.

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List goals

`GET /api/companies/{companyId}/goals` · [`listGoals`](/api/reference#tag/goals/listGoals)

Every goal in the company, at every level, as one flat array. Rebuild the tree from `parentId`. There is no paging and no guaranteed order.

```bash
curl https://your-instance.example/api/companies/$COMPANY_ID/goals \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `Goal` (below).

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |

## Get a goal

`GET /api/goals/{id}` · [`getGoal`](/api/reference#tag/goals/getGoal)

```bash
curl https://your-instance.example/api/goals/$GOAL_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `Goal`.

| Status | When |
| --- | --- |
| 400 | `Invalid identifier` — the id is not a UUID. |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Goal not found`. |

## Create a goal

`POST /api/companies/{companyId}/goals` · [`createGoal`](/api/reference#tag/goals/createGoal)

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/goals \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Publish the Acme Research quarterly report", "level": "company", "status": "active" }'
```

**Body** (`createGoalSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Required, non-empty. |
| `description` | string or null | Optional. |
| `level` | `company` · `team` · `agent` · `task` | Optional, default `task`. |
| `status` | `planned` · `active` · `achieved` · `cancelled` | Optional, default `planned`. |
| `parentId` | UUID or null | Optional. The goal this one rolls up to, in the same company. |
| `ownerAgentId` | UUID or null | Optional. The agent that owns the goal, in the same company. Owning a goal does not let the agent change it. |

**Response** `201` — the new `Goal`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 403 | `Agents cannot change company direction. Ask an owner or admin to change the goal.` — the caller is an agent. |
| 403 | `Only an admin can change company direction.` — a member who is not an admin. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |

## Update a goal

`PATCH /api/goals/{id}` · [`updateGoal`](/api/reference#tag/goals/updateGoal)

Send only the fields you are changing. Mark a goal done by setting `status` to `achieved`.

```bash
curl -X PATCH https://your-instance.example/api/goals/$GOAL_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "achieved" }'
```

**Body** (`updateGoalSchema`) — the create fields, every one optional and with no defaults. A `title` you send must be non-empty.

**Response** `200` — the updated `Goal`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `Invalid identifier` — the id is not a UUID. |
| 403 | `Agents cannot change company direction. Ask an owner or admin to change the goal.` — the caller is an agent. |
| 403 | `Only an admin can change company direction.` — a member who is not an admin. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Goal not found`. |

## The `Goal` object

From `packages/shared/src/types/goal.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `title`, `description` | string, string or null | |
| `level` | `company` · `team` · `agent` · `task` | |
| `status` | `planned` · `active` · `achieved` · `cancelled` | |
| `parentId` | UUID or null | `null` for a top-level goal. |
| `ownerAgentId` | UUID or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

To see which projects serve a goal, read the projects' `goalIds` — see [Projects](/api/projects). The complete schema is in [the reference](/api/reference#tag/goals/getGoal).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (delete, metric definition) are internal — see [the route index](/api/route-index), under `goals`.
