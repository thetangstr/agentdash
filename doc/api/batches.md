# Batch changes API (internal)

One engine for every change to many records at once (admin powers, part 2).
Available in every company. Not in the public contract yet: the routes are
listed as `internal` in `docs/api/route-index.md` and may change while the
product kinds (part 3) and batches from a person's own Claude (part 5) land.

A batch never has authority of its own. Each record is sent, one at a time,
through that record's own single-record route, as the person who confirmed
the batch, and that route's guards decide. A batch can never do something the
single route would refuse that person.

## Flow

1. `POST /api/companies/:companyId/batches/preview` with `{kind, ids, change}`.
   Returns `{batchId, previewDigest, confirmHandle, expiresAt, kind, items, omitted}`.
   `items` are the exact records and, for each, the touched fields `before` and
   `after`. Ids the person cannot see, ids from another company and records
   the change would not alter are left out and only counted in
   `omitted: {notFound, noop, notDecidable}`; they are never named. When
   nothing would change, `batchId` is `null`. The handle is shown once (only
   its sha256 is stored) and expires after 15 minutes.
2. `POST /api/companies/:companyId/batches/:batchId/confirm` with
   `{handle, previewDigest}`. Answers `202 {batchId, status: "running"}`. The
   handle is spent with a conditional update, so of two parallel confirms
   exactly one wins; the other, a used or expired handle, a wrong handle or a
   stale `previewDigest` get `409`. Only the person who previewed may confirm.
3. `GET /api/companies/:companyId/batches/:batchId` until `status` is
   `completed` or `interrupted`. Each item has `outcome` and, when not
   applied, a `reason` written for the person.

Other routes: `GET /api/companies/:companyId/batches` (admins see all, others
their own), `POST …/:batchId/cancel` (the creator, before confirm), and
`POST …/:batchId/items/:itemId/reconcile` with `{verdict: "landed" | "did_not_land", note?}`
(owners and admins, unknown items only, once; it records a verdict and never
resends).

Who may start a batch: a person signed in to AgentDash in the browser (or the
local operator on a local-trusted install). Agents, board API keys and
assistant grants get `403` at preview.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `applied` | The route answered 2xx. |
| `refused` | The route answered 4xx (its own reason is shown), or the engine did not send it: the record changed after the preview (`changed_since_preview`), can no longer be seen (`no_longer_visible`), the person's sign-in or access ended (`access_ended`), the batch ran out of its 10-minute budget (`batch_time_budget`) or was interrupted before reaching it (`batch_interrupted`). |
| `failed` | Not sent (`not_sent`), or the route answered 5xx and the record is unchanged. |
| `unknown` | Sent with no answer within 20 seconds, the connection dropped after sending, a 5xx after which the record changed, or the batch stopped while sending it. Never retried; an admin may record a verdict. |

## Caps

Up to 200 records per batch; up to 5 open previews per person; up to 1,000
confirmed records per person in any rolling hour (counted from confirmed
batches, so it survives a restart). A capped request gets `429`.

## Kinds

| Kind | Change | Route each record goes through |
| --- | --- | --- |
| `issue.update` | any of `status`, `priority`, `assignee` (`{agentId}`, `{userId}` or `null`) | `PATCH /api/issues/:id` |

Part 3 adds the product kinds (labels and project on issues, approvals, agent
pause/resume, model, steward transfer, ceiling templates, routines). Every kind
must join `server/src/__tests__/batch-guard-parity.test.ts`.

## Activity

The route's own rows for an applied record (for example `issue.updated`)
carry `details.batch = {id, itemId, origin}`. The engine writes
`batch.item_refused`, `batch.item_failed` or `batch.item_unknown` for records
the route did not change, `batch.completed` (with counts) when the batch
ends, `batch.interrupted` from the sweeper, and `batch.item_reconciled` for a
verdict. Previews and expiries are not logged; the batch rows are their
record.

## Security notes

Each item request carries a `pcbx_` credential: in-process only, never
persisted or sent to a client, single use, 30-second lifetime, and bound to
one method, path and body digest (`server/src/services/batch/item-credential.ts`).
It resolves to a copy of the confirming person's actor, re-read before every
item. Two exemptions apply only when the verified credential kind is
`batch_item`: the CSRF origin check and the default API rate limiter.
