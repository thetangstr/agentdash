---
title: "Bridge tools"
summary: "The tools a bridge endpoint token gets: the local end of the agent bridge and the steward inbox."
---

> Generated at commit `92bec8fe1` by `scripts/docs/generate-mcp-reference.mjs`.
> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.

**8 tools** — measured: the length of the `tools/list` response. Source: `buildToolSurface` in `packages/mcp-server/src/index.ts`, which returns these for any credential `isControlPlaneCredential` (`src/config.ts`) rejects, whatever the toolset except `human`; the tools are defined in `src/bridge.ts`.

Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list` (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema). Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.

Tools, in the order `tools/list` returns them: `bridge_next_task`, `inbox_sync`, `inbox_agents`, `inbox_propose`, `inbox_confirm`, `inbox_ack`, `inbox_decide`, `bridge_submit_result`.

## `bridge_next_task`

Pull the next AgentDash task assigned to this machine. Returns null when idle.

No input.

## `inbox_sync`

Read this machine's AgentDash steward inbox: what needs a decision, what stopped, what finished. Does not acknowledge anything.

| Property | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Minimum: 1. Maximum: 200. |
| `includeDigest` | boolean | no |  |

## `inbox_agents`

List the agents in this company by name and role, so a person's instruction can be matched to a real agent.

No input.

## `inbox_propose`

Work out what an instruction means and read it back for confirmation. Changes nothing. Use for assigning work ('have Casper draft X'): `work` is a short name for the job (it becomes the issue title) and `description` is the full brief; confirmed work is created as todo and the agent starts on it straight away. It also records a check-interval preference, but nothing acts on it -- the check is triggered by the operator's own harness schedule, not by AgentDash, so do not tell the operator that setting it changes when the inbox is checked. If a name does not resolve this returns the alternatives -- put the question to the operator rather than guessing.

| Property | Type | Required | Description |
|---|---|---|---|
| `kind` | `"assign_work"` \| `"set_cadence"` | yes |  |
| `items` | array of object | no | For assign_work: who, and what they should do |
| `items[].agent` | string | yes |  |
| `items[].work` | string | yes | Short name for the job; becomes the issue title |
| `items[].description` | string | no | The full brief: context, what done looks like, constraints |
| `minutes` | integer | no | For set_cadence: 30 or 60 |

## `inbox_confirm`

Carry out an action the operator has just confirmed, using the handle from inbox_propose. Only call this after they have said yes to the read-back. The handle is spent by this call.

| Property | Type | Required | Description |
|---|---|---|---|
| `token` | string | yes | The handle returned by inbox_propose |

## `inbox_ack`

Move this machine's inbox position forward, so acknowledged items are not shown again. Only call this once the operator has actually seen them.

| Property | Type | Required | Description |
|---|---|---|---|
| `seq` | integer | yes | Minimum: 0. |

## `inbox_decide`

Approve or reject one AgentDash approval using a handle from inbox_sync. The handle is spent by this call and is good for one approval at one revision only.

| Property | Type | Required | Description |
|---|---|---|---|
| `token` | string | yes | The approve or reject handle from an inbox_sync item's `actions` |

## `bridge_submit_result`

Submit the result of an AgentDash bridge task, or decline it with a reason.

| Property | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | yes |  |
| `resultToken` | string | yes |  |
| `result` | string | no |  |
| `declineReason` | string | no |  |
