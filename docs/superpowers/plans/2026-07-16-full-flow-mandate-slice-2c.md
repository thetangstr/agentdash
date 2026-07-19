# Full-Flow Demo — Slice 2c (mandate bounce-back) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** On a mandate-widening denial, create an `approvals` row + pause the grantee agent (`enforceMandatedAction`), and resume the agent when the approval is approved — reusing the budget hard-stop pattern.

**Architecture:** `enforceMandatedAction` wraps the pure `performMandatedAction`, injecting `approvalService` + `agentService`. `"mandate"` added to `PAUSE_REASONS`. The route calls the wrapper. The approvals-approve handler resumes the grantee on a `mandate_violation` approval.

**Tech Stack:** TypeScript ESM, Express 5, vitest + supertest, embedded Postgres, pnpm workspaces.

## Global Constraints

- Reuse existing services: `approvalService(db).create(companyId, { type, requestedByAgentId?, payload })` → approval (with `.id`); `agentService(db).pause(id, reason)` / `.resume(id)`.
- ESM `.js` specifiers. `performMandatedAction` stays pure/unchanged.
- Only mandate-widening reasons escalate: `BOUNCE_BACK_REASONS = new Set(["expired","over_cap","out_of_scope"])`.
- Test command: `pnpm exec vitest run --project @paperclipai/server <file>`; typecheck `pnpm --filter @paperclipai/server run typecheck` (exit 0), and `pnpm --filter @paperclipai/shared run typecheck`/build for the constants change.
- Stage ONLY each task's files with explicit `git add`. Commit on `feat/agentdash-mcp-package`.
- Spec: `docs/superpowers/specs/2026-07-16-full-flow-mandate-slice-2c-design.md`.

---

### Task 1: `enforceMandatedAction` + `"mandate"` pause reason + route wiring

**Files:**
- Modify: `packages/shared/src/constants.ts` (add `"mandate"` to `PAUSE_REASONS`)
- Modify: `server/src/services/agents.ts` (widen `pause` reason union)
- Modify: `server/src/services/mandated-action.ts` (inject deps + `enforceMandatedAction` + `companyId` on input)
- Modify: `server/src/routes/mandated-actions.ts` (call `enforceMandatedAction`)
- Test: `server/src/__tests__/mandated-action-service.test.ts` (add enforce cases)

**Interfaces:**
- Produces: `mandatedActionService(db, clock?, identity?, mandates?, approvals?, agents?) => { performMandatedAction, enforceMandatedAction }`; `MandatedActionInput` gains `companyId: string`.

- [ ] **Step 1: Constants.** In `packages/shared/src/constants.ts`, change `export const PAUSE_REASONS = ["manual", "budget", "system"] as const;` to `export const PAUSE_REASONS = ["manual", "budget", "system", "mandate"] as const;`

- [ ] **Step 2: Widen pause reason.** In `server/src/services/agents.ts`, the `pause` method signature reads `pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {`. Add `"mandate"`: `reason: "manual" | "budget" | "system" | "mandate" = "manual"`.

