import { describe, expect, it, vi } from "vitest";
import { mandatedActionService } from "../services/mandated-action.ts";

const baseInput = { granteeAgentId: "a2", mandateId: "m1", counterpartyDid: "did:billie", action: "verify_invoice", payload: { amount: 100 } };
const NOW = new Date("2026-07-16T00:00:00Z");

function svc(over: { mandates?: any; clock?: any; identity?: any; approvals?: any; agents?: any } = {}) {
  const mandates = over.mandates ?? { verifyMandate: vi.fn(async () => ({ status: "authorized", scope: ["verify_invoice"], spendCapCents: 5000 })) };
  const clock = over.clock ?? { verifyIdentityAt: vi.fn(async () => ({ status: "valid" })), attestAction: vi.fn(async () => ({ attested: true, ledgerId: "led_x", blockHeight: 5, status: "anchored" })) };
  const identity = over.identity ?? { resolveAgentDid: vi.fn(async () => "did:vega") };
  const approvals = over.approvals ?? { create: vi.fn(async () => ({ id: "ap1" })) };
  const agents = over.agents ?? { pause: vi.fn(async () => {}) };
  return {
    s: mandatedActionService({} as any, clock, identity, mandates, approvals, agents),
    mandates,
    clock,
    identity,
    approvals,
    agents,
  };
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
    const { s, clock, mandates } = svc();
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: true, receipt: { ledgerId: "led_x", blockHeight: 5, status: "anchored" } });
    expect(clock.attestAction).toHaveBeenCalledWith(expect.objectContaining({ agentDid: "did:vega", action: "verify_invoice" }));
    expect(mandates.verifyMandate).toHaveBeenCalledWith("m1", expect.any(Date), "a2");
  });

  it("denies (fail-closed) when the mandate is not for this grantee (not_grantee); no KYA, no attest", async () => {
    const { s, clock } = svc({ mandates: { verifyMandate: vi.fn(async () => ({ status: "unauthorized", reason: "not_grantee" })) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: false, reason: "not_grantee" });
    expect(clock.verifyIdentityAt).not.toHaveBeenCalled();
    expect(clock.attestAction).not.toHaveBeenCalled();
  });

  it("authorizes with a flagged pending receipt when the attest fails (no ledgerId)", async () => {
    const { s } = svc({ clock: { verifyIdentityAt: vi.fn(async () => ({ status: "valid" })), attestAction: vi.fn(async () => ({ attested: false })) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: true, receipt: { ledgerId: undefined, blockHeight: undefined, status: "pending", flagged: true } });
  });

  it("flags a degraded anchor as pending (keeping its ledgerId) — never labels it anchored", async () => {
    const { s } = svc({ clock: { verifyIdentityAt: vi.fn(async () => ({ status: "valid" })), attestAction: vi.fn(async () => ({ attested: true, ledgerId: "led_d", blockHeight: 3, status: "degraded" })) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: true, receipt: { ledgerId: "led_d", blockHeight: 3, status: "pending", flagged: true } });
  });

  it("denies (fail-closed) when the actor DID cannot be resolved; no attest", async () => {
    const { s, clock } = svc({ identity: { resolveAgentDid: vi.fn(async () => undefined) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: false, reason: "actor_unresolved" });
    expect(clock.attestAction).not.toHaveBeenCalled();
  });

  it("denies out_of_scope when the action is not in the mandate's scope; no attest", async () => {
    const { s, clock } = svc({ mandates: { verifyMandate: vi.fn(async () => ({ status: "authorized", scope: ["other_action"], spendCapCents: 5000 })) } });
    const r = await s.performMandatedAction(baseInput, NOW);
    expect(r).toEqual({ authorized: false, reason: "out_of_scope" });
    expect(clock.attestAction).not.toHaveBeenCalled();
  });

  it("denies over_cap when the payload amountCents exceeds the mandate's spend cap; no attest", async () => {
    const { s, clock } = svc({ mandates: { verifyMandate: vi.fn(async () => ({ status: "authorized", scope: ["verify_invoice"], spendCapCents: 100 })) } });
    const r = await s.performMandatedAction({ ...baseInput, payload: { amountCents: 999999 } }, NOW);
    expect(r).toEqual({ authorized: false, reason: "over_cap" });
    expect(clock.attestAction).not.toHaveBeenCalled();
  });
});

describe("enforceMandatedAction", () => {
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
});
