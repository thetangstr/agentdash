# Full-Flow Demo — Slice 2c: mandate bounce-back (approval + pause + resume)

**Date:** 2026-07-16
**Repo:** agentdash (paperclip), branch `feat/agentdash-mcp-package`.
**Linear:** CLO-147. **Predecessors:** Slices 1, 2a, 2b-core, 2b-surface, 2b-authz. Branch head: `e1bee66`.

## Context

The gate (`performMandatedAction`) returns `{authorized:false, reason}` on a denial. 2c adds the human-in-the-loop bounce-back for the denials that mean "the human needs to widen the mandate": create an `approvals` row, pause the grantee agent, and resume it when the human approves. Reuses the existing budget hard-stop pattern (`agentService.pause/resume`, `approvalService.create`, the paused-agent heartbeat gate, and the approvals-approve wakeup).

## Non-goals
- No UI (a later slice) — the approval surfaces in the existing Approvals inbox.
- No change to the gate logic (2b-core) — 2c wraps it.
- No re-grant/widen flow — approving just un-pauses the agent; actually widening the mandate is out of scope.

## Design

### A. Which denials bounce back
`BOUNCE_BACK_REASONS = new Set(["expired", "over_cap", "out_of_scope"])` (mandate-widening cases). Denials with any other reason (`counterparty_invalid`, `counterparty_unavailable`, `not_grantee`, `not_found`, `revoked`, `actor_unresolved`, flag-off `unavailable`) do NOT escalate — returned as-is. (Workshop: "the one path back is an out-of-scope or over-cap task.")

### B. `enforceMandatedAction` (the escalation wrapper)
Extend `mandatedActionService` to inject `approvals = approvalService(db)` and `agents = agentService(db)`, and add:
`enforceMandatedAction(input, now = new Date()): Promise<MandatedActionResult & { escalated: boolean; approvalId?: string }>`
- `MandatedActionInput` gains `companyId: string` (the approval is company-scoped; the route already has it).
- Logic: `const result = await performMandatedAction(input, now);` then if `!result.authorized && result.reason && BOUNCE_BACK_REASONS.has(result.reason)`:
  - `const approval = await approvals.create(input.companyId, { type: "mandate_violation", requestedByAgentId: input.granteeAgentId, payload: { mandateId: input.mandateId, action: input.action, counterpartyDid: input.counterpartyDid, reason: result.reason } });`
  - `await agents.pause(input.granteeAgentId, "mandate");`
  - return `{ ...result, escalated: true, approvalId: approval.id }`.
  - else return `{ ...result, escalated: false }`.
- `performMandatedAction` stays pure/unchanged (still separately tested).

### C. Enable the "mandate" pause reason
- Add `"mandate"` to `PAUSE_REASONS` (`packages/shared/src/constants.ts`).
- Widen `agentService.pause(id, reason)`'s reason union from `"manual" | "budget" | "system"` to include `"mandate"` (`server/src/services/agents.ts`).

### D. Route uses the wrapper
`server/src/routes/mandated-actions.ts`: call `svc.enforceMandatedAction({ ...body, companyId, granteeAgentId })` instead of `performMandatedAction`. (granteeAgentId still forced to the acting agent, per 2b-authz.) Response now includes `escalated`/`approvalId`.

### E. Resume-on-approve
`server/src/routes/approvals.ts` approve handler: after the approval is approved, if `approval.type === "mandate_violation" && approval.requestedByAgentId`, call `agentService(db).resume(approval.requestedByAgentId)` (alongside the existing `heartbeat.wakeup`). Import `agentService` there.

### F. Testing
- **enforce unit tests** (mock `approvals`/`agents`, drive `performMandatedAction`'s verdict via the existing mocked clock/identity/mandates):
  - qualifying denial (mandate `expired`) → `approvals.create` called with `type:"mandate_violation"` + `requestedByAgentId`; `agents.pause(granteeAgentId, "mandate")` called; returns `escalated:true, approvalId`.
  - non-qualifying denial (`counterparty_invalid`) → no create, no pause, `escalated:false`.
  - authorized → no create, no pause, `escalated:false`.
- **resume route test** (supertest + embedded PG, like the mandated-actions route test): seed a company + agent, pause the agent (`agentService.pause(agentId, "mandate")`), create a `mandate_violation` approval with `requestedByAgentId: agentId`, POST `/approvals/:id/approve` as a board actor, assert the agent's `status` is no longer paused (`pauseReason` cleared).
- **constants**: `PAUSE_REASONS` includes `"mandate"` (assertion or typecheck).
- Typechecks exit 0 (server + shared).

## Acceptance criteria
- [ ] `BOUNCE_BACK_REASONS` gate: only expired/over_cap/out_of_scope escalate; others don't.
- [ ] `enforceMandatedAction` creates a `mandate_violation` approval + pauses the grantee on a qualifying denial, returns `escalated`/`approvalId`; leaves authorized + non-qualifying-denial paths un-escalated.
- [ ] `"mandate"` in `PAUSE_REASONS`; `agentService.pause` accepts it.
- [ ] The route calls `enforceMandatedAction` (grantee still forced to the acting agent).
- [ ] Approving a `mandate_violation` approval resumes the grantee.
- [ ] Unit + resume-route tests green; server & shared typecheck exit 0.

## Open questions / follow-ups
- Exact live reason strings for over-cap/out-of-scope from `verify_delegation_at` — confirm against the live tool; `BOUNCE_BACK_REASONS` may need adjustment once locked (flag-off returns `unavailable`, which correctly does NOT escalate).
- Re-grant/widen-the-mandate flow (vs just un-pause) — deferred.
