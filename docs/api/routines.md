---
title: Routines
summary: Standing instructions that create work on a schedule or on demand — list, read, create, update and run them.
---

A routine is a standing instruction: each time it runs, it creates an issue from its title and description and assigns it to an agent. These operations list and read a company's routines, create and change one, and start a run now.

**Source:** `server/src/routes/routines.ts` · **In the reference:** [Routines](/api/reference#tag/routines)

## Who may call it

| Operation | Who |
| --- | --- |
| `listRoutines`, `getRoutine` | a person who is a member, or an agent in that company |
| `createRoutine`, `runRoutine` | a person with the `tasks:assign` permission in the company — an agent gets 403 |
| `updateRoutine` | a person with the `tasks:assign` permission in the company, for any change — an agent gets 403, even for a routine assigned to itself |

Agents may not write standing instructions: every routine write (create, update, run, and trigger create, update, delete and secret rotation) answers 403 `Agents cannot create or change routines. Ask an owner, admin or operator.` to any agent, including one assigned to the routine. Every write needs `tasks:assign`: instance admins and the local operator skip that check, and anyone else without it gets 403 `Missing permission: tasks:assign`. A company import that contains recurring tasks applies the same rule, and the routines it creates arrive `paused`.

Every call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write.

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List routines

`GET /api/companies/{companyId}/routines` · [`listRoutines`](/api/reference#tag/routines/listRoutines)

The company's routines, most recently updated first. `projectId` filters to one project.

```bash
curl "https://your-instance.example/api/companies/$COMPANY_ID/routines?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `RoutineListItem`: a `Routine` (below) with its `triggers` (summary fields), its `lastRun`, and the `activeIssue` a run is still working on, or null.

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |

## Get a routine

`GET /api/routines/{id}` · [`getRoutine`](/api/reference#tag/routines/getRoutine)

```bash
curl https://your-instance.example/api/routines/$ROUTINE_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — a `RoutineDetail`: a `Routine` with its `project`, `assignee` and `parentIssue` summaries, all its `triggers`, its `activeIssue`, and `recentRuns` — the 25 most recent runs, newest first (`server/src/services/routines.ts`).

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Routine not found`. |

## Create a routine

`POST /api/companies/{companyId}/routines` · [`createRoutine`](/api/reference#tag/routines/createRoutine)

A new routine has no triggers. It runs when you call `runRoutine` (below); schedules and webhooks are added through the trigger routes, which are internal.

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/routines \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Weekly market summary", "description": "Summarize the week of research for Acme Research.", "assigneeAgentId": "'"$AGENT_ID"'", "projectId": "'"$PROJECT_ID"'", "priority": "medium" }'
```

**Body** (`createRoutineSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string, 1–200 characters | Required. The title of each issue a run creates. |
| `description` | string or null | Optional. The description of each issue. |
| `assigneeAgentId` | UUID or null | The agent each run's issue is assigned to. An `active` routine created without one is stored `paused`. |
| `projectId`, `goalId`, `parentIssueId` | UUID or null | Optional. Where each run's issue is filed. |
| `priority` | `critical` · `high` · `medium` · `low` | Default `medium`. |
| `status` | `active` · `paused` · `archived` | Default `active`. |
| `concurrencyPolicy` | `coalesce_if_active` · `skip_if_active` · `always_enqueue` | What a run does when an earlier run's issue, with the same inputs, is still being worked. Default `coalesce_if_active`. |
| `catchUpPolicy` | `skip_missed` · `enqueue_missed_with_cap` | What a schedule does after missed ticks. Default `skip_missed`. |
| `variables` | array | Optional. Type, default and options for the variables named in the title and description. |

**Concurrency policies:**

| Value | When an earlier run's issue is still being worked |
| --- | --- |
| `coalesce_if_active` | The new run is recorded `coalesced` and linked to that issue. No new issue. |
| `skip_if_active` | The new run is recorded `skipped` and linked to that issue. No new issue. |
| `always_enqueue` | A new issue is created anyway. |

**Catch-up policies:** with `skip_missed`, a schedule that missed several ticks runs once. With `enqueue_missed_with_cap`, it runs once per missed tick, up to 25 (`MAX_CATCH_UP_RUNS` in `server/src/services/routines.ts`).

**Variables.** A routine's variables are the placeholders named in its title and description; `date` and `timestamp` are built in. Each entry in `variables` sets one of them:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required. A letter, then letters, digits or `_`. |
| `type` | `text` · `textarea` · `number` · `boolean` · `select` | Default `text`. |
| `defaultValue` | string, number, boolean or null | Used when a run supplies no value. A `select` default must be one of its `options`. |
| `required` | boolean | Default `true`. A run with no value and no default answers 422. |
| `options` | array of string | `select` only, at least one, at most 50. |
| `label` | string or null | Up to 120 characters. |

An entry for a name that is not in the title or description is dropped.

**Response** `201` — the new `Routine`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema, including a `select` variable with no options or a default outside them. |
| 403 | `Agents cannot create or change routines. Ask an owner, admin or operator.` — the caller is an agent. |
| 403 | `Missing permission: tasks:assign`. |
| 403 | Not a member, an inactive membership (messages above). |
| 404 | `Project not found`, `Assignee agent not found`, `Goal not found`, `Parent issue not found`. |
| 409 | `Cannot assign routines to pending approval agents`, `Cannot assign routines to terminated agents`. |
| 422 | `Project must belong to same company`, `Assignee must belong to same company`, `Goal must belong to same company`, `Parent issue must belong to same company`. |
| 422 | `Variable "<name>" must be a boolean`, `Variable "<name>" must be a number` — a variable's `defaultValue` does not fit its type. |

## Update a routine

`PATCH /api/routines/{id}` · [`updateRoutine`](/api/reference#tag/routines/updateRoutine)

Send only the fields you are changing. The body is `createRoutineSchema` with every field optional.

```bash
curl -X PATCH https://your-instance.example/api/routines/$ROUTINE_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "paused" }'
```

**Body** (`updateRoutineSchema`) — the fields under create, all optional. Rules that apply only to an update:

- Every update needs `tasks:assign`, whichever fields it changes.
- Setting `status` to `active` needs an assignee.
- Clearing `assigneeAgentId` on an active routine leaves the routine `paused`.
- If the routine has an enabled schedule trigger, every required variable must have a default, because a schedule supplies no values.

**Response** `200` — the updated `Routine`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 403 | `Agents cannot create or change routines. Ask an owner, admin or operator.` — the caller is an agent. |
| 403 | `Missing permission: tasks:assign`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Routine not found`; or, for a changed reference, `Project not found`, `Assignee agent not found`, `Goal not found`, `Parent issue not found`. |
| 409 | `Cannot assign routines to pending approval agents`, `Cannot assign routines to terminated agents`. |
| 422 | `Default agent required` — `status: "active"` with no assignee. |
| 422 | `Scheduled routines require defaults for required variables: <names>`. |
| 422 | `… must belong to same company`, or a variable default that does not fit its type — as for create. |

## Run a routine

`POST /api/routines/{id}/run` · [`runRoutine`](/api/reference#tag/routines/runRoutine)

Starts a run now. A run fills the variables, creates the issue and wakes the assigned agent, subject to the routine's concurrency policy. A paused routine can be run this way; an archived one cannot.

```bash
curl -X POST https://your-instance.example/api/routines/$ROUTINE_ID/run \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "variables": { "region": "EMEA" }, "idempotencyKey": "weekly-summary-2026-40" }'
```

**Body** (`runRoutineSchema`, every field optional) — the fields that matter:

| Field | Type | Notes |
| --- | --- | --- |
| `variables` | object of string, number or boolean | Values for the routine's variables. Values under `payload.variables` are read too; `variables` wins. |
| `payload` | object or null | Stored on the run as its trigger payload. |
| `idempotencyKey` | string, up to 255 characters | A second call with the same key, `source` and trigger returns the first run and creates nothing. |
| `source` | `manual` · `api` | Default `manual`. |
| `triggerId` | UUID or null | Records the run against one of this routine's triggers, which must be enabled. |
| `assigneeAgentId`, `projectId` | UUID or null | Override the routine's assignee or project for this run only. |
| `executionWorkspaceId`, `executionWorkspacePreference`, `executionWorkspaceSettings` | | Passed to the issue the run creates. |

**Response** `202` — the `RoutineRun`. Its `status` says what happened: `issue_created` (`linkedIssueId` is the new issue), `coalesced` or `skipped` (linked to the issue already being worked), or `failed` with a `failureReason`. A run whose issue could not be created is recorded `failed` and still answers 202.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 403 | `Agents cannot create or change routines. Ask an owner, admin or operator.` — the caller is an agent. |
| 403 | `Missing permission: tasks:assign`. |
| 403 | `Trigger does not belong to routine` — `triggerId` is another routine's trigger. |
| 403 | Not a member, an inactive membership (messages above). |
| 404 | `Routine not found`, `Project not found`, `Assignee agent not found`. |
| 409 | `Routine is archived`. |
| 409 | `Routine trigger is not active` — `triggerId` names a disabled trigger. |
| 409 | `Cannot assign routines to pending approval agents`, `Cannot assign routines to terminated agents` — the `assigneeAgentId` override. |
| 409 | `Routine persistence acknowledgment is unknown; …` or `Routine dispatch acknowledgment is uncertain; …` — the run may have been accepted but the server could not confirm it. `details` carries `persistenceOutcome`, `routineId`, `runId` and `linkedIssueId`. Read the run and its issue before retrying. |
| 422 | `Default agent required` — neither the routine nor the body names an assignee. |
| 422 | `Missing routine variables: <names>` — a required variable has no value and no default. |
| 422 | `Variable "<name>" must be a boolean`, `… must be a number`, `… must match one of: <options>` — a value does not fit its variable's type. |
| 422 | `Project must belong to same company`, `Assignee must belong to same company` — the overrides. |

## The `Routine` object

From `packages/shared/src/types/routine.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `title`, `description` | string, string or null | The templates for each run's issue. |
| `assigneeAgentId` | UUID or null | |
| `projectId`, `goalId`, `parentIssueId` | UUID or null | |
| `priority` | string | |
| `status` | `active` · `paused` · `archived` | |
| `concurrencyPolicy`, `catchUpPolicy` | string | |
| `variables` | array of `{ name, label, type, defaultValue, required, options }` | |
| `lastTriggeredAt`, `lastEnqueuedAt` | timestamp or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

A `RoutineRun` has `id`, `routineId`, `triggerId`, `source` (`schedule` · `manual` · `api` · `webhook`), `status` (`received` · `coalesced` · `skipped` · `issue_created` · `completed` · `failed`), `triggeredAt`, `idempotencyKey`, `triggerPayload`, `linkedIssueId`, `coalescedIntoRunId`, `failureReason` and `completedAt`.

The complete schemas are in [the reference](/api/reference#tag/routines/getRoutine).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (run history, triggers and their secrets, the public webhook trigger) are internal — see [the route index](/api/route-index), under `routines`.
