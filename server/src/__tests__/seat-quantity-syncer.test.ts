import { describe, it, expect, vi } from "vitest";
import { seatQuantitySyncer } from "../services/seat-quantity-syncer.js";

describe("seatQuantitySyncer.onMembershipChanged", () => {
  it("calls subscriptions.update with the new human count when company is on Pro", async () => {
    const stripe = { subscriptions: { update: vi.fn().mockResolvedValue({}) } };
    const companies = { getById: vi.fn().mockResolvedValue({
      id: "c1", stripeSubscriptionId: "sub_1", planTier: "pro_active",
    }) };
    const counts = { humans: vi.fn().mockResolvedValue(4) };
    await seatQuantitySyncer({ stripe, companies, counts } as any).onMembershipChanged("c1");
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      quantity: 4, proration_behavior: "create_prorations",
    });
  });

  it("does nothing for free companies", async () => {
    const stripe = { subscriptions: { update: vi.fn() } };
    const companies = { getById: vi.fn().mockResolvedValue({ id: "c1", stripeSubscriptionId: null, planTier: "free" }) };
    const counts = { humans: vi.fn() };
    await seatQuantitySyncer({ stripe, companies, counts } as any).onMembershipChanged("c1");
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("does nothing for canceled companies even with stripeSubscriptionId set", async () => {
    const stripe = { subscriptions: { update: vi.fn() } };
    const companies = { getById: vi.fn().mockResolvedValue({ id: "c1", stripeSubscriptionId: "sub_1", planTier: "pro_canceled" }) };
    const counts = { humans: vi.fn() };
    await seatQuantitySyncer({ stripe, companies, counts } as any).onMembershipChanged("c1");
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
