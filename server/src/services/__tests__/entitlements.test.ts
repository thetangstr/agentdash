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
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  const db = { insert } as unknown as Db;
  return { db, insert, values, onConflictDoUpdate, onConflictDoNothing };
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

describe("entitlementsService.setStripeIds", () => {
  it("upserts stripeCustomerId and stripeSubscriptionId", async () => {
    const { db, insert, values, onConflictDoUpdate } = makeInsertDb();
    const svc = entitlementsService(db);
    await svc.setStripeIds("c1", "cus_abc", "sub_xyz");
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      companyId: "c1",
      planId: "free",
      stripeCustomerId: "cus_abc",
      stripeSubscriptionId: "sub_xyz",
    });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    const arg = onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: { stripeCustomerId: string | null; stripeSubscriptionId: string | null };
    };
    expect(arg.set.stripeCustomerId).toBe("cus_abc");
    expect(arg.set.stripeSubscriptionId).toBe("sub_xyz");
  });

  it("accepts null values for partial updates", async () => {
    const { db, values } = makeInsertDb();
    const svc = entitlementsService(db);
    await svc.setStripeIds("c1", null, "sub_xyz");
    expect(values).toHaveBeenCalledWith({
      companyId: "c1",
      planId: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: "sub_xyz",
    });
  });

  it("does not clobber existing stripeSubscriptionId when called with null (order-independent upsert)", async () => {
    const { db, onConflictDoUpdate } = makeInsertDb();
    const svc = entitlementsService(db);
    // checkout.session.completed learns customer id but not subscription id.
    // A previously-stored stripeSubscriptionId must not be overwritten to null.
    await svc.setStripeIds("c1", "cus_abc", null);
    const arg = onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(arg.set).toEqual({ stripeCustomerId: "cus_abc" });
    expect(arg.set).not.toHaveProperty("stripeSubscriptionId");
  });

  it("uses onConflictDoNothing when both ids are null", async () => {
    const { db, onConflictDoNothing, onConflictDoUpdate } = makeInsertDb();
    const svc = entitlementsService(db);
    await svc.setStripeIds("c1", null, null);
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
    expect(onConflictDoUpdate).not.toHaveBeenCalled();
  });
});

describe("entitlementsService.setSubscriptionStatus", () => {
  it("upserts subscriptionStatus and currentPeriodEnd", async () => {
    const { db, insert, values, onConflictDoUpdate } = makeInsertDb();
    const svc = entitlementsService(db);
    const end = new Date("2025-12-31T00:00:00Z");
    await svc.setSubscriptionStatus("c1", "active", end);
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      companyId: "c1",
      planId: "free",
      subscriptionStatus: "active",
      currentPeriodEnd: end,
    });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    const arg = onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: { subscriptionStatus: string | null; currentPeriodEnd: Date | null };
    };
    expect(arg.set.subscriptionStatus).toBe("active");
    expect(arg.set.currentPeriodEnd).toBe(end);
  });

  it("accepts null for status and periodEnd (cancel flow)", async () => {
    const { db, values } = makeInsertDb();
    const svc = entitlementsService(db);
    await svc.setSubscriptionStatus("c1", "canceled", null);
    expect(values).toHaveBeenCalledWith({
      companyId: "c1",
      planId: "free",
      subscriptionStatus: "canceled",
      currentPeriodEnd: null,
    });
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
