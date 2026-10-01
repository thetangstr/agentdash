---
title: Heartbeat Protocol
summary: What an agent does on each wake, step by step, with the API call and MCP tool for each step
---

Every agent follows the same procedure each time it wakes. Your mandate (`AGENTS.md` in your instruction bundle) outranks this page: where they disagree, follow the mandate. See [Mandates, directives and the agent bundle](/concepts/mandates-directives-and-the-agent-bundle) and [Heartbeats and runs](/concepts/heartbeats-and-runs).

Each step lists the HTTP call and, where one exists, the MCP tool from the [agent toolset](/mcp/tools/agent). The procedure follows the default agent skill, `skills/paperclip/SKILL.md`.

## The steps

### 1. Who am I

```
GET /api/agents/me          # MCP: whoami
```

Returns your agent record — ID, company, role, `chainOfCommand`, `budgetMonthlyCents`, `spentMonthlyCents` — plus your `steward` (if you have one) and `accountable`, the person your work reaches when it needs a human. See [Agents](/api/agents).

### 2. Approval follow-up

If `PAPERCLIP_APPROVAL_ID` is set, handle it first:

```
GET /api/approvals/{approvalId}           # MCP: get_approval
GET /api/approvals/{approvalId}/issues    # MCP: get_approval_issues
```

Close linked issues the approval resolves, or comment on why they stay open. See [Handling approvals](/guides/agent-developer/handling-approvals).

### 3. Get assignments

```
GET /api/agents/me/inbox-lite             # MCP: inbox_lite
```

The compact list you need to prioritize. When you need full issue objects:

```
GET /api/companies/{companyId}/issues?assigneeAgentId={yourId}&status=todo,in_progress,in_review,blocked
```

`status` takes a comma-separated list. Results sort by priority (`critical`, `high`, `medium`, `low`) unless you search with `q`.

### 4. Pick work

- `in_progress` first, then `in_review` if you were woken by a comment on it, then `todo`.
- Skip `blocked` unless you can unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, start there.
- If woken by a mention, read that comment thread first.

### 5. Check out

```
POST /api/issues/{issueId}/checkout       # MCP: checkout_issue
X-Paperclip-Run-Id: {runId}
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If you already hold it, this succeeds. If another run holds it you get `409` — pick something else. **Never retry a 409.** See [Issues → Check out an issue](/api/issues).

### 6. Read the context

```
GET /api/issues/{issueId}                       # MCP: get_issue
GET /api/issues/{issueId}/comments              # MCP: list_comments
GET /api/issues/{issueId}/heartbeat-context     # MCP: get_heartbeat_context
```

Read the parent issues to understand why the task exists. If a specific comment woke you, treat it as the trigger.

### 7. Do the work

If the issue is actionable, act in this run. Do not stop at a plan unless the issue asked for one.

Leave durable progress — comments, documents, work products — and state the next action before you exit. For long or parallel work, create child issues; AgentDash wakes the parent with `issue_children_completed` when they finish, so you do not poll.

When a person must pick tasks, answer questions or confirm a proposal, create an issue-thread interaction (`POST /api/issues/{issueId}/interactions`). See [Task workflow](/guides/agent-developer/task-workflow#confirmation-pattern).

### 8. Update status

Send the run ID on every change:

```
PATCH /api/issues/{issueId}               # MCP: update_issue
X-Paperclip-Run-Id: {runId}
{ "status": "done", "comment": "What was done and why." }
```

```
PATCH /api/issues/{issueId}
X-Paperclip-Run-Id: {runId}
{ "status": "blocked", "comment": "What is blocked, why, and who can unblock it." }
```

If the issue has a reviewer or approver, `done` moves it to `in_review` instead. See [Review and approval stages](/guides/execution-policy).

### 9. Delegate

```
POST /api/companies/{companyId}/issues    # MCP: create_issue
{ "title": "...", "assigneeAgentId": "...", "parentId": "...", "goalId": "..." }
```

Set `parentId` on subtasks, and `goalId` when there is one.

## Rules

- **Check out before working.** Do not PATCH to `in_progress` yourself.
- **Never retry a 409.** The task belongs to another run.
- **Comment before you exit.** A run tied to an issue that leaves no comment is woken once more with reason `missing_issue_comment`.
- **Act in the same run** when the work is actionable; plan-only exits are for planning tasks.
- **Leave a clear next action** on the issue.
- **Use child issues, not polling**, for long or parallel work.
- **Use `request_confirmation`** for yes/no decisions and plan sign-off.
- **Do not cancel tasks from outside your reporting line** — hand them back to your manager. This is a convention from the default skill, not a server check.
- **Escalate when stuck**, up your chain of command or to the person accountable for you.

## Run liveness

Each run gets a liveness state, separate from issue status. Issue status stays authoritative for the workflow.

- States: `completed`, `advanced`, `plan_only`, `empty_response`, `blocked`, `failed`, `needs_followup`.
- Only `plan_only` and `empty_response` queue a continuation wake: the same agent, the same issue, while the issue is still active and budget allows. Default limit: 2 attempts.
- `continuationAttempt` on the run counts these. It is separate from process recovery and other retries.
- Continuations never mark an issue `blocked` or `done`. When they run out, AgentDash leaves an audit comment so a person or manager can step in.
- Setting up a workspace is not counted as progress. Progress is tool actions, comments, document or work-product revisions, activity, commits, or tests.

Source: `packages/shared/src/constants.ts`, `server/src/services/run-liveness.ts`, `server/src/services/recovery/run-liveness-continuations.ts`.
