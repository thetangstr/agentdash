# Human API, MCP and bridge

Status: the workforce/question foundation is implemented and independently reviewed. Other page families are being added. This document does not certify whole-app parity or production rollout.

The human bridge exposes the same allowed domain actions as the human pages through finite, versioned operations. It uses the actual named human's current permissions. Company membership, project visibility, ownership and instance authority are checked where the canonical action requires them; selecting a target does not grant permission.

## Connect

Use an existing browser-approved named-human CLI board key with the local MCP server. The explicit toolset is `AGENTDASH_TOOLSET=human`. Configuration reads `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and optional `PAPERCLIP_COMPANY_ID`; `AGENTDASH_API_URL`, `AGENTDASH_API_KEY` and `AGENTDASH_COMPANY_ID` are aliases. The canonical variable takes precedence when both are set. Use the MCP client's private environment configuration for the approved key; this guide contains no credential.

The approved local verification target is `http://localhost:3199`; it is not automatically the API URL for an isolated feature build. Configure the actual instance containing the reviewed implementation. Do not send its board key to cloud, another instance or a returned artifact URL.

The server verifies the live named board-key connection before advertising human tools. An agent key, assistant OAuth grant, MK machine token or implicit local operator is not a human connection. Expired or revoked keys fail. The board key retains its existing ordinary REST authority; this wrapper is not a confined delegated credential.

## Use the six tools

| Tool | Purpose |
| --- | --- |
| `human_identity` | Verify the human and list explicit available target choices. |
| `human_select_target` | Select a returned company, self, instance or public target. |
| `human_discover` | Retrieve current finite operation IDs, versions, input/output schemas, authority and effects. |
| `human_read` | Read full authorized content through a discovered read operation. |
| `human_prepare` | Resolve a mutation and produce its complete readback without executing the domain action. |
| `human_confirm` | Execute the prepared action after the person consents to that readback. |

Select a target explicitly. Requests carry the same target, and a prepared handle stays pinned to its original target even if the harness later selects another. Use the target returned by identity, rather than guessing a company from source text. Discovery is paginated; consume its cursor to see the whole available catalog.

For a mutation, show the complete readback, including sharing, execution and external effects. Obtain human consent, then confirm the exact handle. `personSaid` is optional context, not server-verifiable proof of consent. Required browser security ceremonies remain required.

The bridge's HTTP endpoints are:

| Method/path | Contract |
| --- | --- |
| `GET /api/human-control/identity` | Current named-human connection and target choices. |
| `POST /api/human-control/discover` | Explicit target, optional page/cursor/limit. |
| `POST /api/human-control/read` | Target, operation ID, version 1 and the operation's strict input. |
| `POST /api/human-control/prepare` | The same envelope for a mutation; returns handle/readback/expiry. |
| `POST /api/human-control/confirm` | Original target and opaque handle, optional `personSaid`. |

Both HTTP and MCP use the same registered contracts. Caller-controlled URLs, methods, headers or arbitrary API request bodies are not operation inputs. The typed input schema returned by discovery is the usable contract.

## Currently reviewed operations

All 22 foundation operations are version 1, company-targeted. Other target kinds currently have no domain operations in this foundation.

| Area | Operation IDs |
| --- | --- |
| Templates/knowledge | `workforce.templates.list`, `workforce.brief.read`, `workforce.brief.publish`, `workforce.proposals.list`, `workforce.proposals.review` |
| Enrollment/objectives | `workforce.enrollment.read`, `workforce.enrollment.create`, `workforce.enrollment.update` |
| Readiness/first job | `workforce.readiness.read`, `workforce.learning.acknowledge`, `workforce.skills.retry`, `workforce.first_job.start` |
| Human questions | `human_questions.pending.list`, `human_questions.read`, `human_questions.respond`, `human_questions.cancel`, `human_questions.replace` |
| Owner recovery | `human_questions.owner.assign`, `human_questions.stewardship.assign`, `human_questions.stewardship.transfer` |
| Task recovery | `task_recovery.exhausted.read`, `task_recovery.remediate` |

Questions retain their actual named owner and source visibility. Answers are private to the original job by default; eligible company-wide sharing is an explicit choice. Cancellation supplies no answer and required work stays held. A company selection or template instruction cannot impersonate the answer owner or grant sharing authority.

### Task recovery permits

When an issue's automatic recovery budget is exhausted, the persisted `executionState.recoveryBudget` marker refuses every wake for that issue — automatic, timer, manual, or any caller-supplied permit context. `task_recovery.exhausted.read` projects the marker, its dimensions and any pending permit. `task_recovery.remediate` is the only authorized path past the gate: a named human with active membership and current issue visibility prepares a readback pinned to the exact issue, its exhaustion marker, revision (`updatedAt`), assignee and refused/source run IDs, then confirms once.

