# Full-Flow Demo — Slice 2b-core (the mandate gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the server-side mandate gate logic: two Clockchain wrappers (`verifyIdentityAt`, `attestAction`) and a `mandatedActionService.performMandatedAction` that composes verifyMandate → KYA → attest with fail-closed (mandate, identity) / fail-open-flagged (attest) semantics.

**Architecture:** Extend `clockchainService` with the KYA + attest wrappers (same discipline as the existing four). New `mandatedActionService` composes the Slice-1/2a services. No route/tool/approvals/UI (2b-surface, 2c).

**Tech Stack:** TypeScript ESM (`.js` specifiers), vitest, pnpm workspaces.

## Global Constraints

- Flag-gated by `AGENTDASH_ATTESTATION_ENABLED`; wrappers NEVER throw (return safe value on disabled/error).
- Truthful: `attested:true`/`status:"anchored"` only when a real ledgerId comes back; KYA `valid` only when the tool reports valid.
- **Fail-closed on mandate AND identity** (unauthorized/invalid/unavailable → deny, no downstream call). **Fail-open-flagged on attest** (authorized even if the anchor is pending/degraded, marked `flagged`).
- ESM `.js` specifiers. Service factory `(db, clock?, identity?, mandates?) => ({...})` pattern.
- Test command: `pnpm exec vitest run --project @paperclipai/server <file>`. Typecheck: `pnpm --filter @paperclipai/server run typecheck` (exit 0).
- Stage ONLY each task's files with explicit `git add` (working tree has unrelated pre-existing dirty files). Commit on `feat/agentdash-mcp-package`.
- Spec: `docs/superpowers/specs/2026-07-16-full-flow-mandate-slice-2b-core-design.md`.

---

### Task 1: `verifyIdentityAt` + `attestAction` wrappers

**Files:**
- Modify: `server/src/services/clockchain.ts`
- Test: `server/src/__tests__/clockchain-service.test.ts` (extend)

**Interfaces:**
- Consumes: existing `callTool`, `clockchainEnabled` (Slice 1/2a).
- Produces on `clockchainService()`:
  - `verifyIdentityAt(input: { did: string; at: string }): Promise<{ status: "valid" | "invalid" | "unavailable" }>`
  - `attestAction(input: { agentDid: string; action: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }): Promise<{ attested: boolean; ledgerId?: string; blockHeight?: number; status?: "anchored" | "pending" | "degraded" }>`

- [ ] **Step 1: Failing tests.** In `clockchain-service.test.ts`, add a `describe("KYA + attest wrappers")`:
  - flag off → `verifyIdentityAt({did:"did:x", at:"2026-07-16T00:00:00Z"})` → `{ status: "unavailable" }`; `attestAction({agentDid:"did:a", action:"x"})` → `{ attested: false }`.
  - flag on + mocked fetch returning identity `{ valid: true }` → `verifyIdentityAt` → `{ status: "valid" }`; returning `{ valid: false }` → `{ status: "invalid" }`.
  - flag on + mocked fetch returning `{ ledgerId:"led_a", blockHeight: 9, status:"anchored" }` → `attestAction` → `{ attested:true, ledgerId:"led_a", blockHeight:9, status:"anchored" }`.
  - flag on + fetch rejects → `verifyIdentityAt` → `{status:"unavailable"}`, `attestAction` → `{attested:false}` (no throw).

