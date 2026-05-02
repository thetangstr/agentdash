import { describe, it, expect, vi } from "vitest";
import { billingReconcile } from "../services/billing-reconcile.js";

describe("billingReconcile.run", () => {
  it("re-syncs Stripe state for expired pro_trial companies", async () => {
    const companies = { listExpiredTrials: vi.fn().mockResolvedValue([
      { id: "c1", stripeSubscriptionId: "sub_1" },
    ]) };
    const stripe = { subscriptions: { retrieve: vi.fn().mockResolvedValue({
      id: "sub_1", status: "canceled", customer: "cus_1",
      items: { data: [{ quantity: 1 }] }, current_period_end: 0,
    }) } };
    const sync = { onSubscriptionUpdated: vi.fn().mockResolvedValue(undefined) };

    await billingReconcile({ companies, stripe, sync } as any).run();
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(sync.onSubscriptionUpdated).toHaveBeenCalled();
  });

  it("skips companies without stripeSubscriptionId", async () => {
    const companies = { listExpiredTrials: vi.fn().mockResolvedValue([{ id: "c1" }]) };
    const stripe = { subscriptions: { retrieve: vi.fn() } };
    const sync = { onSubscriptionUpdated: vi.fn() };
    await billingReconcile({ companies, stripe, sync } as any).run();
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("continues past per-company errors", async () => {
    const companies = { listExpiredTrials: vi.fn().mockResolvedValue([
      { id: "c1", stripeSubscriptionId: "sub_a" },
      { id: "c2", stripeSubscriptionId: "sub_b" },
    ]) };
    const stripe = {
      subscriptions: {
        retrieve: vi.fn()
          .mockRejectedValueOnce(new Error("transient"))
          .mockResolvedValueOnce({ id: "sub_b", status: "active", customer: "cus_b",
            items: { data: [{ quantity: 2 }] }, current_period_end: 0 }),
      },
    };
    const sync = { onSubscriptionUpdated: vi.fn().mockResolvedValue(undefined) };
    await billingReconcile({ companies, stripe, sync } as any).run();
    expect(sync.onSubscriptionUpdated).toHaveBeenCalledTimes(1);
  });
});
