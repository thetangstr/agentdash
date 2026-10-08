---
title: Human control
summary: A named person's board key discovers, reads, prepares and confirms a finite set of versioned operations.
---

Human control lets a person act through their own board key — usually from a local MCP client — using a fixed list of versioned operations instead of arbitrary API calls. Reads answer directly; every change is prepared first, shown back to the person in full, and runs only when its single-use handle is confirmed.

**Source:** `server/src/routes/human-control.ts` and `server/src/services/human-control.ts` · **In the reference:** [Human control](/api/reference#tag/human-control)

## Who may call it

Every operation takes a **named, verified, unexpired board key** and nothing else. A session cookie, an assistant grant, an agent key, an agent run token and the implicit local operator are all refused with 403 `Named board-key human authentication required` (`capture()` in `server/src/services/human-control.ts:69-73`, and again in `server/src/services/human-control/authority.ts:332`). A request with no credential gets the same 403, not a 401. On the four `POST` operations the body is parsed first, so an invalid body answers 400 `Validation error` before any credential check.

The key carries no extra authority here. Each operation still checks the person's current company membership and the permission its action needs, as the matching page in the web app would. Choosing a target grants nothing. How to get a board key is on [API keys](/api/api-keys); how the server resolves it is on [Authentication](/api/authentication).

## The flow

1. **Identity.** `GET /identity` confirms who the key acts as and lists the targets you may pick.
2. **Discover.** `POST /discover` with one of those targets lists the operations you may run on it, each with its version and input and output JSON schemas.
3. **Read.** `POST /read` runs a read operation and returns its result. Nothing changes.
4. **Prepare.** `POST /prepare` resolves a write operation without running it. It returns a complete readback and a handle. Show the readback to the person.
5. **Confirm.** Once the person agrees, `POST /confirm` with the same target and the handle runs the action exactly once.

Send the same `target` on every call. A handle stays bound to the target it was prepared on.

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## Get the identity

`GET /api/human-control/identity` · [`getHumanControlIdentity`](/api/reference#tag/human-control/getHumanControlIdentity)

```bash
curl https://your-instance.example/api/human-control/identity \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` (`global()` in `server/src/services/human-control/authority.ts`):

| Field | Type | Notes |
| --- | --- | --- |
| `source` | `"board_key"` | Always. |
| `user` | `{ id, name, email }` | The person the key acts as. |
| `isInstanceAdmin` | boolean | |
| `memberships` | array of `{ companyId, membershipRole, status }` | Active memberships only. |
| `companies` | array of `{ id, name }` | Your companies; an instance admin gets every company. |
| `targets` | array of target objects | `{ "kind": "self" }`, `{ "kind": "instance" }`, `{ "kind": "public" }`, then one `{ "kind": "company", "companyId": … }` per company. |

| Status | When |
| --- | --- |
| 401 | `Unauthorized` — the key was revoked or expired, or its user removed, while the request ran (`server/src/services/current-board-identity.ts`). |
| 403 | `Named board-key human authentication required` — not a board key (`server/src/services/human-control.ts:71`). |
| 403 | `Human connection is no longer authorized` — the key's user no longer resolves (`server/src/services/human-control/authority.ts:339`). |
| 409 | `Current authority changed during acceptance` — your companies changed while the request ran (`authority.ts:344`). |

## Discover operations

`POST /api/human-control/discover` · [`discoverHumanOperations`](/api/reference#tag/human-control/discoverHumanOperations)

```bash
curl -X POST https://your-instance.example/api/human-control/discover \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "target": { "kind": "company", "companyId": "'"$COMPANY_ID"'" } }'
```

**Body** (`humanDiscoverRequestSchema`, strict — unknown fields are refused):

| Field | Type | Notes |
| --- | --- | --- |
| `target` | target object | Required. `{ kind: "company", companyId }` (UUID), or `{ kind: "self" }`, `{ kind: "instance" }`, `{ kind: "public" }`. |
| `pageId` | `workforce` · `inbox` | Optional. Only operations for that page. |
| `cursor` | string, at most 100 characters | Optional. The `nextCursor` of the previous page. |
| `limit` | integer 1–100 | Optional, default 100. |

**Response** `200` — `{ target, operations, nextCursor }`. `operations` holds only the operations you may run now. `nextCursor` is `null` on the last page; otherwise pass it back as `cursor`. Every operation is company-targeted, so the other target kinds return an empty list today.

Each entry in `operations` (`HumanOperationDescriptor` in `packages/shared/src/human-control.ts`):

| Field | Type | Notes |
| --- | --- | --- |
| `operationId` | string | For example `task_recovery.remediate`. |
| `version` | `1` | |
| `pageId` | `workforce` · `inbox` | The web app page the action belongs to. |
| `actionId` | string | |
| `targetKind` | `company` · `self` · `instance` · `public` | |
| `behavior` | `read` · `prepare_confirm` | `read`: call `/read`. `prepare_confirm`: call `/prepare`, then `/confirm`. |
| `authority` | `company_access` · `company_direction` · `exact_question_owner` · `current_accountable_human` · `agent_management` | The kind of permission the operation checks. |
| `confirmation` | `none` · `human_readback` | |
| `inputSchema`, `outputSchema` | JSON schema | The operation's exact input and output. Use these, not guesses. |
| `content` | `{ fullText: true, pagination: "none" \| "cursor" \| "offset" }` | |

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `Unknown discovery cursor` — `cursor` is not an operation on the current list (`server/src/services/human-control.ts:197`). |
| 401 | `Unauthorized` — the key stopped resolving while the request ran. |
| 403 | `Named board-key human authentication required` — not a board key. |
| 403 | `Human connection is no longer authorized` — the key's user no longer resolves. |
| 403 | `Company access denied` — a company target that is not one of your companies (`server/src/services/human-control.ts:188`). |
| 409 | `Current authority changed during acceptance`. |

### The operations

There are 24, all version 1 and company-targeted (`HUMAN_OPERATION_IDS` in `packages/shared/src/human-control.ts`; registered in `server/src/services/human-control/`). Discovery shows only the ones you may run.

| Area | Read (`/read`) | Write (`/prepare`, then `/confirm`) |
| --- | --- | --- |
| Workforce | `workforce.templates.list`, `workforce.brief.read`, `workforce.proposals.list`, `workforce.enrollment.read`, `workforce.readiness.read` | `workforce.brief.publish`, `workforce.proposals.review`, `workforce.enrollment.create`, `workforce.enrollment.update`, `workforce.learning.acknowledge`, `workforce.skills.retry`, `workforce.first_job.start` |
| Questions for a person | `human_questions.pending.list`, `human_questions.read` | `human_questions.respond`, `human_questions.cancel`, `human_questions.replace` |
| Inactive question owner recovery | `human_questions.recovery.list` (issueId; safe IDs/state/receipt only) | `human_questions.recovery.cancel` (issueId, interactionId; exact active current accountable human) |
| Agent owners | — | `human_questions.owner.assign`, `human_questions.stewardship.assign`, `human_questions.stewardship.transfer` |
| Task recovery | `task_recovery.exhausted.read` | `task_recovery.remediate` |

`task_recovery.remediate` lets exactly one run go ahead on an issue whose automatic recovery budget is spent. It needs authority over the issue's assignee agent, not just visibility of the issue. The marker is never cleared. See `doc/HUMAN-CONTROL.md` for the permit lifecycle.

## Run a read operation

`POST /api/human-control/read` · [`readHumanOperation`](/api/reference#tag/human-control/readHumanOperation)

```bash
curl -X POST https://your-instance.example/api/human-control/read \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "target": { "kind": "company", "companyId": "'"$COMPANY_ID"'" },
    "operationId": "task_recovery.exhausted.read",
    "version": 1,
    "input": { "issueId": "'"$ISSUE_ID"'" }
  }'
```

**Body** (`humanOperationRequestSchema`, strict):

| Field | Type | Notes |
| --- | --- | --- |
| `target` | target object | Required. As for discover. |
| `operationId` | one of the 24 operation ids | Required. |
| `version` | `1` | Required. |
| `input` | object | Required. Validated against the operation's own strict input schema (its `inputSchema` from discovery). |

**Response** `200` — the operation's result, shaped by its `outputSchema`. There is no envelope.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body, or `input`, fails its schema. |
| 400 | `This operation requires prepare and confirm` — a write operation (`server/src/services/human-control.ts:205`). |
| 400 | `Operation does not support this target kind` — a target that is not a company (`human-control.ts:83`). |
| 401 | `Unauthorized` — the key stopped resolving while the request ran. |
| 403 | `Named board-key human authentication required` — not a board key. |
| 403 | `User does not have access to this company` — not a member (`server/src/routes/authz.ts:190`, called from `authority.ts:379`). |
| 404 | `Company not found` (`authority.ts:382`). |
| 409 | `Current authority changed during acceptance` (`authority.ts:36`). |
| varies | The operation's own refusals pass through unchanged. For example, the task-recovery operations answer 403 `Active named company membership required` (`authority.ts:238`) and 404 `Issue not found` (`server/src/services/human-control/task-recovery.ts:54`). |

## Prepare a write operation

`POST /api/human-control/prepare` · [`prepareHumanOperation`](/api/reference#tag/human-control/prepareHumanOperation)

Resolves the action and records it, but does not run it.

```bash
curl -X POST https://your-instance.example/api/human-control/prepare \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "target": { "kind": "company", "companyId": "'"$COMPANY_ID"'" },
    "operationId": "task_recovery.remediate",
    "version": 1,
    "input": { "issueId": "'"$ISSUE_ID"'", "outcomeCriteria": "The failing build passes", "expiresInMinutes": 15 }
  }'
```

**Body** — the same `humanOperationRequestSchema` as read. In this example `expiresInMinutes` is the task-recovery permit's lifetime (1–120, default 15, `server/src/services/human-control/task-recovery.ts:30`), not the handle's.

**Response** `200` (`server/src/services/human-control.ts:219-220`, `server/src/services/human-action-handles.ts:37`):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | The action id. It appears again as `actionId` on confirm. |
| `handle` | string | Opaque and secret. Shown only here. Send it to confirm. |
| `expiresAt` | ISO 8601 timestamp | 15 minutes after preparation. |
| `confirmation` | `"human_readback"` | |
| `target`, `operationId`, `version` | | As sent. |
| `readback` | `{ target, company, input, context }` | What will happen. `company` is `{ id, name }` or `null`; `input` is the resolved payload; `context` holds the operation's own detail, such as the agent affected and the effects. Show all of it to the person before confirming. |

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body, or `input`, fails its schema. |
| 400 | `Read operations cannot be prepared` — a read operation (`server/src/services/human-control.ts:214`). |
| 400 | `Operation does not support this target kind` — a target that is not a company (`human-control.ts:83`). |
| 401 | `Unauthorized` — the key stopped resolving while the request ran. |
| 403 | `Named board-key human authentication required` — not a board key. |
| 403 | `User does not have access to this company` — not a member. |
| 404 | `Company not found`. |
| 409 | `Current authority changed during acceptance`. |
| varies | The operation's own refusals pass through. For example, `task_recovery.remediate` answers 409 `Issue recovery budget is not exhausted; there is nothing to remediate.` (`task-recovery.ts:208`). |

## Confirm a prepared operation

`POST /api/human-control/confirm` · [`confirmHumanOperation`](/api/reference#tag/human-control/confirmHumanOperation)

Send this only after the person has seen the readback and agreed.

```bash
curl -X POST https://your-instance.example/api/human-control/confirm \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "target": { "kind": "company", "companyId": "'"$COMPANY_ID"'" }, "handle": "'"$HANDLE"'" }'
```

**Body** (`humanConfirmRequestSchema`, strict):

| Field | Type | Notes |
| --- | --- | --- |
| `target` | target object | Required. The target the handle was prepared on. |
| `handle` | string, 32–128 characters | Required. |
| `personSaid` | string, at most 4000 characters | Optional. Accepted but not used by this service. It is not proof of consent. |

The operation and its input come from the handle, not the body. Before running, the server re-resolves the operation and compares its preconditions with the ones recorded at prepare. Attribution is the person whose key sent the confirm.

**Response** `200` — `{ status: "completed", actionId, result }`. `result` is the operation's output, read back after the action committed.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 401 | `Unauthorized` — the key stopped resolving while the request ran. |
| 403 | `Named board-key human authentication required` — not a board key. |
| 404 | `Human action handle not found` — no handle matches, or it was prepared by another person, another key or on another target (`server/src/services/human-action-handles.ts:46`). |
| 409 | `Human action is no longer executable` — the handle was already used, refused or expired. `details` carries its state (below) (`server/src/services/human-control.ts:228`). |
| 409 | `Human action preconditions changed` — something the action depends on changed since prepare. The handle is spent; prepare again (`human-control.ts:234`, `:247`). |
| 409 | `Human action already claimed` — another confirm won the claim, or the handle expired in between (`human-control.ts:240`). |
| 409 | `Human action was not applied; prepare it again` — the database rolled the action back. `details: { status: "stale", actionId }` (`human-control.ts:277`). |
| 409 | `Human action requires recovery; inspect the canonical resource before retrying` — the outcome is uncertain. See Refusals and recovery below (`human-control.ts:284`). |
| varies | Any refusal read or prepare can give — membership, company, or the operation's own — raised on the re-check before the claim, or as a 400, 401, 403, 404, 409 or 422 during execution before commit, passes through. The handle is then spent: `denied` for 401 or 403, `stale` otherwise (`human-control.ts:237`, `:279-281`). |

## Handles

From `server/src/services/human-action-handles.ts` and the `human_action_handles` table (`packages/db/src/migrations/0141_human_action_handles.sql`).

- **Random and hashed at rest.** A handle is 32 random bytes, base64url-encoded (line 27). Only its SHA-256 hash is stored (`hashBearerToken`, `server/src/services/board-auth.ts:19-20`). The plain handle exists only in the prepare response.
- **Bound.** Lookup matches the hash together with the person, the board key and the target (kind and company) (lines 40-45). Anything else answers 404. The row also records the operation, its version, the resolved payload and the preconditions, and confirm runs exactly those.
- **Short-lived.** A handle expires 15 minutes after prepare (line 29). An expired handle is marked `expired` and its payload cleared on its next lookup.
- **Single use, claimed before execution.** Confirm claims the handle atomically — one update from `prepared` to `recovery_required`, only while unexpired (lines 56-57) — before it runs anything. A second confirm loses the claim. The claimed state means a crash mid-action can never make the handle runnable again.
- **States.** `prepared`, `completed`, `denied`, `stale`, `expired`, `recovery_required` (the table's status check).
- **Swept.** The server sweeps handles when it starts and then every hour (`server/src/index.ts:1123`). The sweep expires prepared handles past their time and clears their payload. It deletes `completed`, `denied`, `stale` and `expired` rows one day after expiry, and `recovery_required` rows seven days after expiry (lines 17-18, 63-76).

A completed handle proves only that prepare and confirm came from the same key. It is not evidence that the person consented.

## Refusals and recovery

A refused confirm on a handle that is no longer `prepared`, and the uncertain-outcome 409, carry `details`:

```json
{
  "error": "Human action requires recovery; inspect the canonical resource before retrying",
  "details": { "status": "recovery_required", "actionId": "…", "result": { "reference": { "issueId": "…" } } }
}
```

| Field | Notes |
| --- | --- |
| `status` | The handle's state: `completed`, `denied`, `stale`, `expired` or `recovery_required`. |
| `actionId` | The id returned by prepare. |
| `result.reference` | Optional. One or more of `issueId`, `interactionId`, `enrollmentId` — the resource to inspect. Present only when the operation supports it and you can still see that resource. Cached results are never returned (`terminalDetails` in `server/src/services/human-control.ts:113-136`). |

**`recovery_required` means the action may or may not have taken effect.** The server claimed the handle and started, then could not confirm the outcome. Do this:

1. **Read back** the current state of the referenced resource with a read operation — for task recovery, `task_recovery.exhausted.read` on the issue, and look at its pending permit.
2. **Report** what you find to the person.
3. **Never replay the confirm.** The handle cannot run twice, so a replay only answers 409 `Human action is no longer executable`. If the action did not happen, prepare a new one.

For the other refused states: `stale` and `expired` mean prepare again against the current state; `denied` means you lost the permission the action needs.

## Everything else

Any operation can also answer 401 when the credential stops resolving and 429 when rate limited — see [Conventions](/api/conventions). All four `POST` operations, reads included, count toward the state-changing rate limit. On these routes a server fault never echoes its cause: a 5xx error answers `Private human operation failed`, and any other unexpected exception answers 500 `Internal server error` (`server/src/middleware/error-handler.ts`, `isPrivateHumanInputRoute` in `server/src/middleware/redact-sensitive.ts`).

The same operations are available over MCP: `AGENTDASH_TOOLSET=human` exposes matching tools — see [the human toolset](/mcp/tools/human) and [Toolsets](/mcp/toolsets).

Other routes on this resource (the recovery-run preview and authorize routes, which the web app uses) are internal — see [the route index](/api/route-index), under `human-control`.

### Recover an inactive question owner

Safe recovery discovery works independently of readiness, including when private-source readiness returns 404. Only the exact active current accountable human with current company, issue and project access receives recovery metadata; being an administrator is insufficient. The original pinned owner must remain inactive at confirmation. Readbacks contain no original prompt, answer, title or source content.

Prepare and confirm `human_questions.recovery.cancel`, then use the existing `human_questions.replace` operation and answer the replacement genuinely. Cancellation persists the canonical cancelled interaction and attributed activity receipt, keeps required input holding the same task, and creates no continuation. The replacement answer uses the ordinary continuation path. Reactivation, changed accountability or revoked access refuses a stale confirmation.

The web workforce panel uses the same operations through session `GET /api/human-control/issues/:issueId/question-recovery` and `POST .../preview` / `POST .../confirm`. Preview takes `{ interactionId, action: "cancel" | "replace" }`; confirm adds the exact returned `preconditions`. A session cancellation receipt is the persisted interaction, not a board-key handle. If acknowledgment is lost, read current state; never replay a mutation. This addition covers this recovery slice only; historical transport proof counts remain historical.
