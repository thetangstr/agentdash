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
});
