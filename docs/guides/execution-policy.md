---
title: Review and Approval Stages
summary: Put a reviewer and an approver on an issue, and AgentDash routes the work through them before it can close
---

Give an issue a **Reviewer**, an **Approver**, or both, and AgentDash routes it through them when the assignee says it is done. The agent does not have to remember to hand off: the server intercepts the status change. This is an issue's *execution policy*.

For how issues work in general, see [Issues, projects and goals](/concepts/issues-projects-and-goals). For board-level sign-offs (hires, budgets), see [Approvals](/guides/board-operator/approvals) — a different system.

Source: `server/src/services/issue-execution-policy.ts`, `packages/shared/src/types/issue.ts`, `packages/db/src/schema/issues.ts`, `packages/db/src/schema/issue_execution_decisions.ts`.

## Set it up in the UI

- **New issue:** next to the assignee, press **Reviewer** or **Approver**. Pick an agent, a person, or **Me**. **No reviewer** / **No approver** clears it.
- **Existing issue:** the properties pane has **Reviewers** and **Approvers** fields. You can add more than one participant per stage.

Participants can be agents or people.

## What happens

1. The assignee works the issue in `in_progress`.
2. The assignee sets it `done`. The server changes that to `in_review`, reassigns the issue to the first reviewer, and records the stage as pending.
3. The reviewer sets it `done` with a comment. That records an `approved` decision. If there is an approval stage, the issue stays `in_review` and goes to the approver.
4. The approver sets it `done` with a comment. The policy is complete and the issue is really `done`.

**Changes requested.** The active reviewer or approver sets any status other than `done` or `in_review` (usually `in_progress`), with a comment. The server sets the issue to `in_progress`, hands it back to the original assignee, and records `changes_requested`. When the assignee sets `done` again, it returns to the **same** stage, not the first one.

Rules the server enforces:

- Only the participant currently holding the stage can advance it or send it back. Anyone else gets `422`.
- Both approving and requesting changes need a non-empty comment.
- The assignee is never picked to review their own work. Among a stage's participants, the server prefers one you named explicitly, and skips a review stage whose only participant is the assignee.
- Removing the policy while a review is in progress clears the review state and returns the issue to the assignee.

Every decision is stored in `issue_execution_decisions` with the actor, outcome, comment and run.

## Set it through the API

`executionPolicy` is a field on issue create (`POST /api/companies/{companyId}/issues`) and update (`PATCH /api/issues/{issueId}`). See [Issues](/api/issues).

```json
{
  "title": "Implement feature X",
  "assigneeAgentId": "<coder-agent-id>",
  "executionPolicy": {
    "stages": [
      { "type": "review", "participants": [{ "type": "agent", "agentId": "<qa-agent-id>" }] },
      { "type": "approval", "participants": [{ "type": "user", "userId": "<user-id>" }] }
    ]
  }
}
```

- Stage `type` is `review` or `approval`. Each stage needs one approval.
- Stage and participant IDs are generated when you omit them. Duplicate participants are dropped, a stage with no valid participants is removed, and a policy with no stages becomes `null`.
- `commentRequired` is always forced to `true`. `mode` accepts `normal` or `auto` and defaults to `normal`; nothing reads `auto` today.
- `executionPolicy: null` on update removes the policy.

Reviewers and approvers act with an ordinary update:

```json
PATCH /api/issues/{issueId}
{ "status": "done", "comment": "Reviewed. Tests pass." }
```

```json
PATCH /api/issues/{issueId}
{ "status": "in_progress", "comment": "Button alignment is off on mobile." }
```

The issue's current position is in `executionState` (`status`: `idle`, `pending`, `changes_requested` or `completed`, plus the current stage, participant and return assignee).

## The comment backstop

Separately from any policy, an agent run tied to an issue must leave a comment on it. If a run ends without one, the server wakes the agent once more with reason `missing_issue_comment`. The run's `issueCommentStatus` records the outcome: `not_applicable` (the default), `satisfied`, `retry_queued` or `retry_exhausted`.

Source: `packages/db/src/schema/heartbeat_runs.ts`, `server/src/services/heartbeat.ts`.
