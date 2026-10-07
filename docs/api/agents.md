---
title: Agents
summary: The AI employees of a company — list and read them, change their settings, pause and resume them, and manage their API keys.
---

An agent is one AI employee of a company: it has a name and role, an adapter that runs it, a budget, and a place in the reporting line. These operations list a company's agents, read one, change its settings, pause and resume it, and mint, list and revoke its API keys.

**Source:** `server/src/routes/agents.ts` · **In the reference:** [Agents](/api/reference#tag/agents)

## Who may call it

| Operation | Who |
| --- | --- |
| `listAgents`, `getAgent` | a person who is a member, or an agent in that company |
| `getCurrentAgent` | an agent key or agent run token only — anyone else gets 401 `Agent authentication required` |
| `updateAgent` | a person with the `agents:create` permission, or an instance admin; the agent's steward or creator for a few fields; an agent for its own presentation fields, or a CEO agent for another agent's (see Update an agent, below) |
| `pauseAgent`, `resumeAgent`, `listAgentKeys`, `createAgentKey`, `revokeAgentKey` | a person with the `agents:create` permission in the agent's company, or an instance admin — an agent gets 403 `Board access required`, a member without the permission gets 403 `Missing permission: agents:create` |

Every call checks company membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, an agent from another company answers 403 `Agent key cannot access another company`, and a member whose membership is not active answers 403 `User does not have active company access` on any write.

An agent whose visibility is `owner` is hidden from members who do not answer for it. On every `/api/agents/{id}` route such an agent answers 404 `Agent not found`, exactly like an id that does not exist (`assertAgentIdVisible` in `server/src/routes/visibility.ts`; see [Conventions](/api/conventions)).

`{id}` is the agent's UUID or its shortname (`urlKey`). A shortname is looked up in the caller's company for an agent key; a person must add `?companyId=$COMPANY_ID`. Without it the call answers 422 `Agent shortname lookup requires companyId query parameter`; a shortname that matches two agents answers 409 `Agent shortname is ambiguous in this company. Use the agent ID.`

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List agents

`GET /api/companies/{companyId}/agents` · [`listAgents`](/api/reference#tag/agents/listAgents)

The company's agents, without terminated ones and without agents hidden from you. The route takes no query parameters.

```bash
curl https://your-instance.example/api/companies/$COMPANY_ID/agents \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of `Agent` (below), each with `steward`, `accountable` and `harnessReadiness`. A caller who may not read configuration gets every row with `adapterConfig` and `runtimeConfig` emptied to `{}`. Reading configuration needs the `agents:create` permission or instance admin for a person, and the `canCreateAgents` permission or an `agents:create` grant for an agent.

| Status | When |
| --- | --- |
| 400 | `Unsupported query parameter: <name>` (or `Unsupported query parameters: <a>, <b>` for several) — any query parameter was sent. |
| 403 | Not a member, or an agent key for another company (messages above). |

## Get the calling agent

`GET /api/agents/me` · [`getCurrentAgent`](/api/reference#tag/agents/getCurrentAgent)

The agent the credential belongs to, in full. Call it with an agent key or an agent run token:

```bash
export AGENTDASH_KEY="pcp_…"   # an agent key; see /api/api-keys

curl https://your-instance.example/api/agents/me \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `AgentDetail` (below), never redacted.

| Status | When |
| --- | --- |
| 401 | `Agent authentication required` — the credential is not an agent's. A board key gets 401 here, not 403. |
| 404 | `Agent not found`. |

## Get an agent

`GET /api/agents/{id}` · [`getAgent`](/api/reference#tag/agents/getAgent)

```bash
curl https://your-instance.example/api/agents/$AGENT_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — one `AgentDetail` (below). An agent reading itself gets the full record. Anyone else who may not read configuration (the rule under List agents, above) gets `adapterConfig` and `runtimeConfig` as `{}` and `tokenCeiling` as `null`.

| Status | When |
| --- | --- |
| 403 | Not a member, or an agent key for another company (messages above). |
| 404 | `Agent not found` — no such agent, or one hidden from you. |
| 409 | `Agent shortname is ambiguous in this company. Use the agent ID.` |
| 422 | `Agent shortname lookup requires companyId query parameter`. |

## Update an agent

`PATCH /api/agents/{id}` · [`updateAgent`](/api/reference#tag/agents/updateAgent)

Send only the fields you are changing. Who may change what:

- **A person with `agents:create`, or an instance admin** — any field below.
- **The agent's steward, or the person who created it**, in a company where stewardship is enabled — `title`, `icon`, `capabilities` and `budgetMonthlyCents` only.
- **The agent itself** — `name`, `title`, `icon` and `capabilities` only.
- **A CEO agent, or an agent with `canCreateAgents` or an `agents:create` grant**, on another agent — `name`, `title`, `icon` and `capabilities` only.

```bash
curl -X PATCH https://your-instance.example/api/agents/$AGENT_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "title": "Senior Researcher", "budgetMonthlyCents": 20000 }'
```

**Body** (`updateAgentSchema`, every field optional) — the fields that matter:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Non-empty. Must not collide with another agent's shortname in the company. |
| `title`, `capabilities` | string or null | |
| `icon` | one of the agent icon names, or null | |
| `role` | an agent role, e.g. `engineer`, `researcher`, `general` | |
| `reportsTo` | UUID or null | The manager agent. It must be in the same company and must not create a cycle. |
| `status` | `active` · `paused` · `idle` · `running` · `error` · `pending_approval` · `terminated` | To pause or resume, prefer the dedicated operations below. |
| `budgetMonthlyCents` | integer ≥ 0 | |
| `adapterType` | string | A registered adapter type, e.g. `claude_local`, `codex_local`, `process`, `http`. |
| `adapterConfig` | object | Merged into the stored configuration, unless `replaceAdapterConfig` is `true` or `adapterType` changes. |
| `replaceAdapterConfig` | boolean | Replace `adapterConfig` instead of merging. |
| `runtimeConfig` | object | Replaces the stored runtime configuration. |
| `defaultEnvironmentId` | UUID or null | An environment in the same company. |
| `autonomy` | `stewarded` · `autonomous` | |
| `accountableUserId` | string or null | The person answerable for an autonomous agent. When you make an agent autonomous without it, the current value is kept, or else it is you. |
| `visibility` | `company` · `owner` · null | null inherits the company default. Needs a company owner or admin. |

`permissions` cannot be set here; the schema refuses it with 400. Stewardship cannot be set here either, and `desiredSkills` answers 422 naming `POST /api/agents/{id}/skills/sync`, the route that applies a skill assignment. Agent callers get 403 on `PATCH /api/agents/{id}/permissions` — permission grants are board-only.

Setting a custom command, arguments, environment, working directory or host path in `adapterConfig` needs an instance admin, as does a host-executed workspace command. Resending the stored value is accepted.

**Response** `200` — the updated `Agent`. This is the stored row: it does not carry `steward`, `accountable` or the detail fields.

| Status | When |
| --- | --- |
| 400 | `Validation error` — the body fails the schema, including any `permissions` value. |
| 403 | `Missing permission: agents:create` — a person who is neither an administrator with that permission nor the agent's steward or creator. |
| 403 | `Stewardship does not permit changing <fields>; an administrator with agents:create must make this change` — a steward or creator sent a field outside their four. |
| 403 | `An agent cannot change its own <fields>. Ask an owner, admin or operator.` |
| 403 | `Only CEO or agent creators can modify other agents`. |
| 403 | `An agent cannot change another agent's <fields>. Ask an owner, admin or operator.` |
| 403 | `Company owner or admin access required` — `visibility` was sent by someone who is not a company owner or admin. |
| 403 | `Instance admin access required to set a custom command, arguments, environment, working directory or host path for an agent adapter (<paths>)…`. |
| 403 | `Instance admin access required to set a host-executed workspace command (<paths>)…`. |
| 403 | Not a member, an inactive membership, or an agent key for another company (messages above). |
| 404 | `Agent not found`, or `Manager not found` for a `reportsTo` that does not exist. |
| 409 | `Terminated agents cannot be resumed` — a status change on a terminated agent. |
| 409 | `Pending approval agents cannot be activated directly`. |
| 409 | `Agent shortname '<shortname>' is already in use in this company`. |
| 409 | `<name> is stewarded by <person>. End that stewardship first…` — making a stewarded agent autonomous while its stewardship is active. |
| 409 | `A stewarded agent takes its accountable human from its steward, so accountableUserId cannot be set on one…`. |
| 409 | `The accountable person must be an active member of this company…`. |
| 422 | `Stewardship is not set here…` — the body carried `steward` or `stewardUserId`. Where stewardship is enabled, the message names the stewardship routes. |
| 422 | `Unknown adapter type: <type>`. |
| 422 | `Manager must belong to same company`, `Agent cannot report to itself`, or `Reporting relationship would create cycle`. |
| 422 | `Selected environment must belong to the same company`. |
| 422 | `Requested agent configuration exceeds the owner ceiling` — a `budgetMonthlyCents` above the agent's governance ceiling, in a company where ceilings apply. `details.code` is `AGENT_POLICY_CEILING_EXCEEDED` and `details.violations` lists what was exceeded. |

## Pause an agent

`POST /api/agents/{id}/pause` · [`pauseAgent`](/api/reference#tag/agents/pauseAgent)

Sets the agent's status to `paused` with `pauseReason: "manual"`, so no new run starts. Runs already in progress are cancelled. Recorded as `agent.paused` in the activity log.

```bash
curl -X POST https://your-instance.example/api/agents/$AGENT_ID/pause \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — the updated `Agent`.

| Status | When |
| --- | --- |
| 403 | `Board access required` — the caller is an agent. |
| 403 | `Missing permission: agents:create`. |
| 403 | Not a member, or an inactive membership (messages above). |
| 404 | `Agent not found`. |
| 409 | `Cannot pause terminated agent`. |

## Resume an agent

`POST /api/agents/{id}/resume` · [`resumeAgent`](/api/reference#tag/agents/resumeAgent)

Sets the agent's status to `idle` and clears `pauseReason` and `pausedAt`. Recorded as `agent.resumed`.

```bash
curl -X POST https://your-instance.example/api/agents/$AGENT_ID/resume \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — the updated `Agent`.

| Status | When |
| --- | --- |
| 403 | `Board access required` — the caller is an agent. |
| 403 | `Missing permission: agents:create`. |
| 403 | Not a member, or an inactive membership (messages above). |
| 404 | `Agent not found`. |
| 409 | `Cannot resume terminated agent`. |
| 409 | `Pending approval agents cannot be resumed`. |

## List an agent's keys

`GET /api/agents/{id}/keys` · [`listAgentKeys`](/api/reference#tag/agents/listAgentKeys)

Every key the agent has had, active and revoked. The key itself is never returned. How agent keys work is on [API keys](/api/api-keys).

```bash
curl https://your-instance.example/api/agents/$AGENT_ID/keys \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — an array of:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | Use it to revoke the key. |
| `name` | string | |
| `createdAt` | ISO 8601 timestamp | |
| `revokedAt` | ISO 8601 timestamp or null | null while the key is active. |
| `source` | `agent_creation` · `onboarding` · `connect_code` · `manual` · `auto_hire` | What minted it. |
| `createdByUserId`, `createdByAgentId` | string or null | Who minted it. |

| Status | When |
| --- | --- |
| 403 | `Board access required` — the caller is an agent. |
| 403 | `Missing permission: agents:create`. |
| 403 | Not a member (message above). |
| 404 | `Agent not found`. |

## Create an agent key

`POST /api/agents/{id}/keys` · [`createAgentKey`](/api/reference#tag/agents/createAgentKey)

Mints a key for the agent. The token is in the response once and is stored only as a hash. Recorded as `agent.key_created`.

```bash
curl -X POST https://your-instance.example/api/agents/$AGENT_ID/keys \
  -H "Authorization: Bearer $AGENTDASH_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "laptop" }'
```

**Body** (`createAgentKeySchema`):

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Optional, non-empty; default `default`. |

**Response** `201` — an `AgentKeyCreated`:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | |
| `name` | string | |
| `token` | string | The key, `pcp_` + 48 hex characters. Shown only here. |
| `createdAt` | ISO 8601 timestamp | |
| `source` | string | `manual` for keys minted here. |
| `createdByUserId`, `createdByAgentId` | string or null | |

| Status | When |
| --- | --- |
| 400 | `Validation error` — `name` is an empty string or not a string. |
| 403 | `Board access required` — the caller is an agent. The body is validated first, so an agent that sends an invalid body gets the 400 instead. |
| 403 | `Missing permission: agents:create`. |
| 403 | Not a member, or an inactive membership (messages above). |
| 404 | `Agent not found`. |
| 409 | `<name> is an autonomous agent, so no key or connect code can be issued for it…` — make it a stewarded agent first. |
| 409 | `Cannot create keys for pending approval agents`. |
| 409 | `Cannot create keys for terminated agents`. |

## Revoke an agent key

`DELETE /api/agents/{id}/keys/{keyId}` · [`revokeAgentKey`](/api/reference#tag/agents/revokeAgentKey)

The key stops resolving at once and stays in the list as revoked. Recorded as `agent.key_revoked`.

```bash
curl -X DELETE https://your-instance.example/api/agents/$AGENT_ID/keys/$KEY_ID \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Response** `200` — `{ "ok": true }`. Revoking a key that is already revoked also answers 200, and moves its `revokedAt` to now.

| Status | When |
| --- | --- |
| 403 | `Board access required` — the caller is an agent. |
| 403 | `Missing permission: agents:create`. |
| 403 | Not a member, or an inactive membership (messages above). |
| 404 | `Agent not found`. |
| 404 | `Key not found` — no such key, or it belongs to another agent. |

## The `Agent` object

From `packages/shared/src/types/agent.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `name`, `urlKey` | string | `urlKey` is the shortname `{id}` also accepts. |
| `role` | string | e.g. `ceo`, `engineer`, `researcher`, `general`. |
| `title`, `icon`, `capabilities` | string or null | |
| `status` | `active` · `paused` · `idle` · `running` · `error` · `pending_approval` · `terminated` | |
| `pauseReason`, `pausedAt` | string or null, timestamp or null | Set while the agent is paused. |
| `reportsTo` | UUID or null | The manager agent. |
| `adapterType` | string | |
| `adapterConfig`, `runtimeConfig` | object | `{}` on the restricted view. |
| `budgetMonthlyCents`, `spentMonthlyCents` | integer | The monthly budget and this month's spend, in cents. |
| `permissions` | `{ canCreateAgents: boolean }` | |
| `autonomy` | `stewarded` · `autonomous` | Treat a missing value as `stewarded`. |
| `visibility` | `company` · `owner` · null | null inherits the company default. |
| `steward` | `{ userId, name, email, since }` or null | The person who runs the agent. On list and detail responses. |
| `accountable` | `{ userId, name, email, via }` or null | The person answerable for its work; `via` is `steward` or `assignment`. On list and detail responses. |
| `harnessReadiness` | `{ ready, reason, message, testedAt }` or null | Whether the saved harness check still describes the agent. |
| `lastHeartbeatAt` | timestamp or null | |
| `createdByUserId` | string or null | |
| `createdAt`, `updatedAt` | ISO 8601 timestamp | |

`AgentDetail`, returned by `getAgent` and `getCurrentAgent`, adds:

| Field | Type | Notes |
| --- | --- | --- |
| `chainOfCommand` | array of `{ id, name, role, title }` | The managers above the agent, nearest first, at most 50 (`server/src/services/agents.ts`). |
| `access` | object | `canAssignTasks`, `taskAssignSource` (`explicit_grant` · `agent_creator` · `ceo_role` · `none`), the agent's membership and its grants. |
| `runHealth` | object | Counts from the agent's runs: `total`, `succeeded`, `failed`, `succeededWithoutEvidence`, `neverRan`, `tokenCeilingPause`, and the `last` run. `chatTurns` counts the agent's chat answers all time (a chat-driven agent can answer many chats while `neverRan` stays true — `neverRan` counts heartbeat runs only) and `chatTurnsThisMonth` the same for the current month. |
| `resolvedRuntime` | `{ model, provider, source }` or null | What will serve the next run; null `model` means unknown. |
| `tokenCeiling` | object or null | Today's tokens against the daily ceiling. null on the restricted view. |

The complete schema is in [the reference](/api/reference#tag/agents/getAgent).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (create, hire, approve, terminate and delete, permissions, instructions, configuration and revisions, skills, runtime state, connect codes, wakeup and heartbeat, org chart, adapter models, runs) are internal — see [the route index](/api/route-index), under `agents`.