Confirmation atomically writes a server-owned permit under `recoveryBudget.remediation` and enqueues exactly one `queued` heartbeat run bound to that permit (no retry/continuation linkage), then dispatches it through the ordinary queue after commit. The marker itself is never cleared. Consumption happens inside the claim transaction, immediately before the queued→running compare-and-set — so the permit is spent only by a run that really starts. If an earlier start check (workspace/workforce/tree hold, budget, quota, unresolved blocker, staleness, an agent that is no longer invokable) cancels the bound run, the system finalizes the permit `denied` right away and records `issue.task_recovery_permit_denied` (system actor, the person who granted it in `details.permitGrantedByUserId`), so the issue page stops showing a run as waiting and a person can authorize again (GH #891). Activity evidence is published only after the claim outcome is committed: a won CAS produces the `issue.task_recovery_permit_consumed` row (actor: system — the claim consumed it; the person who granted it is `details.permitGrantedByUserId`, and their own action is the `issue.task_recovery_authorized` row); a lost CAS (e.g. a board cancel racing the claim) finalizes the permit `denied` in the same transaction and publishes `issue.task_recovery_permit_denied` instead — a consumed receipt can never stand beside a denied marker. These rows are written after commit, so a server stop in between can leave the marker without its row; the marker's `remediation.status` is the source of truth. Only that exact run can consume it — a wrong run, sibling, expired permit or stale authorization is refused and recorded (`denied`/`expired`). If a bound run dies before claim outside the claim path (a board cancel, or a paused agent whose queued run is never picked up until the permit expires), the permit stays truthfully `authorized` until a fresh prepare/confirm finalizes it (`issue.task_recovery_permit_superseded` activity) and mints a replacement bound to a new run. A failed permitted run creates no automatic continuation; another remediation requires another human confirmation. Permit lifetime is `expiresInMinutes` (1–120, default 15). If confirmation's outcome is uncertain, the durable handle reports `recovery_required`: inspect the issue's `recoveryBudget.remediation` state rather than confirming again — replay cannot mint a second permit or run.

Reading (`task_recovery.exhausted.read`, descriptor `authority: 'company_access'`) needs an active company membership and issue visibility. Authorizing (`task_recovery.remediate`, descriptor `authority: 'agent_management'`) additionally needs authority over the issue's assignee agent — decided in GH #891 (F4): a company admin or instance admin, a person holding the `agents:create` grant, or the agent's own people (its active steward, its accountable person, or the person who created it). A plain member with none of those — including a stored legacy `viewer` row, which normalizes to member — can see the block but cannot authorize; the refusal is a 403 that says who can. Letting an agent spend past an exhausted budget is a decision about that agent, so it follows agent management rather than issue visibility. The rows that decision rests on (membership, grant, agent, stewardship) are witnessed by the authority stage, so a change between review and confirmation refuses the confirmation.

#### Board session users: "Authorize one run"

A signed-in board user in the web app reaches the same operation from the issue page's recovery banner, without a board key: `POST /api/human-control/issues/:issueId/recovery-run/preview` returns the readback and its preconditions; `POST /api/human-control/issues/:issueId/recovery-run/authorize` with `{ preconditions }` re-resolves the operation under its locks, refuses (409) if anything it was pinned to changed, and then executes exactly as a board-key confirm does (same permit, same bound run, same activity). The UI does both in one deliberate action behind a confirm dialog. Only an interactive session (`actor.source = session` with a verified session credential) is accepted — board keys use prepare/confirm, and assistant grants, agents and the implicit local operator are refused. The permit records `authorizedVia: "session"` (activity `details.grantedVia`); there is no durable handle on this path, so on an uncertain outcome read the issue's `recoveryBudget.remediation` rather than authorizing again. The permit's `actionHandleId` on this path is a server-generated action id, not a handle.

#### No other way onto an exhausted issue

The heartbeat claim gate only sees runs whose context names the issue, so every other way to hand the issue to a run checks the marker too (GH #891 F-A): `POST /api/issues/:id/checkout`, execution-lock adoption on any agent mutation (PATCH, comments, plugin/MCP actions that go through `assertCheckoutOwner`), and an agent PATCH that moves the issue into `in_progress` are refused (409, `code: task_recovery_budget_exhausted`) for every caller except the exact permit-bound run after its claim consumed the permit.

Attribution always comes from the authenticated board user of the confirming request — never from the handle or its payload. A confirmed handle proves only that prepare and confirm were made with the same board key; a consumed handle is not consent evidence and must not be presented as one. The same holds for the session path: it shows that the signed-in session sent the review and the authorize call, nothing more.

The two remediation paths compose: the explicit `POST /api/issues/:id/recovery-budget/clear` remains the only clear, and `task_recovery.remediate` is the only way a run goes ahead while the marker persists. If a board user clears while a permit is still `authorized`, the clear finalizes the permit as `denied` (`issue.task_recovery_permit_denied`), cancels the still-claimable bound run, then removes the marker — a bound run can never slip through as an ordinary wake after the marker is gone, and the activity log keeps the permit evidence.

Hiring dialogs and the remaining app pages are separate pending coverage. The [coverage ledger](plans/2026-09-29-human-control-plane-transport-coverage.md) records that work and its acceptance criteria.

## Expiry, refusal and recovery

Prepared handles expire after 15 minutes and are bound to the original human, key, target, operation and resolved preconditions. Confirmation checks current access again. A changed owner, permission or revision may require a new preparation. A handle gets one execution attempt; consumption alone does not prove the domain effect completed exactly once.

When a response reports `recovery_required`, inspect the currently authorized canonical resource named by its safe reference. Report uncertainty; do not blindly repeat a write, skill installation or wake. Cached full domain results are never returned in terminal refusals. Recovery references require current resource/owner access and disappear when that access is lost. Replaying a consumed handle does not execute again.

File bytes, encrypted secret input/output, public pre-login continuity and installed plugin actions have additional pending contracts. They are not supplied by JSON fallback or a returned link. Existing OAuth assistant and MK laptop bridge keep their separate authority and behavior.

## Evidence

Foundation commits `8185789b5` and `0fc627204` passed real local DB/HTTP and registered SDK tests, focused typechecks and independent task review. The latter fixes cached-result access, mixed-case privacy classification and skill-retry recovery references; its 110-test containing run passed. See [build evidence](plans/2026-09-29-workforce-build-evidence.md) for exact scope, overlapping counts and unverified launch gates.
