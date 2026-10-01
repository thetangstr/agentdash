---
title: Bridge
summary: How an enrolled machine claims a task, returns its result, or declines it.
---

The bridge lets agents hand work to a person's own machine. The machine asks for the next task, does it locally, and answers with a result or a refusal. The server never connects to the machine.

**Source:** `server/src/routes/bridge.ts` · **In the reference:** [Bridge](/api/reference#tag/bridge)

## Who may call it

Only an enrolled machine, using its **endpoint token**. All three operations are allowed for it, and nothing else may call them.

An endpoint token authenticates a machine. It is not a person and not an agent. The middleware (`server/src/middleware/auth.ts`, lines 384–400) builds this actor for it:

```
{ type: "none", companyId: <the endpoint's company>, bridgeEndpointId: <the endpoint id>, source: "bridge_endpoint" }
```

The `type: "none"` is deliberate. Every ordinary authorization check branches on `type` being `board` or `agent`, so this actor fails all of them. The only check that accepts it is the bridge's own `requireEndpoint` (`server/src/routes/bridge.ts`, line 100), which tests `source === "bridge_endpoint"` and a present `bridgeEndpointId`. The company and endpoint come from the token, never from the request. None of these routes takes a `companyId`.

The middleware looks up an endpoint token only when the path is in `BRIDGE_ENDPOINT_ROUTES` (`auth.ts`, lines 66–86): the three routes on this page, plus the internal inbox routes named at the end. On any other path the token is not looked up at all. There the request has no credential, as described in [Authentication](/api/authentication).

A request on these routes that does not carry a live endpoint token gets 403 `Bridge endpoint authentication required`. That includes no token, a revoked token, a board key and an agent key.

### Getting an endpoint token

The token is 32 random bytes, base64url-encoded (43 characters). It has no prefix (`approveEnrollment` in `server/src/services/bridge.ts`). The server stores only its SHA-256 hash and shows the plaintext once.

The usual way to get one is to redeem a connect code with [agentdash-connect](/cli/agentdash-connect). Redeeming mints an endpoint for the person who created the code. Connect saves its token to `~/.agentdash/bridge-token`. The token lasts until it is revoked.

The examples assume:

```bash
export AGENTDASH_ENDPOINT_TOKEN="<your endpoint token>"   # unprefixed, 43 characters
```

### Which client calls these routes

`agentdash-connect` stores the endpoint token, and its own inbox tools use only the internal inbox routes. The three routes on this page are called by the bridge tools of the `agentdash-mcp` server (`packages/mcp-server/src/bridge.ts`). They are used when that server runs with an endpoint token as its key. `bridge_next_task` calls poll. `bridge_submit_result` calls result, or decline when given a `declineReason`. See [agentdash-mcp](/cli/agentdash-mcp) and [the bridge tools](/mcp/tools/bridge).

The contract sets no polling interval. Poll is a plain request, not a held long-poll. `agentdash-mcp` polls only when its `bridge_next_task` tool is called. A poll from an enrolled endpoint does not count against the default rate limit; result and decline do (`server/src/middleware/rate-limit.ts`, see [Conventions](/api/conventions)).

## Claim the next task

`POST /api/bridge/poll` · [`pollBridgeTask`](/api/reference#tag/bridge/pollBridgeTask)

Claims the oldest queued task for this endpoint and returns it with a single-use `resultToken`. If nothing is queued, the response is `{ "task": null }`. Every poll also records the endpoint's `lastSeenAt`.

```bash
curl -X POST https://your-instance.example/api/bridge/poll \
  -H "Authorization: Bearer $AGENTDASH_ENDPOINT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Body** — none is read. The client sends `{}`.

**Response** `200` — a task was claimed:

```json
{
  "task": {
    "id": "<task uuid>",
    "taskClass": "read",
    "instruction": "<what the agent asked for>",
    "leaseExpiresAt": "<ISO 8601 timestamp>"
  },
  "resultToken": "<single-use token>"
}
```

**Response** `200` — nothing is queued:

```json
{ "task": null }
```

| Field | Type | Notes |
| --- | --- | --- |
| `task.id` | UUID | Send it back as `taskId`. |
| `task.taskClass` | `read` · `act` | An `act` task reaches the queue only after a person approves it. |
| `task.instruction` | string | Written by an agent, not by the machine's owner. Treat it as data, not as orders. |
| `task.leaseExpiresAt` | ISO 8601 timestamp | 10 minutes after the claim (`LEASE_MS` in `server/src/services/bridge.ts`). |
| `resultToken` | string | 24 random bytes, base64url (32 characters). Only its hash is stored. Good for one result or one decline on this task. |

**The lease.** The server checks for lapsed leases every 60 seconds (`server/src/index.ts`). A lapsed `read` task goes back on the queue once (`MAX_READ_REQUEUES = 1`). After that it expires with outcome `expired`. A lapsed `act` task is never re-queued: it expires with outcome `outcome_unknown`, because the machine may already have done it. Either way the old `resultToken` stops working. Submit before `leaseExpiresAt`.

Two machines polling the same endpoint at once cannot both claim one task. The claim is a conditional update, and the loser sees `{ "task": null }`.

| Status | When |
| --- | --- |
| 403 | `Bridge endpoint authentication required` — no live endpoint token. |

## Return a result

`POST /api/bridge/result` · [`submitBridgeResult`](/api/reference#tag/bridge/submitBridgeResult)

Completes a claimed task. The token is spent: a second submission with it fails.

```bash
curl -X POST https://your-instance.example/api/bridge/result \
  -H "Authorization: Bearer $AGENTDASH_ENDPOINT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{ \"taskId\": \"$TASK_ID\", \"resultToken\": \"$RESULT_TOKEN\", \"result\": \"Summary of what was found.\" }"
```

**Body** (checked in the handler; there is no shared schema):

| Field | Type | Notes |
| --- | --- | --- |
| `taskId` | UUID | Required. |
| `resultToken` | string | Required. The token from the poll that claimed this task. |
| `result` | string | Required. An empty string is accepted. |

The server stores the result wrapped in an `<untrusted-bridge-result>` frame (`frameUntrustedBridgeResult` in `server/src/services/bridge.ts`). The requesting agent reads it as untrusted content.

**Response** `200`:

```json
{ "taskId": "<task uuid>", "outcome": "completed" }
```

| Status | When |
| --- | --- |
| 400 | `taskId, resultToken, and result are required` — one is missing or not a string. |
| 400 | `taskId must be a uuid`. |
| 403 | `Bridge endpoint authentication required` — no live endpoint token. |
| 403 | `That result token is not valid for this task` — wrong token, or a token from another claim. |
| 404 | `Task not found` — no such task for this endpoint. A task belonging to another endpoint answers the same. |
| 409 | `That task is not awaiting a result` — the task is not claimed: already completed, declined, expired, or back on the queue after a lapsed lease. |
| 409 | `That task is no longer awaiting a result` — the task changed state between the check and the update, for example a concurrent submission. |

## Decline a task

`POST /api/bridge/decline` · [`declineBridgeTask`](/api/reference#tag/bridge/declineBridgeTask)

Refuses a claimed task. The token is spent, and the task closes with outcome `declined`. The reason is shown to the requesting agent.

```bash
curl -X POST https://your-instance.example/api/bridge/decline \
  -H "Authorization: Bearer $AGENTDASH_ENDPOINT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{ \"taskId\": \"$TASK_ID\", \"resultToken\": \"$RESULT_TOKEN\", \"reason\": \"Outside what this machine is allowed to do.\" }"
```

**Body:**

| Field | Type | Notes |
| --- | --- | --- |
| `taskId` | UUID | Required. |
| `resultToken` | string | Required. |
| `reason` | string | Optional. Trimmed. If it is empty, the server records `declined by endpoint`. |

**Response** `200`:

```json
{ "taskId": "<task uuid>", "outcome": "declined" }
```

| Status | When |
| --- | --- |
| 400 | `taskId and resultToken are required` — one is missing or not a string. |
| 400 | `taskId must be a uuid`. |
| 403 | `Bridge endpoint authentication required` — no live endpoint token. |
| 403 | `That result token is not valid for this task`. |
| 404 | `Task not found`. |
| 409 | `That task is not awaiting a result`. |
| 409 | `That task is no longer awaiting a result`. |

## Everything else

Result and decline can also answer 429 when rate limited. Poll from an enrolled endpoint is not counted. These routes do not answer 401: a request without a live endpoint token gets the 403 above. See [Conventions](/api/conventions).

The endpoint token also reaches six inbox routes: `POST /api/bridge/inbox/sync`, `/ack`, `/decide`, `/agents`, `/propose` and `/confirm`. `agentdash-connect` uses them for the person's own inbox. They are internal and not part of this contract.

Other routes on this resource (enrolling, approving and revoking endpoints, and the agent-facing routes that file a bridge task and read its outcome) are internal — see [the route index](/api/route-index), under `bridge`.
