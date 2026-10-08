---
title: "Assistant toolset"
summary: "The person-facing toolset a cloud assistant relays to a person, filtered by the grant's OAuth scopes."
---

> Generated at commit `92bec8fe1` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.
> 2 tools omitted: engagement-specific.

**19 tools** — measured: the length of the `tools/list` response; 17 are documented here and 2 are omitted as engagement-specific. Source: `buildToolSurface(client, config, "assistant")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/assistant/tools.ts`, `src/assistant/work.ts` and `src/assistant/gated.ts`.

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Over `POST /api/mcp/assistant` the grant's scopes filter this list (`src/assistant/index.ts`): the read tools are always served, the work tools only with `agentdash:work`, the gated tools only with `agentdash:decide`. Over stdio no scopes apply and all 19 are served. Which tool needs which scope is measured by listing the surface with each scope set.

Tools documented here, in the order `tools/list` returns them: `whoami`, `whats_new`, `list_projects`, `get_project`, `find_work`, `get_work_item`, `explain_blocker`, `list_team`, `list_pending_decisions`, `start_project`, `create_work_item`, `assign_work`, `comment_on_work`, `update_work_item`, `prepare_decision`, `request_hire`, `confirm_action`.

## Read tools — every grant (`agentdash:read`)

9 tools; 1 omitted: engagement-specific.

### `whoami`

AgentDash: who you are connected as, which company, and what you may do.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

No input.

### `whats_new`

AgentDash: what changed since a time. Finished work with PRs, what is blocked now and what became blocked, and decisions waiting for you. Start here for "what happened".

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `since` | string | no | ISO 8601 timestamp, a duration like "12h" or "30m", or "last_check" |
| `project` | string | no | A project name or id — identifier, title fragment, UUID or deep link |
| `format` | `"summary"` \| `"briefing"` | no | "briefing" returns the short sourced briefing as the summary |

### `list_projects`

AgentDash: the company's projects with a one-line status each.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `status` | `"active"` \| `"all"` | no | "active" (default) hides archived and completed projects |

### `get_project`

AgentDash: how one project is going. Progress, who is on it, what is blocked, and what shipped.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `project` | string | yes | The project — identifier, title fragment, UUID or deep link |

### `find_work`

AgentDash: find tasks by words, status, person or project. Use before creating a task, to avoid duplicates.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `query` | string | no | Words to match in the title or identifier |
| `status` | `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"blocked"` \| `"done"` \| `"cancelled"` | no | Task status filter |
| `agent` | string | no | A person or agent — identifier, title fragment, UUID or deep link |
| `project` | string | no | A project — identifier, title fragment, UUID or deep link |
| `limit` | integer | no | Minimum: 1. Maximum: 25. |

### `get_work_item`

AgentDash: one task's current state. Status, owner, latest update, linked PRs and pending decisions.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |

### `explain_blocker`

AgentDash: why a task is blocked or stalled, and what would unblock it (often a decision from you).

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The blocked task — identifier, title fragment, UUID or deep link |

### `list_team`

AgentDash: the company's agents, what each is working on, and whether they are running, idle or paused.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

No input.

### `list_pending_decisions`

AgentDash: approvals and questions waiting on you, plus open tasks assigned to you, most urgent first.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Minimum: 1. Maximum: 10. |

## Work tools — grants with `agentdash:work`

5 tools; 1 omitted: engagement-specific.

### `start_project`

AgentDash: create a project with a goal, and a kickoff task for its lead (default: the Chief of Staff) to plan and staff it.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | The project's name, as the person said it |
| `goal` | string | no | What the project is for — becomes the project description and the kickoff task's brief |
| `lead` | string | no | Who leads it — omit for the Chief of Staff, or say "best fit" |
| `dueDate` | string | no | Target date (ISO 8601, e.g. 2026-10-31) |

### `create_work_item`

AgentDash: file a task and, optionally, assign it to an agent by name. Check find_work first to avoid duplicates.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | The task title, as the person said it |
| `description` | string | no | Details the assignee needs |
| `project` | string | no | The project it belongs to |
| `assignee` | string | no | Which agent should do it — a name, or "best fit" for the Chief of Staff |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no | Task priority |

### `assign_work`

AgentDash: give an existing task to a different agent, or nudge the current owner to pick it up now.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |
| `agent` | string | no | Who gets it — a name or "best fit" for the Chief of Staff; omit to nudge the current owner |

### `comment_on_work`

AgentDash: post the person's instruction or answer on a task. The assigned agent reads it on its next run.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |
| `text` | string | yes | What to say, in the person's voice |

### `update_work_item`

AgentDash: change a task's status, priority, title or project. Cancelling is reversible by reopening.

Annotations: `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |
| `status` | `"todo"` \| `"in_progress"` \| `"done"` \| `"cancelled"` \| `"backlog"` | no | New status — todo, in_progress, done, cancelled or backlog |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no | New priority |
| `title` | string | no | New title |
| `project` | string | no | Move it to this project |

## Gated tools — grants with `agentdash:decide`

3 tools.

### `prepare_decision`

AgentDash: get ready to approve, reject, or send back a pending decision. Returns the exact sentence to read the person and a one-time handle — nothing happens until confirm_action.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `approval` | string | yes | Which pending decision — its id or what it is about |
| `decision` | `"approve"` \| `"reject"` \| `"request_changes"` | yes | What the person wants to do with it |
| `note` | string | no | An optional note attached to the decision |

### `request_hire`

AgentDash: get ready to ask for a new agent — a role and why. Returns a read-back and a one-time handle; nothing is filed until confirm_action.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `workforceTemplateId` | `"marketing-content"` \| `"sales-support"` | no | Explicit workforce catalog selection; omit for custom or ambiguous roles. Requires company admin authority. |
| `role` | string | yes | What kind of agent — designer, QA, whatever the person asked for |
| `reason` | string | yes | Why they are needed — the approver reads this |
| `project` | string | no | The project the hire is for |
| `nameHint` | string | no | A name for the agent, if the person gave one |

### `confirm_action`

AgentDash: carry out an action the person has just agreed to, using the handle from prepare_decision or request_hire. Call it ONLY after they hear the read-back and say yes. The handle works once.

Annotations: `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `handle` | string | yes | The handle prepare_decision or request_hire returned |
| `personSaid` | string | no | What the person said, in their words — recorded in the audit trail |
