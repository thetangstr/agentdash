# Full-Flow Demo — Slice 2b-core: the mandate gate (verify → KYA → attest)

**Date:** 2026-07-16
**Repo:** agentdash (paperclip), branch `feat/agentdash-mcp-package`, local `pnpm dev`.
**Linear:** CLO-147 (+ composite call CLO-157). **Predecessors:** Slice 1 (mandate primitive + Clockchain client), Slice 2a (agent DID provisioning). Branch head after 2a: `a7b49050b`.

## Context

Gate model (locked 2026-07-16): AgentDash can't intercept a running agent's direct tool calls, so "every consequential action is mandate-checked" means the agent **routes its action through a server-side mandated action** — the composite `verify_delegation_at` + KYA + `attest_action` (CLO-157). 2b-core builds that gate's **logic** (service + the two missing Clockchain wrappers + tests). The agent-facing **surface** (REST route + AgentDash MCP tool) is deferred to 2b-surface; the approvals **bounce-back** on denial is 2c.

## Non-goals (2b-core)

- No REST route, no MCP tool registration (2b-surface).
- No approvals row / pause / resume (2c) — a denied action just returns `{ authorized:false, reason }`.
- No agent-loop wiring, no UI.

## Design

### A. Two new `clockchainService` wrappers
Add to `server/src/services/clockchain.ts`, same flag-gated / never-throw / truthful discipline as the existing wrappers (use the shared `callTool`):
- `verifyIdentityAt(input: { did: string; at: string }): Promise<{ status: "valid" | "invalid" | "unavailable" }>` — wraps `verify_identity_at`. Returns `unavailable` when disabled/on error; `valid` only when the tool reports the identity valid at `at`; else `invalid`.
- `attestAction(input: { agentDid: string; action: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }): Promise<{ attested: boolean; ledgerId?: string; blockHeight?: number; status?: "anchored" | "pending" | "degraded" }>` — wraps `attest_action`. `attested:true` only when a receipt/eventHash comes back; `status` reflects the honest anchor state; `{ attested:false }` when disabled/on error.

### B. `mandatedActionService` — the gate
New `server/src/services/mandated-action.ts`:
`mandatedActionService(db, clock = clockchainService(), identity = agentIdentityService(db, clock), mandates = mandatesService(db, clock, identity)) => { performMandatedAction(input) }`

`performMandatedAction(input: { granteeAgentId: string; mandateId: string; counterpartyDid: string; action: string; payload?: Record<string, unknown> }): Promise<MandatedActionResult>` where
`MandatedActionResult = { authorized: boolean; reason?: string; receipt?: { ledgerId?: string; blockHeight?: number; status: "anchored" | "pending"; flagged?: boolean } }`

Sequence:
1. **Mandate check (fail-closed):** `verdict = await mandates.verifyMandate(mandateId, now)`. If `verdict.status !== "authorized"` → return `{ authorized:false, reason: verdict.reason ?? verdict.status }`. (No KYA, no attest.)
2. **KYA counterparty (fail-closed):** `kya = await clock.verifyIdentityAt({ did: counterpartyDid, at: now.toISOString() })`. If `kya.status !== "valid"` → return `{ authorized:false, reason: "counterparty_" + kya.status }`. (No attest.)
3. **Resolve the actor DID:** `actorDid = await identity.resolveAgentDid(granteeAgentId)`. (Used as the attest actor.)
4. **Attest (fail-open-flagged):** `att = await clock.attestAction({ agentDid: actorDid ?? "", action, inputs: { ...payload, counterpartyDid, mandateId }, outputs: {} })`.
   - If `att.attested && att.ledgerId` → `{ authorized:true, receipt: { ledgerId: att.ledgerId, blockHeight: att.blockHeight, status: "anchored" } }`.
   - Else (attest failed/degraded) → `{ authorized:true, receipt: { status: "pending", flagged: true } }` — the action **is** authorized; the proof just isn't confirmed yet (honest, per workshop A2 fail-open-but-flagged on anchoring).

`now` is injectable for tests (`performMandatedAction(input, now = new Date())`).

### C. Testing & honesty
Unit tests (mock `mandates`, `clock`, `identity`):
- mandate unauthorized (`verifyMandate` → `{status:"unauthorized", reason:"expired"}`) → `{authorized:false, reason:"expired"}`; `verifyIdentityAt`/`attestAction` NOT called.
- counterparty invalid (`verifyIdentityAt` → `{status:"invalid"}`) → `{authorized:false, reason:"counterparty_invalid"}`; `attestAction` NOT called.
- counterparty unavailable (`{status:"unavailable"}`) → fail-closed `{authorized:false, reason:"counterparty_unavailable"}`; `attestAction` NOT called.
- happy path (mandate authorized, KYA valid, attest `{attested:true, ledgerId, blockHeight}`) → `{authorized:true, receipt:{ledgerId, blockHeight, status:"anchored"}}`; `attestAction` called with `agentDid: actorDid`.
- attest degraded (`{attested:false}`) with mandate+KYA passing → `{authorized:true, receipt:{status:"pending", flagged:true}}`.
- Honesty: `anchored` only on a real ledgerId; fail-closed on identity means `unavailable` denies (never proceeds on an unverifiable counterparty).

## Acceptance criteria (2b-core)
- [ ] `clockchainService` exposes `verifyIdentityAt` + `attestAction`, flag-gated, never throw, truthful; tested (flag-off + mocked-fetch cases).
- [ ] `mandatedActionService.performMandatedAction` composes verifyMandate → KYA → attest with the exact fail-closed (mandate, identity) / fail-open-flagged (attest) semantics; `now` injectable.
- [ ] Unit tests cover all branches (deny-on-mandate, deny-on-invalid-counterparty, deny-on-unavailable-counterparty, happy anchored, degraded-flagged) asserting which downstream calls happen; focused vitest green; server typecheck exit 0.
- [ ] No route/tool/approvals/UI (2b-surface, 2c deferred).

## Open questions / follow-ups
- Exact `verify_identity_at` / `attest_action` request+response field names — confirm against the live tools (wrappers read documented fields with fallbacks; the flag-gated integration test locks them when a testnet key is available).
- Whether `performMandatedAction` should persist an attestation record in AgentDash — deferred; for now it returns the receipt. Persistence + activity-log surfacing can ride with 2b-surface/2c.