- [ ] **Step 3: Failing enforce tests.** In `mandated-action-service.test.ts`, extend the `svc(...)` helper to also accept/inject mock `approvals` + `agents`, defaulting to `approvals = { create: vi.fn(async () => ({ id: "ap1" })) }` and `agents = { pause: vi.fn(async () => {}) }`, passed as the 5th/6th args to `mandatedActionService`. Add a `describe("enforceMandatedAction")`:
```ts
const enforceInput = { ...baseInput, companyId: "co1" };

it("escalates a qualifying denial: creates a mandate_violation approval + pauses the grantee", async () => {
  const { s, approvals, agents } = svc({ mandates: { verifyMandate: vi.fn(async () => ({ status: "unauthorized", reason: "expired" })) } });
  const r = await s.enforceMandatedAction(enforceInput, NOW);
  expect(r).toMatchObject({ authorized: false, reason: "expired", escalated: true, approvalId: "ap1" });
  expect(approvals.create).toHaveBeenCalledWith("co1", expect.objectContaining({ type: "mandate_violation", requestedByAgentId: "a2" }));
  expect(agents.pause).toHaveBeenCalledWith("a2", "mandate");
});

it("does NOT escalate a non-widening denial (counterparty_invalid)", async () => {
  const { s, approvals, agents } = svc({ clock: { verifyIdentityAt: vi.fn(async () => ({ status: "invalid" })), attestAction: vi.fn() } });
  const r = await s.enforceMandatedAction(enforceInput, NOW);
  expect(r).toMatchObject({ authorized: false, reason: "counterparty_invalid", escalated: false });
  expect(approvals.create).not.toHaveBeenCalled();
  expect(agents.pause).not.toHaveBeenCalled();
});

it("does NOT escalate an authorized action", async () => {
  const { s, approvals, agents } = svc();
  const r = await s.enforceMandatedAction(enforceInput, NOW);
  expect(r).toMatchObject({ authorized: true, escalated: false });
  expect(approvals.create).not.toHaveBeenCalled();
  expect(agents.pause).not.toHaveBeenCalled();
});
```
(Update the `svc` helper so its return includes `approvals` and `agents`.)

