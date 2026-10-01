---
title: Approvals
summary: Requests that wait on a person — list, read, file and decide them.
---

An approval is a request that waits on a person: an agent asks to hire another agent, to go past a budget, to send through a connector, or to go ahead with a plan. These operations list and read a company's approvals, file a new one, and approve, reject or send one back for revision.

**Source:** `server/src/routes/approvals.ts` · **In the reference:** [Approvals](/api/reference#tag/approvals)

## Who may call it

| Operation | Who |
| --- | --- |
| `listApprovals`, `getApproval`, `createApproval` | a person who is a member, or an agent in that company |
| `approveApproval`, `rejectApproval`, `requestApprovalRevision` | a person (board key or session) who may decide this approval (below) — an agent gets 403 `Board access required` |

Every call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write.

An approval requested by an agent you cannot see is invisible to you: it is left out of the list, and reading it answers 404 (`server/src/routes/visibility.ts`; see [Conventions](/api/conventions)).

### Who may decide

In most companies, any member who reaches the company may approve, reject or request a revision. Two rules narrow that:

- **Agent hires.** Approving or rejecting a `hire_agent` approval that is still open creates, activates or ends an agent, so it needs the `agents:create` permission in the company. Instance admins and the local operator pass.
- **Single-decider companies.** Some product profiles give each approval exactly one decider and require `revision`, `idempotencyKey` and `channel` on every approve and reject. There, a caller who is not the decider gets 403, and a missing field gets 400 naming it (`server/src/services/approval-authority.ts`).

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List approvals

`GET /api/companies/{companyId}/approvals` · [`listApprovals`](/api/reference#tag/approvals/listApprovals)

The company's approvals, in no guaranteed order. `status` filters to one status, such as `pending`.

```bash
curl "https://your-instance.example/api/companies/$COMPANY_ID/approvals?status=pending" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `Approval` (below).

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |

## Get an approval

`GET /api/approvals/{id}` · [`getApproval`](/api/reference#tag/approvals/getApproval)

```bash
curl https://your-instance.example/api/approvals/$APPROVAL_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `Approval`.

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Approval not found` — no such approval, or it was requested by an agent you cannot see. |

## Request an approval

`POST /api/companies/{companyId}/approvals` · [`createApproval`](/api/reference#tag/approvals/createApproval)

Files a `pending` approval. An agent files it on its own behalf: `requestedByAgentId` defaults to the calling agent, and naming another agent answers 403. A person who files one is recorded as `requestedByUserId`.

```bash
curl -X POST https://your-instance.example/api/companies/$COMPANY_ID/approvals \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "type": "request_board_approval", "payload": { "summary": "Publish the Q3 market report" }, "issueIds": ["'"$ISSUE_ID"'"] }'
```

**Body** (`createApprovalSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `hire_agent` · `approve_ceo_strategy` · `budget_override_required` · `request_board_approval` · `mandate_violation` · `connector_send` · `inbound_content_review` · `deliverable_review` · `workflow_recommendation` | Required. |
| `payload` | object | Required. Its shape depends on `type`; the schema accepts any object. |
| `requestedByAgentId` | UUID or null | Optional. An agent may only name itself. |
| `issueIds` | array of UUID | Optional. Issues to link the approval to. |

Two types have their payload checked:

- **`hire_agent`.** The payload may not set `autoProvisionDefaultKey`, and may not put keys ending in `command` under `adapterConfig.workspaceStrategy`. Only an instance admin may set a custom command, arguments, environment, working directory or host path in its adapter config. Environment bindings in `adapterConfig.env` are checked as secrets are (`server/src/services/secrets.ts`).
- **`connector_send`.** The payload must name a connector that can carry out the send: `provider` must be one in `CONNECTOR_SEND_PROVIDERS` (`packages/shared/src/validators/approval.ts`), with a valid `objectType`, `operation`, `objectId` for an update, and a `properties` object.

**Response** `201` — the new `Approval`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `Hire approval payloads must not set autoProvisionDefaultKey…` — a `hire_agent` payload sets that field. |
| 403 | `An agent can only request approvals on its own behalf` — an agent named another agent in `requestedByAgentId`. |
| 403 | `Agent hire payloads cannot carry host-executed workspace commands (…)` — a `hire_agent` payload carries a `…command` key under `adapterConfig.workspaceStrategy`. |
| 403 | `Instance admin access required to set a custom command, arguments, environment, working directory or host path for an agent adapter (…)` — a `hire_agent` payload sets one of those fields, and the caller is not an instance admin. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Issue not found` — an id in `issueIds` is an issue you cannot see. |
| 422 | `details.code: "connector_send_<problem>"` — a `connector_send` payload no connector can carry out. `<problem>` is `teams_not_supported`, `provider_missing`, `provider_unsupported`, `object_type_invalid`, `operation_invalid`, `object_id_required` or `properties_invalid`. `details.supportedProviders` lists the providers that work. |
| 422 | `Invalid environment variable name: <key>`, `Invalid environment binding for key: <key>`, and similar — a `hire_agent` payload's `adapterConfig.env` fails the secret-binding checks. |

The issues are linked after the approval is written. If an id in `issueIds` does not exist, the call answers 404 `One or more issues not found`, and an issue in another company answers 422 `Issue and approval must belong to the same company` — but in both cases the approval has already been created.

## Approve an approval

`POST /api/approvals/{id}/approve` · [`approveApproval`](/api/reference#tag/approvals/approveApproval)

Approves a `pending` or `revision_requested` approval, then runs what the approval was for. Approving a `hire_agent` approval creates the agent from the payload, or activates the pending agent the payload names in `agentId`, and sets its monthly budget if the payload's `budgetMonthlyCents` is above zero.

Approving an approval that is already approved returns it unchanged. With an `idempotencyKey`, sending the same decision again returns the first result and does nothing more.

```bash
curl -X POST https://your-instance.example/api/approvals/$APPROVAL_ID/approve \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "decisionNote": "Approved. Keep the budget under review.", "revision": 1, "idempotencyKey": "approve-'"$APPROVAL_ID"'-1", "channel": "web" }'
```

**Body** (`resolveApprovalSchema`, every field optional):

| Field | Type | Notes |
| --- | --- | --- |
| `decisionNote` | string or null | Stored on the approval. |
| `revision` | integer ≥ 1 | The `revision` you were shown. If it no longer matches, the call answers 409. Required in single-decider companies. |
| `idempotencyKey` | string, 8–200 characters | Makes a retried decision safe. Unique per company. Required in single-decider companies. |
| `channel` | `web` · `telegram` · `teams` · `whatsapp` · `bridge_inbox` · `assistant` | Where the decision was taken; defaults to `web`. Required in single-decider companies. |

**Response** `200` — the decided `Approval`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 400 | `revision is required …`, `idempotencyKey is required …`, `channel is required …` — a single-decider company, and the field is missing. |
| 402 | `code: "agent_cap_exceeded"` — the approval would create an agent and a free workspace is at its agent limit. The text is in `message`, not `error`. Only when billing is enabled. |
| 403 | `Board access required` — the caller is an agent. |
| 403 | `Deciding an agent hire requires the agents:create permission` — an open `hire_agent` approval, and you lack that permission. |
| 403 | `Only the current steward of the requesting agent can decide this approval; …`, `Only the approver named on this stage of the deliverable can decide it; …`, `Only the owner of this pipeline can decide a recommendation about it; …`, `Only an authorized administrator can decide this approval` — a single-decider company, and you are not this approval's decider. |
| 403 | Not a member, an inactive membership (messages above). |
| 404 | `Approval not found`. |
| 409 | `details.code: "APPROVAL_REVISION_CONFLICT"`, `Approval changed since this decision was requested` — `revision` is stale. Carries `details.expectedRevision` and `details.currentRevision`. Read the approval again before deciding. |
| 409 | `details.code: "APPROVAL_IDEMPOTENCY_KEY_CONFLICT"` — the key was already used for the opposite decision on this approval, or for a different approval. |
| 422 | `Only pending or revision requested approvals can be approved` — the approval is rejected or cancelled. |
| 422 | `Hire approval references an agent outside this company` — a `hire_agent` payload names an agent in another company. The approval is already marked approved when this answers. |

## Reject an approval

`POST /api/approvals/{id}/reject` · [`rejectApproval`](/api/reference#tag/approvals/rejectApproval)

Rejects a `pending` or `revision_requested` approval. Rejecting a `hire_agent` approval ends the pending agent its payload names, if that agent is still pending. Rejecting an approval that is already rejected returns it unchanged.

```bash
curl -X POST https://your-instance.example/api/approvals/$APPROVAL_ID/reject \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "decisionNote": "Budget too high for this role." }'
```

**Body** (`resolveApprovalSchema`) — as for approve.

**Response** `200` — the decided `Approval`.

| Status | When |
| --- | --- |
| 400 | `Validation error`, or a missing decision field in a single-decider company — as for approve. |
| 403 | As for approve: an agent caller, a missing `agents:create` on a hire, or not this approval's decider. |
| 404 | `Approval not found`. |
| 409 | `details.code: "HIRE_APPROVAL_AGENT_ALREADY_ACTIVE"` — the agent this hire names was already activated another way, so rejecting would end a working agent. Carries `details.agentId` and `details.agentStatus`. The approval is left as it is. |
| 409 | `details.code: "APPROVAL_REVISION_CONFLICT"` or `"APPROVAL_IDEMPOTENCY_KEY_CONFLICT"` — as for approve. |
| 422 | `Only pending or revision requested approvals can be rejected` — the approval is approved or cancelled. |
| 422 | `Hire approval references an agent outside this company` — as for approve. The approval is already marked rejected when this answers. |

## Request a revision

`POST /api/approvals/{id}/request-revision` · [`requestApprovalRevision`](/api/reference#tag/approvals/requestApprovalRevision)

Sends a `pending` approval back to its requester with a note. Its status becomes `revision_requested`, and you are recorded as `decidedByUserId`. The requester resubmits it through an internal route, which returns it to `pending`.

```bash
curl -X POST https://your-instance.example/api/approvals/$APPROVAL_ID/request-revision \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "decisionNote": "Please reduce the budget and clarify the role." }'
```

**Body** (`requestApprovalRevisionSchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `decisionNote` | string or null | Optional. What the requester should change. |

**Response** `200` — the updated `Approval`.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema. |
| 403 | `Board access required` — the caller is an agent. |
| 403 | A single-decider company, and you are not this approval's decider (messages as for approve). |
| 403 | Not a member, an inactive membership (messages above). |
| 404 | `Approval not found`. |
| 422 | `Only pending approvals can request revision`. |

## The `Approval` object

From `packages/shared/src/types/approval.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `type` | string | One of the types under `createApproval`. |
| `status` | `pending` · `revision_requested` · `approved` · `rejected` · `cancelled` | |
| `payload` | object | What was requested. Secret-looking values are redacted in responses. |
| `requestedByAgentId`, `requestedByUserId` | UUID or null | Who asked. |
| `decisionNote` | string or null | |
| `decidedByUserId`, `decidedAt` | string or null, timestamp or null | Set by a decision or a revision request. `decidedByUserId` is `"board"` when the decider has no user id, as for the local operator. |
| `revision` | integer | Send it back as `revision` when you decide. A resubmit moves it on. |
| `decisionChannel`, `decisionActorRole` | string or null | Where the decision was taken, and in what capacity (`board`, `steward`, `admin`, `approver`, `owner_override`). |
| `url` | string | The page where a person decides it. Absent when the instance has no public URL configured. |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

The complete schema is in [the reference](/api/reference#tag/approvals/getApproval).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (linked issues, resubmit, emergency override, comments) are internal — see [the route index](/api/route-index), under `approvals`.
