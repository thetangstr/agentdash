// AgentDash: SC-8 checkout routing is needed on both Stripe objects.
import { afterEach, describe, expect, it, vi } from "vitest";
import { billingService } from "../services/billing.js";

afterEach(() => vi.unstubAllEnvs());
describe("cloud checkout metadata", () => {
  async function checkout(slug: string) {
    vi.stubEnv("AGENTDASH_BOX_SLUG", slug);
    const create = vi.fn(async (_arg: any) => ({ url: "https://checkout.stripe.com/test" }));
    const service = billingService({
      stripe: { checkout: { sessions: { create } } } as any,
      companies: { getById: async () => ({ id: "company-a", stripeCustomerId: "cus_a" }) } as any,
      config: { configured: true, proPriceId: "price_a", trialDays: 14, publicBaseUrl: "https://box.agentdash.cloud" },
    });
    await service.createCheckoutSession("company-a");
    return create.mock.calls[0][0];
  }
  it("routes hosted session and subscription with the same company and box", async () => {
    const session = await checkout("blue-box");
    expect(session.metadata).toEqual({ companyId: "company-a", box_slug: "blue-box" });
    expect(session.subscription_data.metadata).toEqual(session.metadata);
  });
  it("keeps self-hosted checkout company-scoped without a box slug", async () => {
    const session = await checkout("");
    expect(session.metadata).toEqual({ companyId: "company-a" });
    expect(session.subscription_data.metadata).toEqual(session.metadata);
  });
  it("refuses invalid configured slugs before sending an unroutable checkout", async () => {
    await expect(checkout("../../elsewhere")).rejects.toThrow("Invalid AGENTDASH_BOX_SLUG");
  });
});
