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

All 20 foundation operations are version 1, company-targeted. Other target kinds currently have no domain operations in this foundation.

| Area | Operation IDs |
| --- | --- |
| Templates/knowledge | `workforce.templates.list`, `workforce.brief.read`, `workforce.brief.publish`, `workforce.proposals.list`, `workforce.proposals.review` |
| Enrollment/objectives | `workforce.enrollment.read`, `workforce.enrollment.create`, `workforce.enrollment.update` |
| Readiness/first job | `workforce.readiness.read`, `workforce.learning.acknowledge`, `workforce.skills.retry`, `workforce.first_job.start` |
| Human questions | `human_questions.pending.list`, `human_questions.read`, `human_questions.respond`, `human_questions.cancel`, `human_questions.replace` |
| Owner recovery | `human_questions.owner.assign`, `human_questions.stewardship.assign`, `human_questions.stewardship.transfer` |

Questions retain their actual named owner and source visibility. Answers are private to the original job by default; eligible company-wide sharing is an explicit choice. Cancellation supplies no answer and required work stays held. A company selection or template instruction cannot impersonate the answer owner or grant sharing authority.

Hiring dialogs and the remaining app pages are separate pending coverage. The [coverage ledger](plans/2026-09-29-human-control-plane-transport-coverage.md) records that work and its acceptance criteria.

## Expiry, refusal and recovery

Prepared handles expire after 15 minutes and are bound to the original human, key, target, operation and resolved preconditions. Confirmation checks current access again. A changed owner, permission or revision may require a new preparation. A handle gets one execution attempt; consumption alone does not prove the domain effect completed exactly once.

When a response reports `recovery_required`, inspect the currently authorized canonical resource named by its safe reference. Report uncertainty; do not blindly repeat a write, skill installation or wake. Cached full domain results are never returned in terminal refusals. Recovery references require current resource/owner access and disappear when that access is lost. Replaying a consumed handle does not execute again.

File bytes, encrypted secret input/output, public pre-login continuity and installed plugin actions have additional pending contracts. They are not supplied by JSON fallback or a returned link. Existing OAuth assistant and MK laptop bridge keep their separate authority and behavior.

## Evidence

Foundation commits `8185789b5` and `0fc627204` passed real local DB/HTTP and registered SDK tests, focused typechecks and independent task review. The latter fixes cached-result access, mixed-case privacy classification and skill-retry recovery references; its 110-test containing run passed. See [build evidence](plans/2026-09-29-workforce-build-evidence.md) for exact scope, overlapping counts and unverified launch gates.
