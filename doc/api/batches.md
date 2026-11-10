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
   `after`, and optional plain `notes` (consequences worth knowing). Ids the person cannot see, ids from another company and records
   the change would not alter are left out and only counted in
   `omitted: {notFound, noop, notDecidable}`; they are never named. Records
   whose own rules would decide the change instead are listed in
   `notDecidable` with a plain reason (for example an issue with an open
   review or approval step is left out of a "done" or "in review": "goes to review
   first"; one whose review step is under way is left out of any status or
   assignee change: "is in review now"). Each item's `before` and `after`
   hold every field `issue.update` can touch, not only the ones it changes. When
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

Who may use these routes: a person signed in to AgentDash in the browser (or
the local operator on a local-trusted install). Agents, board API keys and
assistant grants get `403` on every batch route.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `applied` | The route answered 2xx. The record is re-read: `actual` holds the touched fields as they are now. When any of them (status, priority, both assignee fields, project, labels) differs from the preview's `after`, including a field the batch did not ask to change, `reasonCode` is `applied_differently`, `reason` names the differences, a `batch.item_applied_differently` activity row is written, and `counts.appliedDifferently` counts it. |
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
| `issue.update` | any of `status`, `priority`, `assignee` (`{agentId}`, `{userId}` or `null`), `projectId` (or `null`), `addLabelIds`, `removeLabelIds` | `PATCH /api/issues/:id` |
| `approval.approve` | optional shared `decisionNote` | `POST /api/approvals/:id/approve` |
| `approval.reject` | optional shared `decisionNote` | `POST /api/approvals/:id/reject` |
| `agent.pause` / `agent.resume` | none | `POST /api/agents/:id/pause` / `resume` |
| `agent.set_model` | `model` | `PATCH /api/agents/:id` with `{adapterConfig: {model}}` |
| `agent.transfer_steward` | `userId`, `transferReason` | `POST /api/companies/:companyId/agents/:agentId/stewardship/transfer` |
| `routine.archive` | none | `PATCH /api/routines/:id` with `{status: "archived"}` |
| `routine.delete` | none | `DELETE /api/routines/:id` |
| `label.update` | `name` and/or `color` | `PATCH /api/labels/:labelId` |
| `label.delete` | none | `DELETE /api/labels/:labelId` |
| `agent.apply_ceiling` | `templateId` | `PUT /api/companies/:companyId/agents/:agentId/governance/ceiling` with `{policy, revision}` |

`issue.update`:

- Labels are added or removed; the preview turns them into each task's full
  label set, and a task that already has (or lacks) them is a no-op.
- Assigning a person who looks after an agent: the route hands the task to
  that agent, so the preview's `after` shows the agent and a note says so. If
  the stewardship changes before apply, the item is refused as changed.
- Moving a task out of done carries the note "Moving it out of done reopens
  it" (and "clears its review record" when it has one).
- A task with an open review or approval step is left out of a "done" or "in
  review"; one whose step is under way is left out of any status or assignee
  change.

`approval.approve` / `approval.reject`:

- Candidates are the approvals waiting on the person that they may decide:
  the same scope and authority probe as the Decisions list
  (`waitingOnYouService.decisionCandidates`). Others are listed in
  `notDecidable` ("is not waiting on you", "you cannot decide").