- [ ] **Step 2: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/clockchain-service.test.ts`.

- [ ] **Step 3: Implement.** In `server/src/services/clockchain.ts`, add before the `return { ... }`:
```ts
async function verifyIdentityAt(input: { did: string; at: string }): Promise<{ status: "valid" | "invalid" | "unavailable" }> {
  if (!clockchainEnabled()) return { status: "unavailable" };
  try {
    const r = await callTool("verify_identity_at", { did: input.did, at: input.at });
    const valid = r.valid ?? r.authorized ?? (r.status === "valid");
    return { status: valid ? "valid" : "invalid" };
  } catch { return { status: "unavailable" }; }
}
async function attestAction(input: { agentDid: string; action: string; inputs?: Record<string, unknown>; outputs?: Record<string, unknown> }): Promise<{ attested: boolean; ledgerId?: string; blockHeight?: number; status?: "anchored" | "pending" | "degraded" }> {
  if (!clockchainEnabled()) return { attested: false };
  try {
    const r = await callTool("attest_action", { agentId: input.agentDid, action: input.action, inputs: input.inputs ?? {}, outputs: input.outputs ?? {} });
    const ledgerId = r.ledgerId ?? r.anchor?.ledgerId;
    if (!ledgerId && !r.eventHash) return { attested: false };
    const status = (r.status ?? r.anchor?.status) as ("anchored" | "pending" | "degraded" | undefined);
    return { attested: true, ledgerId, blockHeight: r.blockHeight ?? r.anchor?.blockHeight, status: status ?? (ledgerId ? "anchored" : "pending") };
  } catch { return { attested: false }; }
}
```
Add `verifyIdentityAt, attestAction` to the returned object.

- [ ] **Step 4: Run — GREEN.** Same command; all cases pass.

- [ ] **Step 5: Commit.**
```bash
git add server/src/services/clockchain.ts server/src/__tests__/clockchain-service.test.ts
git commit -m "feat(server): add verify_identity_at + attest_action wrappers to clockchainService"
```

---

### Task 2: `mandatedActionService.performMandatedAction`

**Files:**
- Create: `server/src/services/mandated-action.ts`
- Test: `server/src/__tests__/mandated-action-service.test.ts`

**Interfaces:**
- Consumes: `clockchainService` (`verifyIdentityAt`, `attestAction`), `agentIdentityService` (`resolveAgentDid`), `mandatesService` (`verifyMandate`).
- Produces: `mandatedActionService(db, clock?, identity?, mandates?) => { performMandatedAction(input, now?) }` returning `MandatedActionResult` (see spec §B).

- [ ] **Step 1: Failing tests.** Create `server/src/__tests__/mandated-action-service.test.ts`. Build the service with mock deps:
```ts
import { describe, expect, it, vi } from "vitest";
import { mandatedActionService } from "../services/mandated-action.ts";

const baseInput = { granteeAgentId: "a2", mandateId: "m1", counterpartyDid: "did:billie", action: "verify_invoice", payload: { amount: 100 } };
const NOW = new Date("2026-07-16T00:00:00Z");

function svc(over: { mandates?: any; clock?: any; identity?: any } = {}) {
  const mandates = over.mandates ?? { verifyMandate: vi.fn(async () => ({ status: "authorized" })) };
  const clock = over.clock ?? { verifyIdentityAt: vi.fn(async () => ({ status: "valid" })), attestAction: vi.fn(async () => ({ attested: true, ledgerId: "led_x", blockHeight: 5, status: "anchored" })) };
  const identity = over.identity ?? { resolveAgentDid: vi.fn(async () => "did:vega") };
  return { s: mandatedActionService({} as any, clock, identity, mandates), mandates, clock, identity };
}

describe("performMandatedAction", () => {
  it("denies (fail-closed) when the mandate is unauthorized; no KYA, no attest", async () => {
    const { s, clock } = svc({ mandates: { verifyMandate: vi.fn(async () => ({ status: "unauthorized", reason: "expired" })) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: false, reason: "expired" });
    expect(clock.verifyIdentityAt).not.toHaveBeenCalled();
    expect(clock.attestAction).not.toHaveBeenCalled();
  });

  it("denies (fail-closed) when the counterparty is invalid; no attest", async () => {
    const { s, clock } = svc({ clock: { verifyIdentityAt: vi.fn(async () => ({ status: "invalid" })), attestAction: vi.fn() } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: false, reason: "counterparty_invalid" });
    expect(clock.attestAction).not.toHaveBeenCalled();
  });

  it("denies (fail-closed) when the counterparty is unavailable", async () => {
    const { s, clock } = svc({ clock: { verifyIdentityAt: vi.fn(async () => ({ status: "unavailable" })), attestAction: vi.fn() } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: false, reason: "counterparty_unavailable" });
    expect(clock.attestAction).not.toHaveBeenCalled();
  });

  it("authorizes and returns an anchored receipt on the happy path", async () => {
    const { s, clock } = svc();
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: true, receipt: { ledgerId: "led_x", blockHeight: 5, status: "anchored" } });
    expect(clock.attestAction).toHaveBeenCalledWith(expect.objectContaining({ agentDid: "did:vega", action: "verify_invoice" }));
  });

  it("authorizes with a flagged pending receipt when the attest is degraded", async () => {
    const { s } = svc({ clock: { verifyIdentityAt: vi.fn(async () => ({ status: "valid" })), attestAction: vi.fn(async () => ({ attested: false })) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: true, receipt: { status: "pending", flagged: true } });
  });
});
```

- [ ] **Step 2: Run — RED.** `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/mandated-action-service.test.ts` → module not found.

- [ ] **Step 3: Implement.** Create `server/src/services/mandated-action.ts`:
```ts
import type { Db } from "@paperclipai/db";
import { clockchainService } from "./clockchain.js";
import { agentIdentityService } from "./agent-identity.js";
import { mandatesService } from "./mandates.js";

