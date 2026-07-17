import { describe, expect, it, vi } from "vitest";
import { mandatesService } from "../services/mandates.ts";

function fakeDb(insertedRow: any, selectRows: any[] = [insertedRow]) {
  const chain = {
    values: vi.fn(() => chain),
    returning: vi.fn(async () => [insertedRow]),
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    from: vi.fn(() => chain),
    then: undefined as any,
  };
  return {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    select: vi.fn(() => ({ from: () => ({ where: async () => selectRows }) })),
    _chain: chain,
  };
}

const baseInput = {
  companyId: "co1", grantorAgentId: "a1", granteeAgentId: "a2",
  scope: ["attest"], permissionKey: "clockchain:attest",
  spendCapCents: 5000, expiresAt: new Date("2030-01-01T00:00:00Z"),
};

function fakeIdentity() {
  return { resolveAgentDid: vi.fn(async (id: string) => (id === "a1" ? "did:atlas" : "did:vega")) };
}

describe("mandatesService.createMandate", () => {
  it("anchors and writes back cc fields when the clock anchors", async () => {
    const row = { id: "m1", ...baseInput, status: "active", ccLedgerId: null };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(async () => ({ anchored: true, ledgerId: "led_9", blockHeight: 7 })), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const out = await svc.createMandate(baseInput);
    expect(clock.delegateAuthority).toHaveBeenCalledWith({ parentDid: "did:atlas", childDid: "did:vega", scope: ["attest"], until: "2030-01-01T00:00:00.000Z" });
    expect(db.update).toHaveBeenCalled(); // wrote back cc fields
    expect(out.id).toBe("m1");
    expect(out.ccLedgerId).toBe("led_9"); // returned value carries the live anchor
    expect(out.ccBlockHeight).toBe(7);
  });

  it("still creates the row (cc null) when anchoring is unavailable — never throws", async () => {
    const row = { id: "m2", ...baseInput, status: "active", ccLedgerId: null };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(async () => ({ anchored: false })), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const out = await svc.createMandate(baseInput);
    expect(out.id).toBe("m2");
    expect(db.update).not.toHaveBeenCalled(); // nothing to write back
  });

  it("still returns the row when the clock THROWS — anchoring never breaks the grant", async () => {
    const row = { id: "m2b", ...baseInput, status: "active", ccLedgerId: null };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(async () => { throw new Error("boom"); }), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const out = await svc.createMandate(baseInput);
    expect(out.id).toBe("m2b");
    expect(db.update).not.toHaveBeenCalled(); // nothing to write back on a throw
  });

  it("returns the row without anchoring when a DID fails to resolve — grant still created", async () => {
    const row = { id: "m2c", ...baseInput, status: "active", ccLedgerId: null };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(async () => ({ anchored: true, ledgerId: "led_9" })), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = { resolveAgentDid: vi.fn(async (id: string) => (id === "a1" ? "did:atlas" : undefined)) };
    const svc = mandatesService(db as any, clock as any, identity as any);
    const out = await svc.createMandate(baseInput);
    expect(out.id).toBe("m2c");
    expect(clock.delegateAuthority).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("mandatesService.verifyMandate", () => {
  it("returns unauthorized 'expired' for a past expiry without calling the chain", async () => {
    const row = { id: "m3", ...baseInput, expiresAt: new Date("2020-01-01T00:00:00Z"), status: "active", ccLedgerId: "led_9", ccBlockHeight: 7 };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const v = await svc.verifyMandate("m3", new Date("2026-07-15T00:00:00Z"));
    expect(v.status).toBe("unauthorized");
    expect(v.reason).toBe("expired");
    expect(clock.getLogEntry).not.toHaveBeenCalled();
    expect(identity.resolveAgentDid).not.toHaveBeenCalled();
  });

  it("returns unauthorized 'revoked' for a revoked mandate without calling the chain", async () => {
    const row = { id: "m5", ...baseInput, status: "revoked", ccLedgerId: "led_9", ccBlockHeight: 7 };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const v = await svc.verifyMandate("m5", new Date("2026-07-15T00:00:00Z"));
    expect(v.status).toBe("unauthorized");
    expect(v.reason).toBe("revoked");
    expect(clock.getLogEntry).not.toHaveBeenCalled();
    expect(identity.resolveAgentDid).not.toHaveBeenCalled();
  });

  it("returns unauthorized 'not_found' for a missing mandate without calling the chain", async () => {
    const db = fakeDb(null, []); // select resolves to []
    const clock = { delegateAuthority: vi.fn(), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const v = await svc.verifyMandate("missing", new Date("2026-07-15T00:00:00Z"));
    expect(v.status).toBe("unauthorized");
    expect(v.reason).toBe("not_found");
    expect(clock.getLogEntry).not.toHaveBeenCalled();
    expect(identity.resolveAgentDid).not.toHaveBeenCalled();
  });

  it("delegates to the chain for an active, unexpired mandate", async () => {
    const row = { id: "m4", ...baseInput, status: "active", ccLedgerId: "led_9", ccBlockHeight: 7 };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const v = await svc.verifyMandate("m4", new Date("2026-07-15T00:00:00Z"), "a2");
    expect(v).toMatchObject({ status: "authorized" });
    expect(clock.getLogEntry).toHaveBeenCalled();
  });

  it("returns unauthorized 'not_grantee' when the caller doesn't match the mandate's grantee, without calling the chain", async () => {
    const row = { id: "m6", ...baseInput, granteeAgentId: "a2", status: "active", ccLedgerId: "led_9", ccBlockHeight: 7 };
    const db = fakeDb(row);
    const clock = { delegateAuthority: vi.fn(), getLogEntry: vi.fn(async () => ({ found: true, anchored: true })) };
    const identity = fakeIdentity();
    const svc = mandatesService(db as any, clock as any, identity as any);
    const v = await svc.verifyMandate("m6", new Date("2026-07-15T00:00:00Z"), "someone-else");
    expect(v).toEqual({ status: "unauthorized", reason: "not_grantee" });
    expect(clock.getLogEntry).not.toHaveBeenCalled();
    expect(identity.resolveAgentDid).not.toHaveBeenCalled();
  });
});
