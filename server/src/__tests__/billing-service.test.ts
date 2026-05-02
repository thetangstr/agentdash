import { describe, expect, it, vi } from "vitest";
import { billingService } from "../services/billing.js";

const config = {
  proPriceId: "price_test123",
  trialDays: 14,
  publicBaseUrl: "https://app.example.com",
};

function makeStripe(overrides: Record<string, any> = {}) {
  return {
    customers: {
      create: vi.fn(async () => ({ id: "cus_new" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://checkout.stripe.com/pay/sess_test" })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://billing.stripe.com/portal/sess_test" })),
      },
    },
    ...overrides,
  };
}

function makeCompanies(company: Record<string, any> | null) {
  return {
    getById: vi.fn(async (_id: string) => company),
    update: vi.fn(async () => null),
  };
}

describe("billingService.createCheckoutSession", () => {
  it("creates a Stripe customer when absent and returns checkout URL", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies({ id: "co-1", name: "Acme", stripeCustomerId: null });
    const svc = billingService({ stripe, companies, config });

    const result = await svc.createCheckoutSession("co-1");

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme", metadata: { companyId: "co-1" } }),
    );
    expect(companies.update).toHaveBeenCalledWith("co-1", { stripeCustomerId: "cus_new" });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_new",
      }),
    );
    expect(result.url).toBe("https://checkout.stripe.com/pay/sess_test");
  });

  it("reuses an existing Stripe customer", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies({ id: "co-1", name: "Acme", stripeCustomerId: "cus_existing" });
    const svc = billingService({ stripe, companies, config });

    await svc.createCheckoutSession("co-1");

    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("includes trial_period_days: 14 and missing_payment_method: cancel", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies({ id: "co-1", name: "Acme", stripeCustomerId: "cus_existing" });
    const svc = billingService({ stripe, companies, config });

    await svc.createCheckoutSession("co-1");

    const call = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(call.subscription_data.trial_period_days).toBe(14);
    expect(call.subscription_data.trial_settings.end_behavior.missing_payment_method).toBe("cancel");
  });

  it("throws if company not found", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies(null);
    const svc = billingService({ stripe, companies, config });

    await expect(svc.createCheckoutSession("missing")).rejects.toThrow("Company not found");
  });
});

describe("billingService.createPortalSession", () => {
  it("creates a billing portal session for existing customer", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies({ id: "co-1", name: "Acme", stripeCustomerId: "cus_existing" });
    const svc = billingService({ stripe, companies, config });

    const result = await svc.createPortalSession("co-1");

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_existing",
      return_url: "https://app.example.com/billing",
    });
    expect(result.url).toBe("https://billing.stripe.com/portal/sess_test");
  });

  it("throws when no Stripe customer exists", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies({ id: "co-1", name: "Acme", stripeCustomerId: null });
    const svc = billingService({ stripe, companies, config });

    await expect(svc.createPortalSession("co-1")).rejects.toThrow("No Stripe customer for this company");
  });

  it("throws when company not found", async () => {
    const stripe = makeStripe();
    const companies = makeCompanies(null);
    const svc = billingService({ stripe, companies, config });

    await expect(svc.createPortalSession("missing")).rejects.toThrow("No Stripe customer for this company");
  });
});

describe("billingService.getStatus", () => {
  it("returns plan fields from company row", async () => {
    const periodEnd = new Date("2026-06-01T00:00:00.000Z");
    const companies = makeCompanies({
      id: "co-1",
      planTier: "pro_active",
      planSeatsPaid: 5,
      planPeriodEnd: periodEnd,
    });
    const svc = billingService({ stripe: makeStripe(), companies, config });

    const result = await svc.getStatus("co-1");

    expect(result).toEqual({ tier: "pro_active", seatsPaid: 5, periodEnd });
  });

  it("returns defaults for free company", async () => {
    const companies = makeCompanies({
      id: "co-1",
      planTier: null,
      planSeatsPaid: null,
      planPeriodEnd: null,
    });
    const svc = billingService({ stripe: makeStripe(), companies, config });

    const result = await svc.getStatus("co-1");

    expect(result).toEqual({ tier: "free", seatsPaid: 0, periodEnd: null });
  });

  it("throws if company not found", async () => {
    const companies = makeCompanies(null);
    const svc = billingService({ stripe: makeStripe(), companies, config });

    await expect(svc.getStatus("missing")).rejects.toThrow("Company not found");
  });
});
