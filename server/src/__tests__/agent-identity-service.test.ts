import { describe, expect, it, vi } from "vitest";
import { agentIdentityService } from "../services/agent-identity.ts";

function fakeDb(selectRows: any[]) {
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  return {
    select: vi.fn(() => ({ from: () => ({ where: async () => selectRows }) })),
    update: vi.fn(() => ({ set: updateSet })),
    _updateSet: updateSet,
    _updateWhere: updateWhere,
  };
}

describe("agentIdentityService.resolveAgentDid", () => {
  it("returns the stored did without minting or updating when the agent already has one", async () => {
    const db = fakeDb([{ id: "a1", name: "Vega", clockchainDid: "did:existing" }]);
    const clock = { mintIdentity: vi.fn(async () => ({ minted: true, did: "did:new" })) };
    const svc = agentIdentityService(db as any, clock as any);

    const did = await svc.resolveAgentDid("a1");

    expect(did).toBe("did:existing");
    expect(clock.mintIdentity).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("lazily mints and persists a did when the agent has none", async () => {
    const db = fakeDb([{ id: "a1", name: "Vega", clockchainDid: null }]);
    const clock = { mintIdentity: vi.fn(async () => ({ minted: true, did: "did:new" })) };
    const svc = agentIdentityService(db as any, clock as any);

    const did = await svc.resolveAgentDid("a1");

    expect(did).toBe("did:new");
    expect(clock.mintIdentity).toHaveBeenCalledWith({ agentId: "a1", name: "Vega" });
    expect(db.update).toHaveBeenCalled();
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ clockchainDid: "did:new", updatedAt: expect.any(Date) }),
    );
    expect(db._updateWhere).toHaveBeenCalled();
  });

  it("returns undefined without persisting when the mint fails", async () => {
    const db = fakeDb([{ id: "a1", name: "Vega", clockchainDid: null }]);
    const clock = { mintIdentity: vi.fn(async () => ({ minted: false })) };
    const svc = agentIdentityService(db as any, clock as any);

    const did = await svc.resolveAgentDid("a1");

    expect(did).toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns undefined without minting when the agent is not found", async () => {
    const db = fakeDb([]);
    const clock = { mintIdentity: vi.fn(async () => ({ minted: true, did: "did:new" })) };
    const svc = agentIdentityService(db as any, clock as any);

    const did = await svc.resolveAgentDid("missing");

    expect(did).toBeUndefined();
    expect(clock.mintIdentity).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
