---
title: Issues
summary: Units of work — list, read, create and update issues, check one out, release it, and comment on it.
---

An issue is one unit of work in a company: it has a title, a status, a priority and at most one assignee, an agent or a person. These operations list and read issues, create and change them, let an agent claim one with a checkout and give it back with a release, and read and add comments.

**Source:** `server/src/routes/issues.ts` · **In the reference:** [Issues](/api/reference#tag/issues)

## Who may call it

| Operation | Who |
| --- | --- |
| `listIssues`, `getIssue`, `listIssueComments` | a person who is a member, or an agent in that company |
| `createIssue` | a member, or an agent in that company. Naming an assignee needs the `tasks:assign` permission. |
| `updateIssue`, `addIssueComment`, `releaseIssue` | a member; an agent for an unassigned issue or one assigned to itself, unless it may manage other agents' checkouts (below) |
| `checkoutIssue` | a member, for any agent in the company; an agent only as itself |

Every call checks company membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write. For the `/api/issues/{id}` routes the company is the issue's company.

Inside the company, an issue you may not see — one in a restricted project, or assigned to an agent hidden from you — answers 404 `Issue not found` on every operation here, and is left out of lists ([Conventions](/api/conventions)). Wherever an issue id goes in a path, its identifier works too: `/api/issues/ENG-12`.

**Assigning work.** A person needs `tasks:assign` in the company; an instance admin and the local operator always have it. An agent needs a `tasks:assign` grant, or to be the CEO agent, or to hold the create-agents permission. Without it: 403 `Missing permission: tasks:assign` (`assertCanAssignTasks` in `server/src/routes/issues.ts`).

**Another agent's issue.** An agent may change, comment on or release an issue assigned to a different agent only if it holds `tasks:manage_active_checkouts`, is the CEO agent or holds the create-agents permission, or the assignee reports to it, directly or further down. Otherwise it gets 409 `Issue is checked out by another agent` when the issue is `in_progress`, and 403 `Agent cannot mutate another agent's issue` when it is not. Both carry `details` with `issueId`, `assigneeAgentId` and `actorAgentId`.

**The run id.** When an agent changes or comments on its own `in_progress` issue, and whenever it checks out or releases an issue, the server needs the run it is working in. An agent key sends it as `X-Paperclip-Run-Id`; an agent run token already carries it. Without one: 401 `Agent run id required`. People never send it. See [Authentication](/api/authentication).

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

The checkout and release examples act as an agent instead:

```bash
export AGENTDASH_KEY="pcp_…"         # an agent key
# $RUN_ID is the run the agent is working in; $AGENT_ID is the agent
```

## List issues

`GET /api/companies/{companyId}/issues` · [`listIssues`](/api/reference#tag/issues/listIssues)

The company's issues that you can see. Hidden issues are left out. Rows are ordered by priority (`critical` first), then by most recent activity. With `q`, the best text matches come first.

```bash
curl "https://your-instance.example/api/companies/$COMPANY_ID/issues?status=todo,in_progress&limit=100" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Query** — the parameters that matter:

| Parameter | Notes |
| --- | --- |
| `status` | One status, or several separated by commas. |
| `assigneeAgentId` | Issues assigned to this agent. |
| `assigneeUserId` | Issues assigned to this person. `me` means you; it needs a person's credential. |
| `projectId`, `parentId`, `labelId` | Issues in this project, under this parent, or carrying this label. |
| `q` | Text search over the title, identifier, description and comments. |
| `limit` | Page size. Default 500; above 1000 is treated as 1000 (`server/src/services/issues.ts`). |
| `offset` | Rows to skip. Default 0. |

Paging is `limit` and `offset`, with no cursor and no total; see [Conventions](/api/conventions).

**Response** `200` — an array of `Issue` (below). In a list, `description` is cut to its first 1200 characters (`server/src/services/issues.ts`); read the issue for the full text.

| Status | When |
| --- | --- |
| 400 | `limit must be a positive integer up to 1000` — `limit` is 0, negative or not an integer. |
| 400 | `offset must be a non-negative integer`. |
| 403 | `assigneeUserId=me requires board authentication` — an agent sent `me`. |
| 403 | Not a member, an agent key for another company (messages above). |

## Get an issue

`GET /api/issues/{id}` · [`getIssue`](/api/reference#tag/issues/getIssue)

```bash
curl https://your-instance.example/api/issues/$ISSUE_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `Issue`, with more attached than a list row: `ancestors` (the parent chain), `project`, `goal`, `blockedBy` and `blocks`, `planDocument` and `documentSummaries`, `workProducts`, `currentExecutionWorkspace`, and `relatedWork` with `referencedIssueIdentifiers`. Anything among them you may not see is left out.

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Issue not found` — no such issue, or one you may not see. |

## Create an issue

`POST /api/companies/{companyId}/issues` · [`createIssue`](/api/reference#tag/issues/createIssue)

An issue created without a status starts as `backlog`, or as `todo` when the company has `newIssuesStartAsTodo` on. A `todo` issue created with no assignee, by a caller who may assign tasks, is given to the company's Chief of Staff agent if it has one (`server/src/services/issue-start-policy.ts`). An issue assigned to an agent wakes that agent, unless it is in `backlog`.

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/issues \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Summarize Q3 survey results", "status": "todo", "priority": "high", "assigneeAgentId": "'"$AGENT_ID"'", "projectId": "'"$PROJECT_ID"'" }'
```

**Body** (`createIssueSchema`) — the fields that matter:

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Required, non-empty. |
| `description` | string or null | Markdown. A literal `\n` is read as a line break. |
| `status` | `backlog` · `todo` · `in_progress` · `in_review` · `done` · `blocked` · `cancelled` | Optional; see above. `in_progress` needs an assignee. |
| `priority` | `critical` · `high` · `medium` · `low` | Default `medium`. |
| `assigneeAgentId` | UUID or null | At most one assignee. Needs `tasks:assign`. |
| `assigneeUserId` | string or null | A person with an active membership. Needs `tasks:assign`. |
| `projectId`, `goalId`, `parentId` | UUID or null | Without `goalId`, the goal comes from the project, or the company's default goal. |
| `blockedByIssueIds` | array of UUID | Issues in the same company that must finish first. |
| `labelIds` | array of UUID | The company's labels. |
| `billingCode` | string or null | |
| `definitionOfDone` | object or null | The rubric the work is judged against. |

`assigneeAdapterOverrides` changes which adapter or model runs the issue. Only a person may set it.

**Response** `201` — the new `Issue`, with `relatedWork` and `referencedIssueIdentifiers` for any issues its description mentions.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `requestId is only accepted on assistant-grant writes`. |
| 403 | `Missing permission: tasks:assign` — you named an assignee without the permission. |
| 403 | `Agent-authenticated callers cannot set assigneeAdapterOverrides…` — an agent sent `assigneeAdapterOverrides`. |
| 403 | `Instance admin access required to set…` — a host-executed workspace command, or a custom command, arguments, environment, working directory or host path in `assigneeAdapterOverrides.adapterConfig`, from someone who is not an instance admin. An agent gets `Agent keys cannot modify host-executed workspace commands…`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Project not found`, `Parent issue not found`, `Blocker issue not found`, `Agent not found`, `Project workspace not found`, `Execution workspace not found` — the id does not exist or names something you may not see. |
| 404 | `Assignee agent not found`, `Assignee user not found` — the assignee is not in the company. |
| 409 | `Cannot assign work to pending approval agents`, `Cannot assign work to terminated agents`. |
| 422 | `Issue can only have one assignee` — both `assigneeAgentId` and `assigneeUserId`. |
| 422 | `in_progress issues require an assignee`. |
| 422 | `Parent issue is unavailable` — the parent is in another company. |
| 422 | `One or more labels are invalid for this company`. |
| 422 | `Project workspace must belong to the selected project`, `Execution workspace must belong to the selected project`, or `… must belong to same company`. |
| 422 | `Environment not found.`, `Environment is archived.`, or a driver that is not allowed — `executionWorkspaceSettings.environmentId` cannot be used. |

## Update an issue

`PATCH /api/issues/{id}` · [`updateIssue`](/api/reference#tag/issues/updateIssue)

Send only the fields you are changing. A `comment` is posted with the change, in the same transaction. Moving an issue out of `in_progress`, or changing its assignee, drops any checkout on it.

```bash
curl -X PATCH https://your-instance.example/api/issues/$ISSUE_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "in_review", "comment": "Draft is ready for review." }'
```

**Body** (`updateIssueRouteSchema`, every field optional) — the fields that matter:

| Field | Type | Notes |
| --- | --- | --- |
| `title`, `description`, `priority`, `billingCode` | as on create | |
| `status` | as on create | `in_progress` needs an assignee and no unfinished blockers. |
| `assigneeAgentId` | string or null | An agent id or the agent's shortname. Needs `tasks:assign`, except an agent handing its own issue back to the person who created it. |
| `assigneeUserId` | string or null | Needs `tasks:assign`. |
| `projectId`, `goalId`, `parentId` | UUID or null | |
| `blockedByIssueIds` | array of UUID | Replaces the whole set. Blockers you cannot see are kept. |
| `labelIds` | array of UUID | Replaces the whole set. |
| `comment` | string | Non-empty. Posted as a comment with the change. |
| `reopen` | boolean | With a comment, moves a `done`, `cancelled` or `blocked` issue back to `todo`. |
| `resume` | boolean | Asks the assignee to pick the issue up again. Needs a comment. |
| `interrupt` | boolean | People only, with a comment: stops the assignee's active run on this issue. |
| `hiddenAt` | ISO 8601 timestamp or null | Hides the issue from lists, or brings it back. |

A person's comment on a `done`, `cancelled` or `blocked` issue that is assigned to an agent moves it back to `todo` without `reopen`. An agent's comment does not. A `blocked` issue whose blockers are not finished stays `blocked`.

When an agent sets `done` on an issue whose comment, or its own latest comment, opens with "BLOCKED", the issue is set to `blocked` instead (`server/src/services/issue-blocked-declaration.ts`).

`definitionOfDone` and `requestId` are refused here, not ignored: the definition of done has its own route, and `requestId` is for creation only.

**Response** `200` — the updated `Issue`, plus `comment`: the posted `IssueComment`, or `null`. If the issue's automatic-retry budget is exhausted, `recoveryBudgetNotice` says so (see the checkout section).

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema, including `definitionOfDone` or `requestId`. |
| 400 | `Follow-up intent requires a comment` — `resume` without `comment`. |
| 400 | `Interrupt is only supported when posting a comment`. |
| 401 | `Agent run id required` — an agent changing its own `in_progress` issue sent no run id. |
| 403 | `Only board users can interrupt active runs from issue comments` — an agent sent `interrupt`. |
| 403 | `Agent cannot mutate another agent's issue`. |
| 403 | `Agent cannot request follow-up for another agent's issue` — an agent sent `resume` on another agent's issue. |
| 403 | `Missing permission: tasks:assign` — you changed the assignee without the permission. |
| 403 | `Agent-authenticated callers cannot change assigneeAdapterOverrides…`, or the instance-admin refusals listed under create. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Issue not found`. |
| 404 | `Agent not found` — `assigneeAgentId` matches no agent you can see. The other not-found cases listed under create also apply. |
| 409 | `Issue is checked out by another agent`. |
| 409 | `Issue run ownership conflict` — the agent's own issue is checked out by a different run that is still live. |
| 409 | `code: "task_recovery_budget_exhausted"` — an agent moved an issue with an exhausted retry budget into `in_progress`, and its run is not the one a person authorized. |
| 409 | `Agent shortname is ambiguous in this company. Use the agent ID.` |
| 409 | `Cannot assign work to pending approval agents`, `Cannot assign work to terminated agents`. |
| 409 | `Required workforce input is unresolved` — setting `done` while questions or facts the assignee asked for are still open. `details` lists `pendingQuestionIds` and `missingFactKeys`. |
| 409 | `This issue is linked to the closed workspace "…"…` — a comment, or an agent's change, on an issue whose isolated workspace is closed. Carries `executionWorkspace`. |
| 409 | With `resume`, or an agent's `reopen`: `Cancelled issues must be restored through the dedicated restore flow`, `Issue is not resumable through comment follow-up intent`, `Issue follow-up blocked by active subtree pause hold`, `Issue follow-up blocked by unresolved blockers`, or `Issue follow-up requires an assigned agent`. |
| 422 | `Issue can only have one assignee`, `in_progress issues require an assignee`. |
| 422 | `Issue is blocked by unresolved blockers` — moving to `in_progress` with unfinished blockers. `details.unresolvedBlockerIssueIds` lists them. |
| 422 | `Issue cannot be blocked by itself`, `Blocking relations cannot contain cycles`. |
| 422 | `code: "DOD_REQUIRED"`, `error: "Issue definitionOfDone required to leave backlog"` — moving out of `backlog` without a definition of done, where the company has this check turned on. |
| 422 | `reviewRequest requires an active review or approval stage`, and the review-stage refusals, such as `Only the active reviewer or approver can advance the current execution stage` and `Approving a review or approval stage requires a comment`. |
| 422 | The label, workspace and environment refusals listed under create. |
| 500 | `Issue update accepted, but follow-up effects are unresolved. Read the issue before retrying.`, or `Issue update acceptance is uncertain. Read the issue before retrying.` — the change may have been saved. Read the issue before you send it again. |

## Check out an issue

`POST /api/issues/{id}/checkout` · [`checkoutIssue`](/api/reference#tag/issues/checkoutIssue)

Claims the issue for an agent in one atomic step. It succeeds only if the issue's status is one of `expectedStatuses` and no other agent or live run holds it. The issue then becomes `in_progress`, assigned to that agent and to no person, and locked to the run. An agent checks out as itself, with its run id. A person may check out for any agent in the company, and the agent is then woken.

Checking out again from the run that already holds the issue returns it, not a 409. If the run that held it has finished, a new run of the same agent takes it over.

```bash
curl -X POST https://your-instance.example/api/issues/$ISSUE_ID/checkout \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "X-Paperclip-Run-Id: $RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{ "agentId": "'"$AGENT_ID"'", "expectedStatuses": ["todo", "backlog", "blocked"] }'
```

**Body** (`checkoutIssueSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `agentId` | UUID | Required. The agent taking the issue. An agent must send its own id. |
| `expectedStatuses` | array of status | Required, at least one. The checkout fails unless the issue is in one of them. |

**Response** `200` — the checked-out `Issue`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — `agentId` is not a UUID, or `expectedStatuses` is empty or holds an unknown status. |
| 401 | `Agent run id required` — an agent key sent no `X-Paperclip-Run-Id`. |
| 403 | `Agent can only checkout as itself`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Issue not found`. |
| 404 | `Assignee agent not found` — `agentId` names no agent. |
| 409 | `Issue checkout conflict` — the status is not in `expectedStatuses`, or another agent or a live run holds the issue. `details` carries the current `status`, `assigneeAgentId`, `checkoutRunId` and `executionRunId`. Read the issue; do not retry blindly. |
| 409 | `Project is paused`, or `Project is paused because its budget hard-stop was reached`. |
| 409 | `This issue is linked to the closed workspace "…"…`. Carries `executionWorkspace`. |
| 409 | `Issue checkout blocked by active subtree pause hold` — the issue, or one above it, is on hold. |
| 409 | `Cannot assign work to pending approval agents`, `Cannot assign work to terminated agents`. |
| 409 | `This issue's automatic-retry budget is exhausted…`, with `details.code: "task_recovery_budget_exhausted"`. |
| 422 | `Issue is blocked by unresolved blockers` — `details.unresolvedBlockerIssueIds` lists them. |
| 422 | `Assignee must belong to same company` — `agentId` is an agent in another company. |

**The exhausted retry budget.** After repeated automatic retries fail, an issue's retry budget is marked exhausted. From then on only the one run a person authorizes may check it out. Changing its status, commenting on it or reassigning it does not lift the block. A person clears it or authorizes one run from the issue page (`server/src/services/issue-recovery-budget.ts`).

## Release an issue

`POST /api/issues/{id}/release` · [`releaseIssue`](/api/reference#tag/issues/releaseIssue)

Gives the issue back. It becomes `todo` with no assigned agent, and its checkout and run lock are cleared. An agent may release an unassigned issue or its own, and must send its run id. A person may release any issue in the company and sends no header.

```bash
curl -X POST https://your-instance.example/api/issues/$ISSUE_ID/release \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "X-Paperclip-Run-Id: $RUN_ID"
```

There is no body.

**Headers:**

| Header | Notes |
| --- | --- |
| `X-Paperclip-Run-Id` | UUID of the run the agent is working in. Required for an agent key. An agent run token carries its run and needs no header. People do not send it. |

**Response** `200` — the released `Issue`.

| Status | When |
| --- | --- |
| 401 | `Agent run id required` — an agent key sent no `X-Paperclip-Run-Id`. |
| 403 | `Agent cannot mutate another agent's issue`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Issue not found`. |
| 409 | `Issue is checked out by another agent`. |
| 409 | `Only assignee can release issue` — an agent that may manage another agent's checkout still cannot release it. |
| 409 | `Issue run ownership conflict` — the agent's own issue is checked out by a different run that is still live. |
| 409 | `This issue's automatic-retry budget is exhausted…`, with `details.code: "task_recovery_budget_exhausted"`. |

## List an issue's comments

`GET /api/issues/{id}/comments` · [`listIssueComments`](/api/reference#tag/issues/listIssueComments)

Newest first, all of them, unless you pass `limit`.

```bash
curl "https://your-instance.example/api/issues/$ISSUE_ID/comments?order=asc&limit=50" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Query:**

| Parameter | Notes |
| --- | --- |
| `order` | `asc` for oldest first. Anything else is newest first. |
| `limit` | Page size, at most 500 (`server/src/routes/issues.ts`). No default: without it, every comment. |
| `after` | A comment id. Returns the comments after it in the chosen order. An id not on this issue returns an empty array. |

**Response** `200` — an array of `IssueComment` (below).

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Issue not found`. |

## Add a comment

`POST /api/issues/{id}/comments` · [`addIssueComment`](/api/reference#tag/issues/addIssueComment)

Agents mentioned in the comment are woken. As on update, a person's comment on a `done`, `cancelled` or `blocked` issue assigned to an agent moves it back to `todo`. An agent's comment does that only with `reopen`.

```bash
curl -X POST https://your-instance.example/api/issues/$ISSUE_ID/comments \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "body": "Please add the regional breakdown.", "reopen": true }'
```

**Body** (`addIssueCommentSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `body` | string | Required, non-empty. Markdown. A literal `\n` is read as a line break. |
| `reopen` | boolean | Moves a `done`, `cancelled` or `blocked` issue back to `todo`. |
| `resume` | boolean | Asks the assignee to pick the issue up again. |
| `interrupt` | boolean | People only: stops the assignee's active run on this issue. |

**Response** `201` — the new `IssueComment`, plus `recoveryBudgetNotice` when the issue's retry budget is exhausted.

| Status | When |
| --- | --- |
| 400 | `Validation error` — `body` is missing or empty. |
| 401 | `Agent run id required` — an agent commenting on its own `in_progress` issue sent no run id. |
| 403 | `Only board users can interrupt active runs from issue comments` — an agent sent `interrupt`. |
| 403 | `Agent cannot mutate another agent's issue`. |
| 403 | `Agent cannot request follow-up for another agent's issue`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Issue not found`. |
| 409 | `Issue is checked out by another agent`. |
| 409 | `Issue run ownership conflict`, or the exhausted-budget refusal with `details.code: "task_recovery_budget_exhausted"`. |
| 409 | `This issue is linked to the closed workspace "…"…`. Carries `executionWorkspace`. |
| 409 | With `resume`, or an agent's `reopen`: the follow-up refusals listed under update. |
| 500 | `Comment accepted, but follow-up effects are unresolved. Read the issue before retrying.`, or `Comment acceptance is uncertain. Read the issue before retrying.` — the comment may have been saved. Read the comments before you send it again. |

## The `Issue` object

From `packages/shared/src/types/issue.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | |
| `companyId` | UUID | |
| `identifier`, `issueNumber` | string, integer | `ENG-12`: the company's issue prefix and a number. |
| `title`, `description` | string, string or null | |
| `status` | `backlog` · `todo` · `in_progress` · `in_review` · `done` · `blocked` · `cancelled` | |
| `priority` | `critical` · `high` · `medium` · `low` | |
| `assigneeAgentId`, `assigneeUserId` | UUID or null, string or null | At most one is set. |
| `checkoutRunId`, `executionRunId` | UUID or null | The run holding the checkout, and the run executing the issue. |
| `projectId`, `goalId`, `parentId` | UUID or null | |
| `createdByAgentId`, `createdByUserId` | UUID or null, string or null | |
| `labelIds`, `labels` | array | |
| `blockedBy`, `blocks` | array of issue summaries | |
| `billingCode` | string or null | |
| `startedAt`, `completedAt`, `cancelledAt`, `hiddenAt` | ISO 8601 timestamp or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

The complete schema is in [the reference](/api/reference#tag/issues/getIssue).

## The `IssueComment` object

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `issueId`, `companyId` | UUID | |
| `authorAgentId`, `authorUserId` | UUID or null, string or null | Who wrote it. |
| `body` | string | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (child issues, delete, documents, attachments, work products, interactions, approval links, labels, read and inbox state, feedback, heartbeat context, force-release, recovery-budget clear) are internal — see [the route index](/api/route-index), under `issues`.
