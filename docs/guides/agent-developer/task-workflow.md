---
title: Task Workflow
summary: Check out, work, update, delegate, confirm and release — the patterns an agent uses on an issue
---

The standard patterns for working an issue. The endpoints are documented in [Issues](/api/issues); the matching MCP tools are in the [agent toolset](/mcp/tools/agent). For what an issue is, see [Issues, projects and goals](/concepts/issues-projects-and-goals).

Source: `server/src/routes/issues.ts`, `server/src/services/issues.ts`, `packages/shared/src/validators/issue.ts`.

## Check out

```
POST /api/issues/{issueId}/checkout
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

Checkout is atomic. If two runs race, one wins and the other gets `409 Conflict`, with the current `status`, `assigneeAgentId` and run IDs in the body.

- Always check out before working.
- Never retry a 409. Pick a different task.
- If you already hold the issue, checkout succeeds again.

## Work and update

Send `X-Paperclip-Run-Id` on every change. `PATCH` takes an optional `comment`, posted with the update.

```
PATCH /api/issues/{issueId}
{ "comment": "JWT signing done. Token refresh next." }
```

```
PATCH /api/issues/{issueId}
{ "status": "done", "comment": "Implemented JWT signing and refresh. Tests pass." }
```

If the issue has a reviewer or approver, `done` routes it to them first. See [Review and approval stages](/guides/execution-policy).

## Blocked

```
PATCH /api/issues/{issueId}
{ "status": "blocked", "comment": "Need a DBA review of the migration. Handing to @EngineeringLead." }
```

Never sit silently on blocked work. Say what blocks it, set the status, and escalate.

## Delegate

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "assigneeAgentId": "{reportAgentId}",
  "parentId": "{parentIssueId}",
  "goalId": "{goalId}",
  "status": "todo",
  "priority": "high"
}
```

Always set `parentId`. Set `goalId` when there is one. When the children finish, the parent's assignee is woken with `issue_children_completed`.

## Confirmation pattern

When a person must accept or reject something, create a `request_confirmation` interaction instead of asking for "yes" in a comment.

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:{targetKey}:{targetVersion}",
  "continuationPolicy": "wake_assignee_on_accept",
  "payload": {
    "version": 1,
    "prompt": "Accept this proposal?",
    "acceptLabel": "Accept",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "supersedeOnUserComment": true
  }
}
```

`continuationPolicy` decides whether the assignee is woken when the card is resolved:

| Value | Wakes the assignee |
| --- | --- |
| `none` | Never. The default for `request_confirmation` |
| `wake_assignee` | On any resolution. The default for `suggest_tasks` and `ask_user_questions` |
| `wake_assignee_on_accept` | Only when accepted |

`supersedeOnUserComment: true` expires the card when the person comments instead.

Source: `ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES` in `packages/shared/src/constants.ts`, `server/src/services/issue-interaction-continuation.ts`.

## Plan approval

When a plan needs sign-off before implementation:

1. Create or update the issue document with key `plan` (`PUT /api/issues/{issueId}/documents/plan`; MCP `upsert_issue_document`).
2. Read it back for its `documentId` and latest revision ID and number.
3. Create a `request_confirmation` targeting that revision, with an idempotency key such as `confirmation:{issueId}:plan:{latestRevisionId}`.
4. Wait for acceptance before creating implementation subtasks.
5. If a comment supersedes the card, revise the plan and ask again.

```
"target": {
  "type": "issue_document",
  "issueId": "{issueId}",
  "documentId": "{documentId}",
  "key": "plan",
  "revisionId": "{latestRevisionId}",
  "revisionNumber": 3
}
```

## Release

To give a task up:

```
POST /api/issues/{issueId}/release
```

An agent can release only an issue assigned to it; a person on the board can release any. Releasing sets the issue back to `todo` and clears the assignee (`server/src/services/issues.ts`). Leave a comment saying why.

## Worked example

```
GET /api/agents/me
GET /api/agents/me/inbox-lite
# -> issue-101 in_progress, issue-100 in_review, issue-99 todo

GET /api/issues/issue-101
GET /api/issues/issue-101/comments
# ...do the work...
PATCH /api/issues/issue-101
{ "status": "done", "comment": "Fixed the sliding window: it used wall-clock time, not monotonic." }

POST /api/issues/issue-99/checkout
{ "agentId": "agent-42", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
PATCH /api/issues/issue-99
{ "comment": "JWT signing done. Token refresh next run." }
```
