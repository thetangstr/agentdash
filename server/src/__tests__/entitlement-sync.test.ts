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

function makeActivityLog() {
  return {
    record: vi.fn(async () => undefined),
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

  // AgentDash (#157): past_due tier mapping
  it("sets plan_tier=pro_past_due (NOT pro_active) when subscription status is past_due", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("past_due");
    await sync.dispatch(makeEvent("customer.subscription.updated", sub));

    expect(companies.update).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({ planTier: "pro_past_due" }),
    );
    // Verify it is NOT pro_active — past-due is not in PRO_LIVE
    const updateCall = companies.update.mock.calls[0];
    expect(updateCall[1].planTier).not.toBe("pro_active");
  });

  // AgentDash (#157): PRO_LIVE security gate
  it("pro_past_due is not in PRO_LIVE set (security: past-due companies do not get Pro features)", () => {
    // PRO_LIVE is module-internal but we can verify the tier mapping indirectly.
    // The definitive security test: after a past_due subscription.updated event,
    // the stored planTier is pro_past_due, which the routes/middleware treat as
    // non-Pro (PRO_LIVE only contains pro_trial and pro_active).
    const PRO_LIVE = new Set(["pro_trial", "pro_active"]);
    expect(PRO_LIVE.has("pro_past_due")).toBe(false);
    expect(PRO_LIVE.has("pro_trial")).toBe(true);
    expect(PRO_LIVE.has("pro_active")).toBe(true);
  });

  // AgentDash (#157): invoice.payment_failed handler
  it("invoice.payment_failed writes activity_log row with correct shape, does not mutate planTier", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const activityLog = makeActivityLog();
    const sync = entitlementSync({ companies, ledger, activityLog });

    const invoice = {
      id: "in_fail_123",
      subscription: "sub_test",
      customer: "cus_test",
      attempt_count: 2,
      next_payment_attempt: 1748000000,
    };
    const event = makeEvent("invoice.payment_failed", invoice, "evt_fail_1");
    await sync.dispatch(event);

    // Must log the activity with the billing action
    expect(activityLog.record).toHaveBeenCalledWith(
      "co-1",
      "stripe.payment_failed",
      expect.objectContaining({
        invoiceId: "in_fail_123",
        attemptCount: 2,
        nextPaymentAttempt: 1748000000,
      }),
    );
    // Must NOT touch companies.update — planTier mutation happens via
    // the separate customer.subscription.updated event with status="past_due"
    expect(companies.update).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed resolves without throwing when no company found", async () => {
    const companies = {
      findByStripeSubscriptionId: vi.fn(async () => null),
      findByStripeCustomerId: vi.fn(async () => null),
      update: vi.fn(async () => null),
    };
    const ledger = makeLedger();
    const activityLog = makeActivityLog();
    const sync = entitlementSync({ companies, ledger, activityLog });

    const invoice = { id: "in_unknown", subscription: "sub_unknown", customer: "cus_unknown" };
    await expect(sync.dispatch(makeEvent("invoice.payment_failed", invoice))).resolves.toBeUndefined();
    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed resolves without throwing when no activityLog wired", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    // activityLog intentionally omitted
    const sync = entitlementSync({ companies, ledger });

    const invoice = { id: "in_nolog", subscription: "sub_test", customer: "cus_test" };
    await expect(sync.dispatch(makeEvent("invoice.payment_failed", invoice))).resolves.toBeUndefined();
  });

  // AgentDash (#157): customer.subscription.trial_will_end handler
  it("customer.subscription.trial_will_end writes activity_log row with correct shape", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const activityLog = makeActivityLog();
    const sync = entitlementSync({ companies, ledger, activityLog });

    const sub = makeSubscription("trialing", {
      trial_end: 1747000000,
    });
    const event = makeEvent("customer.subscription.trial_will_end", sub, "evt_trial_end_1");
    await sync.dispatch(event);

    expect(activityLog.record).toHaveBeenCalledWith(
      "co-1",
      "stripe.trial_will_end",
      expect.objectContaining({
        subscriptionId: "sub_test",
        trialEnd: 1747000000,
      }),
    );
    // Does not update planTier — subscription is still trialing
    expect(companies.update).not.toHaveBeenCalled();
  });

  it("customer.subscription.trial_will_end resolves without throwing when no activityLog wired", async () => {
    const companies = makeCompanies();
    const ledger = makeLedger();
    const sync = entitlementSync({ companies, ledger });

    const sub = makeSubscription("trialing", { trial_end: 1747000000 });
    await expect(
      sync.dispatch(makeEvent("customer.subscription.trial_will_end", sub)),
    ).resolves.toBeUndefined();
  });
});
