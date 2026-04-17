// AgentDash: Entitlements service tests
// Mocks Db with canned row arrays plus a spy on the insert().values().onConflictDoUpdate()
// chain used by setTier.

import { describe, it, expect, vi } from "vitest";
import { entitlementsService } from "../entitlements.js";
import type { Db } from "@agentdash/db";

type Row = { planId: string };

function makeSelectDb(rows: Row[]): Db {
  return {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => Promise.resolve(rows));
      return chain;
    }),
  } as unknown as Db;
}

function makeInsertDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const db = { insert } as unknown as Db;
  return { db, insert, values, onConflictDoUpdate };
}

describe("entitlementsService.getTier", () => {
  it("returns 'free' when no company_plan row exists", async () => {
    const svc = entitlementsService(makeSelectDb([]));
    await expect(svc.getTier("c1")).resolves.toBe("free");
  });

  it("returns the stored tier when a row exists", async () => {
    const svc = entitlementsService(makeSelectDb([{ planId: "pro" }]));
    await expect(svc.getTier("c1")).resolves.toBe("pro");
  });

  it("returns 'free' when stored planId is not a valid tier", async () => {
    const svc = entitlementsService(makeSelectDb([{ planId: "legacy-gold" }]));
    await expect(svc.getTier("c1")).resolves.toBe("free");
  });
});

describe("entitlementsService.setTier", () => {
  it("upserts via insert().values().onConflictDoUpdate()", async () => {
    const { db, insert, values, onConflictDoUpdate } = makeInsertDb();
    const svc = entitlementsService(db);
    await svc.setTier("c1", "enterprise");
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({ companyId: "c1", planId: "enterprise" });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    const arg = onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: { planId: string; activatedAt: Date };
    };
    expect(arg.set.planId).toBe("enterprise");
    expect(arg.set.activatedAt).toBeInstanceOf(Date);
  });
});

describe("entitlementsService.getEntitlements", () => {
  it("materializes the full matrix for the stored tier", async () => {
    const svc = entitlementsService(makeSelectDb([{ planId: "pro" }]));
    const ent = await svc.getEntitlements("c1");
    expect(ent.tier).toBe("pro");
    expect(ent.features.hubspotSync).toBe(true);
    expect(ent.features.prioritySupport).toBe(false);
    expect(ent.limits.agents).toBeGreaterThan(0);
  });

  it("falls back to 'free' entitlements when no row exists", async () => {
    const svc = entitlementsService(makeSelectDb([]));
    const ent = await svc.getEntitlements("c1");
    expect(ent.tier).toBe("free");
    expect(ent.features.hubspotSync).toBe(false);
  });
});
