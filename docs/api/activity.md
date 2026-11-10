---
title: Activity
summary: Read a company's activity log — who did what, to which entity, and when.
---

The activity log records what happens in a company: an issue created, an agent paused, a secret rotated, a cost reported. This operation reads it, newest first, filtered by agent, by entity or by time.

**Source:** `server/src/routes/activity.ts` · **In the reference:** [Activity](/api/reference#tag/activity)

## Who may call it

| Operation | Who |
| --- | --- |
| `listActivity` | a member of the company, or an agent in it |
| `listCompanyAudit`, `exportCompanyAuditCsv` | an owner or admin of the company, signed in as a person |

The call checks membership first (`assertCompanyAccess` in `server/src/routes/authz.ts`): a person who is not a member answers 403 `User does not have access to this company`, and an agent from another company answers 403 `Agent key cannot access another company`.

Inside the company, the log follows visibility (`server/src/routes/visibility.ts`). Rows about an issue or project you cannot see, or about an agent you cannot see, are left out, and references to hidden issues inside `details` are removed. See [Conventions](/api/conventions).

The examples assume:

```bash
export AGENTDASH_KEY="pcp_board_…"   # a board key; see /api/api-keys
```

## List activity

`GET /api/companies/{companyId}/activity` · [`listActivity`](/api/reference#tag/activity/listActivity)

```bash
curl "https://your-instance.example/api/companies/$COMPANY_ID/activity?entityType=issue&entityId=$ISSUE_ID&limit=50" \
  -H "Authorization: Bearer $AGENTDASH_KEY"
```

**Query** — all optional, and combined with AND:

| Parameter | Notes |
| --- | --- |
| `limit` | Rows to return. Default 100, clamped to 1–500 (`server/src/services/activity.ts`). Absent or not a number, it gets the default; an empty `limit=` reads as 0 and is clamped to 1. |
| `since` | ISO 8601 timestamp. Only rows created at or after it. |
| `agentId` | UUID. Only rows about this agent. |
| `entityType` | Only rows about this kind of entity, such as `issue`, `agent`, `project`, `secret` or `cost_event`. |
| `entityId` | Only rows about this entity. Usually paired with `entityType`. |
| `includeSystem` | `true` returns every row. `false` also leaves out system bookkeeping (workspace leases, read markers, run internals) and rows a system actor wrote, except the ones an owner must see (budget stops, failed hires, system-opened approvals). Omitted, every row comes back except `access.would_refuse` and `agent_profile.application_step` (`ACTIVITY_DEFAULT_FEED_HIDDEN_ACTIONS` in `packages/shared/src/activity-actions.ts`), which only `true` returns. |

Rows come back newest first. There is no offset. To follow the log, pass the newest `createdAt` you have seen as `since`: the bound is inclusive, so that row comes back again, and if more than `limit` rows arrived since then, only the newest `limit` are returned. Rows about hidden issues are never returned.

**Response** `200` — an array of `ActivityEvent` (below).

| Status | When |
| --- | --- |
| 400 | `since must be an ISO 8601 timestamp` — `since` does not parse. |
| 400 | `Invalid identifier` — `agentId` is not a UUID. |
| 403 | Not a member, or an agent key for another company (messages above). |

## The admin audit

`GET /api/companies/{companyId}/audit` · [`listCompanyAudit`](/api/reference#tag/activity/listCompanyAudit)
`GET /api/companies/{companyId}/audit.csv` · [`exportCompanyAuditCsv`](/api/reference#tag/activity/exportCompanyAuditCsv)

The same log for a company's owners and admins, with filters, cursor paging and a CSV export. It adds no read authority: rows go through the very filter and redaction `listActivity` applies (`server/src/services/activity-read-scope.ts`), so an admin sees here exactly what the activity feed shows them. Anyone else answers 403 `Only owners and admins can see this.`, and the refusal is logged (`authz.refused`).

**Query** — all optional, and combined with AND:

| Parameter | Notes |
| --- | --- |
| `actorType` | `user`, `agent` or `system`. |
| `actorId` | Only rows by this person or agent. |
| `action` | Comma-separated, at most 20. Each is an exact action name or a prefix such as `issue.*`. |
| `entityType`, `entityId` | As on `listActivity`. |
| `from`, `to` | ISO 8601 timestamps, both inclusive; `from` after `to` is a 400. |
| `includeSystem` | Default `true` (every row). `false` leaves out what `listActivity`'s `false` leaves out. |
| `cursor` | The `nextCursor` of the previous page. Not for the CSV. |
| `limit` | Rows per page, 1 to 200, default 100. Not for the CSV. |

Rows come newest first, ordered by `createdAt` and then `id`, so paging is stable while new rows arrive.

**Response** `200` — `{ items, actorNames, nextCursor }`: `items` is an array of `ActivityEvent`; `actorNames` maps the people and agents on the page to their names; `nextCursor` is `null` on the last page.

**CSV.** The same filters, as `text/csv` with columns `created_at, actor_type, actor_id, actor_name, action, entity_type, entity_id, agent_id, run_id, via, batch_id, details_json`. An export holds at most 50,000 rows: past that, the response carries `X-Audit-Truncated: true` and ends with a row that says so. A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet does not read it as a formula. Each export is logged as `audit.exported` with its filters and row count.

| Status | When |
| --- | --- |
| 400 | A filter does not parse: a bad date, an unknown `actorType`, more than 20 actions, an action that is neither a name nor `prefix.*`, a bad `cursor`, or a `limit` outside 1 to 200. |
| 403 | Not an owner or admin of the company (`Only owners and admins can see this.`), or not a member. |

## The `ActivityEvent` object

From `packages/shared/src/types/activity.ts`. The fields an integration reads:

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `companyId` | UUID | |
| `actorType` | `agent` · `user` · `system` · `plugin` | Who acted. |
| `actorId` | string | The agent id, user id, or system identifier. |
| `action` | string | Dotted names, such as `cost.reported`, `secret.created`, `secret.rotated`. |
| `entityType`, `entityId` | string | What the action was about. `entityId` is text, not always a UUID. |
| `agentId` | UUID or null | The agent the row is about, when there is one. |
| `runId` | UUID or null | The run it happened in, when there is one. |
| `details` | object or null | Action-specific data. |
| `origin` | `server` · `manual` · null | `server`: written by a server route, with the actor taken from the credential. `manual`: posted by a person by hand. `null`: written before origin was recorded. |
| `createdAt` | ISO 8601 timestamp | |

The complete schema is in [the reference](/api/reference#tag/activity/listActivity).

## Everything else

Any operation can also answer 401 when no credential resolves and 429 when rate limited — see [Conventions](/api/conventions). Other routes on this resource (posting a manual entry, an issue's activity and runs, a run's issues) are internal — see [the route index](/api/route-index), under `activity`.
