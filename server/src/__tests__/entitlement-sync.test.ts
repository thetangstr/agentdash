import { describe, expect, it, vi } from "vitest";
import { entitlementSync } from "../services/entitlement-sync.js";

function makeCompanies(found: { id: string } | null = { id: "co-1" }) {
  return {
    findByStripeSubscriptionId: vi.fn(async () => found),
    findByStripeCustomerId: vi.fn(async () => found),
    update: vi.fn(async () => null),
  };
}

function makeLedger(inserted = true) {
  return {
    record: vi.fn(async () => ({ inserted })),
  };
}

function makeSubscription(status: string, overrides: Record<string, any> = {}) {
  return {
    id: "sub_test",
    customer: "cus_test",
    status,
    items: { data: [{ quantity: 3 }] },
    current_period_end: Math.floor(new Date("2026-06-01").getTime() / 1000),
    ...overrides,
  };
}

function makeEvent(type: string, sub: any, id = "evt_test") {
  return { id, type, data: { object: sub } };
}

describe("entitlementSync.dispatch", () => {
  it("sets plan_tier=pro_trial when subscription is created with status trialing", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("trialing");
    await sync.dispatch(makeEvent("customer.subscription.created", sub));

    expect(companies.update).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({ planTier: "pro_trial" }),
    );
  });

  it("sets plan_tier=pro_active when subscription updated from trialing to active", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("active");
    await sync.dispatch(makeEvent("customer.subscription.updated", sub));

    expect(companies.update).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({ planTier: "pro_active" }),
    );
  });

  it("sets plan_tier=pro_canceled when subscription is deleted", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("canceled");
    await sync.dispatch(makeEvent("customer.subscription.deleted", sub));

    expect(companies.update).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({ planTier: "pro_canceled" }),
    );
  });

  it("does not call update on duplicate event (ledger returns inserted=false)", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger(false); // duplicate
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("active");
    await sync.dispatch(makeEvent("customer.subscription.updated", sub));

    expect(companies.update).not.toHaveBeenCalled();
  });

  it("falls back to findByStripeCustomerId when subscription lookup misses", async () => {
    const companies = {
      findByStripeSubscriptionId: vi.fn(async () => null),
      findByStripeCustomerId: vi.fn(async () => ({ id: "co-2" })),
      update: vi.fn(async () => null),
    };
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("active");
    await sync.dispatch(makeEvent("customer.subscription.updated", sub));

    expect(companies.findByStripeSubscriptionId).toHaveBeenCalledWith("sub_test");
    expect(companies.findByStripeCustomerId).toHaveBeenCalledWith("cus_test");
    expect(companies.update).toHaveBeenCalledWith(
      "co-2",
      expect.objectContaining({ planTier: "pro_active" }),
    );
  });

  it("throws when no company found for subscription", async () => {
    const companies = {
      findByStripeSubscriptionId: vi.fn(async () => null),
      findByStripeCustomerId: vi.fn(async () => null),
      update: vi.fn(async () => null),
    };
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("active");
    await expect(sync.dispatch(makeEvent("customer.subscription.updated", sub))).rejects.toThrow(
      "No company for subscription",
    );
  });

  it("records the event in ledger with correct id and type", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("trialing");
    const event = makeEvent("customer.subscription.created", sub, "evt_unique_123");
    await sync.dispatch(event);

    expect(ledger.record).toHaveBeenCalledWith("evt_unique_123", "customer.subscription.created", event);
  });

  it("no-ops on invoice.paid without throwing", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const event = makeEvent("invoice.paid", { id: "in_test" });
    await expect(sync.dispatch(event)).resolves.toBeUndefined();
    expect(companies.update).not.toHaveBeenCalled();
  });

  it("sets planSeatsPaid from subscription quantity", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("active", { items: { data: [{ quantity: 7 }] } });
    await sync.dispatch(makeEvent("customer.subscription.updated", sub));

    expect(companies.update).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({ planSeatsPaid: 7 }),
    );
  });
});
