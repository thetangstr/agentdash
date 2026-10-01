---
title: "Assistant toolset"
summary: "The person-facing toolset a cloud assistant relays to a person, filtered by the grant's OAuth scopes."
---

> Generated at commit `c69c37f49` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

**19 tools** — measured: the length of the `tools/list` response. Source: `buildToolSurface(client, config, "assistant")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/assistant/tools.ts`, `src/assistant/work.ts` and `src/assistant/gated.ts`.

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Over `POST /api/mcp/assistant` the grant's scopes filter this list (`src/assistant/index.ts`): the read tools are always served, the work tools only with `agentdash:work`, the gated tools only with `agentdash:decide`. Over stdio no scopes apply and all 19 are served. Which tool needs which scope is measured by listing the surface with each scope set.

Tools, in the order `tools/list` returns them: `whoami`, `whats_new`, `list_projects`, `get_project`, `find_work`, `get_work_item`, `explain_blocker`, `list_team`, `list_pending_decisions`, `ross_request_status`, `start_project`, `create_work_item`, `assign_work`, `comment_on_work`, `update_work_item`, `request_ross_assessment`, `prepare_decision`, `request_hire`, `confirm_action`.

## Read tools — every grant (`agentdash:read`)

10 tools.

### `whoami`

AgentDash: who you are connected as, which company, and what you may do.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

No input.

### `whats_new`

AgentDash: what changed since a time. Finished work with PRs, what is blocked now and what became blocked, and decisions waiting for you. Start here for "what happened".

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `since` | string | no |  |
| `project` | string | no | A project name or id — identifier, title fragment, UUID or deep link |
| `format` | `"summary"` \| `"briefing"` | no |  |

### `list_projects`

AgentDash: the company's projects with a one-line status each.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `status` | `"active"` \| `"all"` | no |  |

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
| `query` | string | no |  |
| `status` | `"backlog"` \| `"todo"` \| `"in_progress"` \| `"in_review"` \| `"blocked"` \| `"done"` \| `"cancelled"` | no |  |
| `agent` | string | no | A person or agent — identifier, title fragment, UUID or deep link |
| `project` | string | no | A project — identifier, title fragment, UUID or deep link |
| `limit` | integer | no |  |

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
| `limit` | integer | no |  |

### `ross_request_status`

AgentDash: whether Ross has answered a request made with request_ross_assessment — answered, still pending, stale, or refused, with the answer when there is one.

Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`, `readOnlyHint: true`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |
| `requestKey` | string | yes | The requestKey request_ross_assessment returned |

## Work tools — grants with `agentdash:work`

6 tools.

### `start_project`

AgentDash: create a project with a goal, and a kickoff task for its lead (default: the Chief of Staff) to plan and staff it.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | The project's name, as the person said it |
| `goal` | string | no |  |
| `lead` | string | no | The agent to lead it — identifier, title fragment, UUID or deep link |
| `dueDate` | string | no |  |

### `create_work_item`

AgentDash: file a task and, optionally, assign it to an agent by name. Check find_work first to avoid duplicates.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | The task title, as the person said it |
| `description` | string | no |  |
| `project` | string | no | A project — identifier, title fragment, UUID or deep link |
| `assignee` | string | no | An agent — identifier, title fragment, UUID or deep link |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no |  |

### `assign_work`

AgentDash: give an existing task to a different agent, or nudge the current owner to pick it up now.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |
| `agent` | string | no | The agent to give it to — identifier, title fragment, UUID or deep link |

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
| `status` | `"todo"` \| `"in_progress"` \| `"done"` \| `"cancelled"` \| `"backlog"` | no |  |
| `priority` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | no |  |
| `title` | string | no |  |
| `project` | string | no | A project — identifier, title fragment, UUID or deep link |

### `request_ross_assessment`

AgentDash: ask Ross, the task's assigned agent, a question about a task. Posts one request comment in the person's name; the answer arrives later — check it with ross_request_status.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | The task — identifier, title fragment, UUID or deep link |
| `question` | string | yes | The person's question for Ross, in their words |
| `requestKey` | string | no |  |

## Gated tools — grants with `agentdash:decide`

3 tools.

### `prepare_decision`

AgentDash: get ready to approve, reject, or send back a pending decision. Returns the exact sentence to read the person and a one-time handle — nothing happens until confirm_action.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `approval` | string | yes | Which pending decision — its id or what it is about |
| `decision` | `"approve"` \| `"reject"` \| `"request_changes"` | yes | What the person wants to do with it |
| `note` | string | no |  |

### `request_hire`

AgentDash: get ready to ask for a new agent — a role and why. Returns a read-back and a one-time handle; nothing is filed until confirm_action.

Annotations: `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `workforceTemplateId` | `"marketing-content"` \| `"sales-support"` | no |  |
| `role` | string | yes | What kind of agent — designer, QA, whatever the person asked for |
| `reason` | string | yes | Why they are needed — the approver reads this |
| `project` | string | no | A project — identifier, title fragment, UUID or deep link |
| `nameHint` | string | no |  |

### `confirm_action`

AgentDash: carry out an action the person has just agreed to, using the handle from prepare_decision or request_hire. Call it ONLY after they hear the read-back and say yes. The handle works once.

Annotations: `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: false`, `readOnlyHint: false`. Declares an output schema.

| Property | Type | Required | Description |
|---|---|---|---|
| `handle` | string | yes | The handle prepare_decision or request_hire returned |
| `personSaid` | string | no |  |