- [ ] **Step 4: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandated-action-service.test.ts`.

- [ ] **Step 5: Implement.** In `server/src/services/mandated-action.ts`:
  - Add imports: `import { approvalService, agentService } from "./index.js";` (confirm the barrel exports both — `approvalService` and `agentService` are exported from `server/src/services/index.ts`).
  - Add `companyId: string;` to `MandatedActionInput`.
  - Add near the top: `const BOUNCE_BACK_REASONS = new Set(["expired", "over_cap", "out_of_scope"]);`
  - Change the factory signature to `export function mandatedActionService(db: Db, clock = clockchainService(), identity = agentIdentityService(db, clock), mandates = mandatesService(db, clock, identity), approvals = approvalService(db), agents = agentService(db)) {`
  - Add the method:
```ts
async function enforceMandatedAction(input: MandatedActionInput, now: Date = new Date()): Promise<MandatedActionResult & { escalated: boolean; approvalId?: string }> {
  const result = await performMandatedAction(input, now);
  if (!result.authorized && result.reason && BOUNCE_BACK_REASONS.has(result.reason)) {
    const approval = await approvals.create(input.companyId, {
      type: "mandate_violation",
      requestedByAgentId: input.granteeAgentId,
      payload: { mandateId: input.mandateId, action: input.action, counterpartyDid: input.counterpartyDid, reason: result.reason },
    });
    await agents.pause(input.granteeAgentId, "mandate");
    return { ...result, escalated: true, approvalId: (approval as { id: string }).id };
  }
  return { ...result, escalated: false };
}
```
  - Add `enforceMandatedAction` to the returned object.
  > If importing `approvalService`/`agentService` from `./index.js` creates a circular import (index re-exports mandated-action), import them directly from `./approvals.js` and `./agents.js` instead. Check and use whichever compiles.

- [ ] **Step 6: Route uses the wrapper.** In `server/src/routes/mandated-actions.ts`, change the service call to `enforceMandatedAction` and pass `companyId`:
```ts
const result = await svc.enforceMandatedAction({
  companyId,
  granteeAgentId,
  mandateId: req.body.mandateId,
  counterpartyDid: req.body.counterpartyDid,
  action: req.body.action,
  payload: req.body.payload,
});
res.json(result);
```

- [ ] **Step 7: Run — GREEN + typecheck.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandated-action-service.test.ts` (green, incl. the pre-existing performMandatedAction tests); `pnpm --filter @paperclipai/server run typecheck` exit 0; `pnpm --filter @paperclipai/shared run typecheck` (or build) exit 0. Also re-run the route test `server/src/__tests__/mandated-actions-route.test.ts` — the 200 not_found case now returns `{authorized:false, reason:"not_found", escalated:false}` (not_found is NOT a bounce-back reason), so update that assertion to `expect(res.body).toMatchObject({ authorized:false, reason:"not_found" })` (or include `escalated:false`).

- [ ] **Step 8: Commit.**
```bash
git add packages/shared/src/constants.ts server/src/services/agents.ts server/src/services/mandated-action.ts server/src/routes/mandated-actions.ts server/src/__tests__/mandated-action-service.test.ts server/src/__tests__/mandated-actions-route.test.ts
git commit -m "feat(server): enforceMandatedAction — escalate mandate-widening denials (approval + pause grantee)"
```

---

### Task 2: Resume the grantee on approval

**Files:**
- Modify: `server/src/routes/approvals.ts`
- Test: `server/src/__tests__/mandate-bounceback-resume.test.ts`

**Interfaces:**
- Consumes: `agentService` (pause/resume), `approvalService`.

- [ ] **Step 1: Failing resume test.** Create `server/src/__tests__/mandate-bounceback-resume.test.ts` (supertest + embedded PG, mirroring `mandated-actions-route.test.ts`'s harness + the approvals route). Read `server/src/routes/approvals.ts` to see how to mount `approvalRoutes(db)` and what a board actor looks like. Structure:
  - Seed a company + an agent; pause the agent via `agentService(db).pause(agentId, "mandate")`.
  - Create a `mandate_violation` approval via `approvalService(db).create(companyId, { type: "mandate_violation", requestedByAgentId: agentId, payload: {} })`; grab its id.
  - Mount `approvalRoutes(db)` on an express app with an injected **board** actor (`{ type:"board", source:"local_implicit", ... }` — copy the exact board-actor shape the existing approvals/route tests use) + the error handler.
  - POST `/approvals/:id/approve` with a valid `resolveApprovalSchema` body.
  - Assert: response ok; then `agentService(db).get(agentId)` (or select the agent row) shows `status` no longer `"paused"` and `pauseReason` null.
  > If wiring the full `approvalRoutes` harness (it takes options like `pluginWorkerManager`) is heavy, instead unit-test the resume branch by extracting/mirroring its condition, OR mount with the minimal options the constructor allows. Prefer the real supertest path; fall back only if the constructor needs unavailable deps — and say so in the report.

- [ ] **Step 2: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandate-bounceback-resume.test.ts`.

- [ ] **Step 3: Implement.** In `server/src/routes/approvals.ts`:
  - Import `agentService` from `../services/index.js` (add to the existing services import block).
  - In the `/approvals/:id/approve` handler, after the approval is successfully approved (near the existing `if (approval.requestedByAgentId) { heartbeat.wakeup(...) }` block), add:
```ts
if (approval.type === "mandate_violation" && approval.requestedByAgentId) {
  try { await agentService(db).resume(approval.requestedByAgentId); } catch { /* already resumed/terminated — non-fatal */ }
}
```
  (Use the `approval` object already loaded in the handler for its `type`/`requestedByAgentId`.)

- [ ] **Step 4: Run — GREEN + typecheck.** Same test → green; `pnpm --filter @paperclipai/server run typecheck` exit 0.

- [ ] **Step 5: Commit.**
```bash
git add server/src/routes/approvals.ts server/src/__tests__/mandate-bounceback-resume.test.ts
git commit -m "feat(server): resume the grantee agent when a mandate_violation approval is approved"
```

---

## Self-Review

- Spec §A (reasons) → Task 1 Step 5. §B (enforce) → Task 1. §C (pause reason) → Task 1 Steps 1–2. §D (route) → Task 1 Step 6. §E (resume) → Task 2. §F (tests) → both. Acceptance criteria mapped.
- Placeholder scan: the resume-test harness has an explicit fallback (real supertest path preferred; minimal-mount fallback documented) — concrete, not a vague TODO.
- Type consistency: `enforceMandatedAction` return `MandatedActionResult & { escalated, approvalId? }`; `MandatedActionInput.companyId` used by the route + enforce; `approvals.create(companyId, {...})` / `agents.pause(id, "mandate")` / `agents.resume(id)` match the real service signatures.
- Circular-import guard called out in Task 1 Step 5 (import from `./approvals.js`/`./agents.js` if the barrel loops).
- No over-build: no UI, no re-grant flow.