- Each request carries the revision the preview saw (the route answers 409 on
  a stale one; the engine's own drift check usually refuses first), an
  idempotency key `batch:<itemId>` (a retried request replays the same
  decision) and `channel: "web"`.
- "Request changes" is not a batch kind: each one needs its own note.

At apply, an item is refused as `changed_since_preview` ("This task changed
after you previewed it, so nothing was done to it.") when the record, or what
the change would make of it, is no longer what the preview showed. A kind's
own guard (`previewGuard`) runs at preview and again at confirm.

Agents (`agent.*`):

- For people with `agents:create` (the routes' own rule). The kind's guard
  runs at preview and again at confirm: someone who loses the permission in
  between sends nothing (403 at confirm).
- Pause notes "Pausing stops the work it is doing now" (or "stops it from
  starting new work"); resume notes "Resuming may start work now". Removed
  or not-yet-set-up agents are left out.
- `agent.set_model` reads and stores only `adapterConfig.model`; nothing
  else of an agent's configuration (which can hold credentials) reaches a
  record, a batch row, a preview, an activity row or a log line. Agents whose
  runtime does not offer the model (the same per-runtime list the agent form
  offers) are left out.
- `agent.transfer_steward`: agents with no steward are left out. A person
  looks after one agent at a time, so only one agent of a batch can go to a
  given person; the rest are left out with that reason.

`agent.apply_ceiling` (agentdash_mk companies only; elsewhere the preview is
404 "Agent ceilings are not available in this workspace."):

- People with `agents:create` (the ceiling route's own rule); the guard runs
  at preview and again at confirm.
- Each item's `before` and `after` are the agent's effective policy (plus the
  policy revision). `after` is computed with `governanceWriteOutcome`, the
  function the ceiling write itself uses (the ceiling clamping the steward's
  request), so the preview cannot promise another result. Notes list the
  gains and losses (`diffGovernancePolicies`, shared with the UI) and, when
  something is lost, that anything above the new ceiling is brought down at
  once (budget, permissions, channel connections, waiting sends).
- The request carries the previewed revision: the route answers 409 on a
  stale one (the engine's drift check usually refuses first).
- An agent whose effective policy would not change is a no-op; a template
  from another company (or deleted) leaves every agent out with a reason.

Routines and labels:

- `routine.delete` removes the routine for good: it is archived, its
  triggers go off, and it is hidden from the routine routes, from agents'
  responsibilities and performance views, and from profile references. Its
  runs, the tasks they created, its activity and its evaluation history are
  kept (the row is a tombstone, because runs would cascade away with a hard
  delete; the evaluation snapshot marks it deleted).
- `label.delete` notes how many tasks lose the label; the task count is part
  of the drift check, so a label put on more tasks after the preview is
  refused as changed.

Approvals also note what deciding sets in motion for the types with a
consequence (a hire, a budget override, a connector send, a profile change).
A 200 that shows the approval had already been decided (the route returns the
earlier decision) means this batch did nothing: the item is `refused`, counted
as refused, with reason code `decided_by_someone_else` ("it was already
approved by someone else, so nothing was done by this batch") or, when the
same person had decided it on another channel, `already_decided` ("it was
already approved, so nothing was done by this batch").

Idempotency keys (approvals) are derived from a per-batch secret that no route
returns, so a person who can read a batch's item ids cannot spend them first.

Every kind must join `server/src/__tests__/batch-guard-parity.test.ts`.

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
item. Items are sent to the local address and port the confirm arrived on
(not an assumed 127.0.0.1), so a server bound to one address is reached there
and no other local process can receive an item. `details.batch` on activity
rows is server-written only: a caller-supplied `batch` key is dropped. Two exemptions apply only when the verified credential kind is
`batch_item`: the CSRF origin check and the default API rate limiter.

## Batches prepared by an admin's own Claude (part 5)

A batch can also be prepared by the person's own assistant connection (an OAuth grant with `agentdash:admin`). It is stored with `origin = 'assistant'` and `assistant_grant_id`, and with **no confirm handle**. Nothing changes until the person acts in their browser.

| Route | Who | What |
| --- | --- | --- |
| `POST /api/companies/:companyId/assistant/batches/prepare` | the grant's internal loopback (`pcin_`), body `{kind, targets, change}` only | Resolves `targets` on the server (issue identifiers, UUIDs or titles; agent names, titles, roles or ids; approval ids), exact matches first. Any reference that finds nobody or several answers 422 `not_found` / `needs_clarification` (at most five candidates, only records the person can see) and stores no batch. Otherwise stores the preview and answers `{batchId, summary, counts, sample (first 10, plain text), notDecidable, reviewUrl, expiresAt}`. Never a code. |
| `POST /api/companies/:companyId/batches/:batchId/confirm-code` | the creator, in a browser session only | Mints the code (8 Crockford base32 characters, shown `K7QM-3XRD`). Each call replaces the previous code. Only `sha256("agentdash-batch-code:<batchId>:<code>")` is stored; the code is in this response (`Cache-Control: no-store`) and nowhere else: no GET, activity row (`batch.confirm_code_shown` records only that a code was shown), log line or error message. |
| `POST /api/companies/:companyId/assistant/batches/:batchId/confirm` | the grant that prepared it, body `{code}` only | Compares in constant time (`crypto.timingSafeEqual` on the hashes; case, dashes, spaces and O/0, I/L/1 are folded). A wrong code counts; the fifth cancels the batch. Answers 202 and runs the batch. |
| `POST /api/companies/:companyId/batches/:batchId/apply-here` | the creator, in a browser session only | "Apply here": spends the batch with the person's own session. |
| `GET /api/companies/:companyId/batches/:batchId` | also the grant that prepared it | Status and outcomes. No code or hash material, ever. |

**Who may prepare or confirm, read fresh on every call:** the request is a grant actor; the grant row is live, belongs to this person and this company, and holds `agentdash:admin` (a call without it answers 403 `insufficient_scope` with a step-up `WWW-Authenticate` challenge); the person is an owner or admin of the company (membership read from the database); the company switch `assistant_admin_batches_enabled` is on. Only the v1 kinds may be prepared: `issue.update`, `approval.approve`, `approval.reject`, `agent.pause`, `agent.resume`, `agent.set_model`, `agent.transfer_steward`, `agent.apply_ceiling`.

**The item actor and the per-item rule.** For a batch confirmed with the code, each item is sent with a `pcbx_` credential whose origin is `{kind: "assistant", grantId, userId}` and whose actor is the grant's actor (`source: "assistant_grant"`, `isInstanceAdmin: false`, the grant's scopes and client name), rebuilt before every item from these rows, all re-read before EVERY item:

1. the grant is not revoked, is this person's and this company's, and still holds `agentdash:admin`;
2. the person is still an active owner or admin of the company;
3. the company switch is still on.

If any one fails, that item and every remaining item are refused with `assistant_access_ended` and nothing further is sent. The session re-check (`sessionProof` in `server/src/services/current-board-identity.ts`) accepts only a `session` origin, so it never accepts an assistant one. Routes that re-check the credential themselves (the issue routes, `services/issue-current-authority.ts`) accept an assistant-origin item only when the grant row is live, matches the person and company, and holds `agentdash:admin`. Each record still passes its own route's guards for that person. A batch applied with "Apply here" runs with the person's session, as a batch started in the product does.

**Provenance.** Every activity row an item writes carries `details.batch.{id, itemId, origin: "assistant", grantId, client}`, whichever path applied it.

**Caps, durable (counted from `batch_operations`):** records per batch from `companies.assistant_batch_max_records` (default 50, at most 200); 10 prepares per grant per rolling hour (`created_at`); 200 confirmed records per grant per rolling hour (`confirmed_at`); and the per-person caps above.

## Upgrade note: migration 0161 (admin audit indexes)

Migration `0161_activity_log_audit_indexes.sql` adds two indexes to `activity_log`: `(company_id, actor_id, created_at)` and `(company_id, action, created_at)`. Both migration paths run each file inside a transaction (`runInTransaction` in `packages/db/src/client.ts`; drizzle's migrator uses `session.transaction`), so `CREATE INDEX CONCURRENTLY` is not possible and the indexes are built with a plain `CREATE INDEX IF NOT EXISTS`. While each index builds, writes to `activity_log` wait. Every route that logs activity (nearly every write in the product) waits with them.

What this means for a hosted instance with a large log: the build time grows with the table, roughly a full scan plus a sort per index. A log of a few million rows can take tens of seconds to minutes, during which writes stall rather than fail (clients may time out). Plan the upgrade in a quiet window, or build both indexes by hand beforehand with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and the same names (`activity_log_company_actor_created_idx`, `activity_log_company_action_created_idx`); the migration then finds them and does nothing. Reads are not blocked.
