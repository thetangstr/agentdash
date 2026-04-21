import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Stripe SDK before importing the provider
const mockCheckoutSessionsCreate = vi.fn();
const mockBillingPortalSessionsCreate = vi.fn();
const mockSubscriptionsCancel = vi.fn();

const mockStripeInstance = {
  checkout: {
    sessions: {
      create: mockCheckoutSessionsCreate,
    },
  },
  billingPortal: {
    sessions: {
      create: mockBillingPortalSessionsCreate,
    },
  },
  subscriptions: {
    cancel: mockSubscriptionsCancel,
  },
};

vi.mock("stripe", () => ({
  default: vi.fn(() => mockStripeInstance),
}));

import { createBillingProvider, StubBillingProvider, StripeBillingProvider } from "./index.js";
import type { StripeBillingConfig } from "./stripe-types.js";

const priceMap: StripeBillingConfig["priceMap"] = {
  price_pro_monthly: "pro",
  price_enterprise_monthly: "enterprise",
};

const baseConfig: StripeBillingConfig = {
  secretKey: "sk_test_abc123",
  priceMap,
  successUrl: "http://localhost:3100/billing?checkout=success",
  cancelUrl: "http://localhost:3100/billing?checkout=cancel",
  portalReturnUrl: "http://localhost:3100/billing",
};

function makeProvider(config: Partial<StripeBillingConfig> = {}): StripeBillingProvider {
  return new StripeBillingProvider({ ...baseConfig, ...config });
}

describe("StripeBillingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createCheckoutSession", () => {
    it("returns { status: 'redirect', url } and calls sessions.create with correct args", async () => {
      const expectedUrl = "https://checkout.stripe.com/pay/cs_test_abc";
      mockCheckoutSessionsCreate.mockResolvedValueOnce({ url: expectedUrl });

      const provider = makeProvider();
      const result = await provider.createCheckoutSession({
        companyId: "company-abc",
        targetTier: "pro",
      });

      expect(result).toEqual({ status: "redirect", url: expectedUrl });
      expect(mockCheckoutSessionsCreate).toHaveBeenCalledOnce();
      expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith({
        mode: "subscription",
        line_items: [{ price: "price_pro_monthly", quantity: 1 }],
        client_reference_id: "company-abc",
        success_url: baseConfig.successUrl,
        cancel_url: baseConfig.cancelUrl,
        subscription_data: { trial_period_days: 7 },
      });
    });

    it("does NOT attach trial_period_days for enterprise tier", async () => {
      mockCheckoutSessionsCreate.mockResolvedValueOnce({ url: "https://checkout.stripe.com/x" });

      const provider = makeProvider();
      await provider.createCheckoutSession({
        companyId: "company-abc",
        targetTier: "enterprise",
      });

      expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith({
        mode: "subscription",
        line_items: [{ price: "price_enterprise_monthly", quantity: 1 }],
        client_reference_id: "company-abc",
        success_url: baseConfig.successUrl,
        cancel_url: baseConfig.cancelUrl,
      });
    });

    it("throws when no priceId is mapped for the targetTier", async () => {
      const provider = makeProvider({ priceMap: {} });

      await expect(
        provider.createCheckoutSession({ companyId: "company-abc", targetTier: "pro" }),
      ).rejects.toThrow("No Stripe price ID mapped for tier: pro");

      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    });

    it("throws when Stripe returns a session with no URL", async () => {
      mockCheckoutSessionsCreate.mockResolvedValueOnce({ url: null });

      const provider = makeProvider();

      await expect(
        provider.createCheckoutSession({ companyId: "company-abc", targetTier: "pro" }),
      ).rejects.toThrow("Stripe checkout session created but returned no URL");
    });
  });

  describe("createPortalSession", () => {
    it("calls billingPortal.sessions.create with customer and return_url", async () => {
      const expectedUrl = "https://billing.stripe.com/session/test_abc";
      mockBillingPortalSessionsCreate.mockResolvedValueOnce({ url: expectedUrl });

      const provider = makeProvider();
      const result = await provider.createPortalSession({
        stripeCustomerId: "cus_test_xyz",
      });

      expect(result).toEqual({ url: expectedUrl });
      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledOnce();
      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
        customer: "cus_test_xyz",
        return_url: baseConfig.portalReturnUrl,
      });
    });

    it("uses provided returnUrl over config default", async () => {
      mockBillingPortalSessionsCreate.mockResolvedValueOnce({ url: "https://billing.stripe.com/session/x" });

      const provider = makeProvider();
      await provider.createPortalSession({
        stripeCustomerId: "cus_test_xyz",
        returnUrl: "http://custom.example.com/return",
      });

      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
        customer: "cus_test_xyz",
        return_url: "http://custom.example.com/return",
      });
    });
  });

  describe("cancelStripeSubscription", () => {
    it("calls subscriptions.cancel with the subscription ID", async () => {
      const mockSubscription = { id: "sub_test_abc", status: "canceled" };
      mockSubscriptionsCancel.mockResolvedValueOnce(mockSubscription);

      const provider = makeProvider();
      const result = await provider.cancelStripeSubscription("sub_test_abc");

      expect(result).toEqual(mockSubscription);
      expect(mockSubscriptionsCancel).toHaveBeenCalledOnce();
      expect(mockSubscriptionsCancel).toHaveBeenCalledWith("sub_test_abc");
    });
  });

  describe("cancelSubscription (BillingProvider interface)", () => {
    it("returns stubbed status directing to use cancelStripeSubscription", async () => {
      const provider = makeProvider();
      const result = await provider.cancelSubscription({ companyId: "company-abc" });

      expect(result.status).toBe("stubbed");
      expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    });
  });

  describe("syncEntitlement", () => {
    it("resolves void without calling Stripe (webhook is source of truth)", async () => {
      const provider = makeProvider();
      await expect(
        provider.syncEntitlement({ companyId: "company-abc", tier: "pro" }),
      ).resolves.toBeUndefined();

      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
      expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
    });
  });
});

describe("createBillingProvider", () => {
  beforeEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_MAP;
  });

  it("returns StubBillingProvider when no key is set", () => {
    const provider = createBillingProvider({});
    expect(provider).toBeInstanceOf(StubBillingProvider);
  });

  it("returns StubBillingProvider when opts and env have no key", () => {
    const provider = createBillingProvider({ stripeSecretKey: undefined });
    expect(provider).toBeInstanceOf(StubBillingProvider);
  });

  it("returns StripeBillingProvider when stripeSecretKey is provided in opts", () => {
    const provider = createBillingProvider({ stripeSecretKey: "sk_test_x" });
    expect(provider).toBeInstanceOf(StripeBillingProvider);
  });

  it("returns StripeBillingProvider when STRIPE_SECRET_KEY env var is set", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_from_env";
    const provider = createBillingProvider({});
    expect(provider).toBeInstanceOf(StripeBillingProvider);
  });

  it("parses STRIPE_PRICE_MAP from opts JSON string", () => {
    const provider = createBillingProvider({
      stripeSecretKey: "sk_test_x",
      stripePriceMap: JSON.stringify({ price_abc: "pro" }),
    });
    expect(provider).toBeInstanceOf(StripeBillingProvider);
  });

  it("falls back to empty priceMap on invalid JSON", () => {
    // Should not throw, just use empty priceMap
    const provider = createBillingProvider({
      stripeSecretKey: "sk_test_x",
      stripePriceMap: "not-valid-json",
    });
    expect(provider).toBeInstanceOf(StripeBillingProvider);
  });
});