export type MandatedActionInput = {
  granteeAgentId: string;
  mandateId: string;
  counterpartyDid: string;
  action: string;
  payload?: Record<string, unknown>;
};
export type MandatedActionResult = {
  authorized: boolean;
  reason?: string;
  receipt?: { ledgerId?: string; blockHeight?: number; status: "anchored" | "pending"; flagged?: boolean };
};

export function mandatedActionService(
  db: Db,
  clock = clockchainService(),
  identity = agentIdentityService(db, clock),
  mandates = mandatesService(db, clock, identity),
) {
  async function performMandatedAction(input: MandatedActionInput, now: Date = new Date()): Promise<MandatedActionResult> {
    // 1. Mandate — fail-closed.
    const verdict = await mandates.verifyMandate(input.mandateId, now);
    if (verdict.status !== "authorized") {
      return { authorized: false, reason: verdict.reason ?? verdict.status };
    }
    // 2. KYA the counterparty — fail-closed on anything but valid.
    const kya = await clock.verifyIdentityAt({ did: input.counterpartyDid, at: now.toISOString() });
    if (kya.status !== "valid") {
      return { authorized: false, reason: `counterparty_${kya.status}` };
    }
    // 3. Actor DID for the attest.
    const actorDid = await identity.resolveAgentDid(input.granteeAgentId);
    // 4. Attest — fail-open-but-flagged on a degraded anchor.
    const att = await clock.attestAction({
      agentDid: actorDid ?? "",
      action: input.action,
      inputs: { ...(input.payload ?? {}), counterpartyDid: input.counterpartyDid, mandateId: input.mandateId },
      outputs: {},
    });
    if (att.attested && att.ledgerId) {
      return { authorized: true, receipt: { ledgerId: att.ledgerId, blockHeight: att.blockHeight, status: "anchored" } };
    }
    return { authorized: true, receipt: { status: "pending", flagged: true } };
  }
  return { performMandatedAction };
}
```

- [ ] **Step 4: Run — GREEN.** Same command; 5 cases pass.

- [ ] **Step 5: Typecheck.** `pnpm --filter @paperclipai/server run typecheck` → exit 0.

- [ ] **Step 6: Commit.**
```bash
git add server/src/services/mandated-action.ts server/src/__tests__/mandated-action-service.test.ts
git commit -m "feat(server): mandatedActionService — verify_delegation_at + KYA + attest gate (fail-closed/fail-open)"
```

---

## Self-Review

- Spec §A (wrappers) → Task 1. §B (gate service) → Task 2. §C (tests/honesty) → across both. All acceptance criteria mapped.
- Placeholder scan: none — wrapper field reads (`r.valid ?? r.authorized ?? ...`, `r.ledgerId ?? r.anchor?.ledgerId`) are concrete defensive fallbacks; live-tool confirmation is the spec's tracked follow-up.
- Type consistency: `verifyIdentityAt → {status}`, `attestAction → {attested, ledgerId?, blockHeight?, status?}`, `performMandatedAction → MandatedActionResult` used identically across tasks; `mandatedActionService(db, clock, identity, mandates)` injection matches the mock shape in the Task-2 tests.
- No over-build: no route/tool/approvals/persistence/UI. `now` injectable only for determinism.
