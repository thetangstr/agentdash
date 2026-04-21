# CUJ-15: Conversational Mode — Design Spec

**Date:** 2026-04-12
**Status:** Approved

---

## Summary

AgentDash agents are always autonomous. When an agent needs human input, it posts a question as an issue comment and pauses. The human replies in the comment thread, which wakes the agent with the reply in context. There is no separate "conversational mode" toggle — the conversational behavior is emergent.

**Key insight:** Paperclip already implements the full backend loop. Agent posts comment → human replies → assigned agent wakes with comment body in context (`buildPaperclipWakePayload`). This spec covers UI polish only.

## What Already Exists (No Changes Needed)

### Backend (Paperclip core)

1. **Agent posts comments**: After a successful heartbeat run, `buildHeartbeatRunIssueComment(resultJson)` extracts the summary and posts it via `issuesSvc.addComment()` (`heartbeat.ts:3276-3278`)

2. **Wake assigned agent on comment**: The standalone POST comment route wakes the assigned agent with reason `issue_commented`, including `commentId` and `wakeCommentId` in the context snapshot (`issues.ts:2066-2087`)

3. **Comment body in agent context**: `buildPaperclipWakePayload()` fetches comment text by ID, packages author info and body into a structured payload injected into the agent's prompt context (`heartbeat.ts:881-940`)

4. **@-mention wakeup**: Comments with @-mentions trigger additional wakeups with `issue_comment_mentioned` reason, bypassing issue execution lock (`issues.ts:2090-2122`, `heartbeat.ts:3698-3700`)

5. **Comment coalescing**: Multiple rapid comments are coalesced into a single wakeup via `mergeWakeCommentIds` (`heartbeat.ts:825-844`)

6. **WebSocket live events**: Real-time updates via `issue.comment_added` events (`live-events-ws.ts`)

### What This Spec Does NOT Change

- No new database tables or columns
- No new heartbeat statuses
- No `interactionMode` field on issues
- No new API endpoints
- No changes to the heartbeat loop, prompt builder, or wakeup system

## UI Changes

### 1. Chat-style comment rendering in CommentThread

**File:** `ui/src/components/CommentThread.tsx`

When rendering comments in the thread, visually distinguish agent vs. human comments:

- **Agent comments** (`authorAgentId` is set): Left-aligned with teal accent border/background. Show agent name and run number badge.
- **Human comments** (`authorUserId` is set): Right-aligned with gray background. Show user name.
- **System comments** (neither set): Centered, muted — existing behavior.

This is a CSS/styling change within the existing `CommentItem` render logic. The data model already carries `authorAgentId` and `authorUserId`.

### 2. "Waiting for reply" indicator

When all of the following are true:
- The issue has an `assigneeAgentId`
- The most recent comment is from an agent (`authorAgentId` is set)
- The issue status is not `done` or `cancelled`
- No heartbeat run is currently active for this issue

Show a pulsing indicator below the last comment: "Waiting for your reply..." with an amber dot.

This can be derived from existing data in `IssueDetail.tsx` — the component already has access to comments, issue status, and live run state.

### 3. First-location PATCH route: wake assigned agent on inline comment

**File:** `server/src/routes/issues.ts` (lines 1549-1575)

The PATCH issue route handles inline comments (comment posted alongside a status change). Currently it only wakes @-mentioned agents. Enhancement: also wake the `assigneeAgentId` if the comment author is not the assigned agent.

This aligns the PATCH route behavior with the standalone POST comment route, which already wakes the assigned agent.

**Change:** After the @-mention loop (line 1575), add:

```
if (issue.assigneeAgentId && 
    !(actor.actorType === "agent" && actor.actorId === issue.assigneeAgentId) &&
    !mentionedIds.includes(issue.assigneeAgentId)) {
  addWakeup(issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId: id, commentId: comment.id },
    ...
  });
}
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Separate mode toggle? | No | Agents are always autonomous; conversational behavior is emergent from questions |
| New heartbeat status? | No | Existing `succeeded` + wakeup flow handles it |
| New schema columns? | No | All needed data already exists |
| Chat UI location? | Inline in CommentThread | Reuses existing component, single timeline, minimal code |
| @-references in chat? | Deferred to v2 | Plain text covers 90% of use cases |
| One heartbeat = one turn? | Yes (already the case) | Natural execution boundary |
| Wake on any reply? | Yes (POST route already does this) | Only PATCH route needs alignment |

## Out of Scope

- `@file:path`, `@diff`, `@url:` reference resolution (v2)
- Standalone chat panel or tab-based UI
- `AdapterExecutionResult.question` structured rendering (choices/buttons) — the field exists but showing it as rich UI is a follow-up
- Mode toggle or `interactionMode` column

## Testing

1. Verify PATCH route wakes assigned agent on inline comment (unit test)
2. Verify chat-style rendering shows agent comments left-aligned, human comments right-aligned (visual)
3. Verify "waiting for reply" indicator appears when agent's comment is latest (visual)
