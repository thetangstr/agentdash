import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  findByStripeSubscriptionId: vi.fn(),
  findByStripeCustomerId: vi.fn(),
}));

const mockConversationService = vi.hoisted(() => ({
  findByCompany: vi.fn(),
  postMessage: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/companies.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/conversations.js", () => ({
  conversationService: () => mockConversationService,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => mockAgentService,
}));

function makeStripe() {
  return {
    customers: {
      create: vi.fn(async () => ({ id: "cus_new" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_123" })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://billing.stripe.com/p/session/test" })),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

async function createApp(stripe: ReturnType<typeof makeStripe>, trialDays = 14) {
  const { billingRoutes } = await import("../routes/billing.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
    };
    next();
  });
  app.use("/api/billing", billingRoutes({} as any, {
    stripe,
    webhookSecret: "whsec_test",
    proPriceId: "price_agentdash_pro",
    trialDays,
    publicBaseUrl: "https://app.agentdash.example",
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

describe("POST /api/billing/checkout-session", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Acme",
      stripeCustomerId: "cus_existing",
      planTier: "free",
      planSeatsPaid: 0,
      planPeriodEnd: null,
    });
    mockCompanyService.update.mockResolvedValue(null);
    mockCompanyService.findByStripeSubscriptionId.mockResolvedValue(null);
    mockCompanyService.findByStripeCustomerId.mockResolvedValue(null);
  });

  it("opens Stripe Checkout for the Pro trial with the configured price and redirect URLs", async () => {
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app)
      .post("/api/billing/checkout-session")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_123" });
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: "cus_existing",
      line_items: [{ price: "price_agentdash_pro", quantity: 1 }],
      // DO NOT REMOVE `payment_method_collection`. Stripe Checkout in
      // subscription mode collects a card by DEFAULT, and the product promises
      // a no-card trial on the pricing page, the terms page, the billing button
      // and in CLAUDE.md. Without this flag every one of those is false, and a
      // design partner who is not meant to pay yet is asked for a card.
      //
      // This assertion previously pinned the payload WITHOUT the flag, which
      // locked the bug in: the design spec called for it, the implementation
      // dropped it, and the test then made the omission look deliberate.
      payment_method_collection: "if_required",
      subscription_data: {
        trial_period_days: 14,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { companyId: "company-1" },
      },
      success_url: "https://app.agentdash.example/billing?session=success",
      cancel_url: "https://app.agentdash.example/billing?session=cancel",
    });
  });

  it("carries the configured trial length through to Stripe", async () => {
    // STRIPE_TRIAL_DAYS is how the owner gives a design partner ~6 months free.
    // It reaches trial_period_days or the setting silently does nothing.
    const stripe = makeStripe();
    const app = await createApp(stripe, 180);

    await request(app).post("/api/billing/checkout-session").send({ companyId: "company-1" });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: expect.objectContaining({ trial_period_days: 180 }),
      }),
    );
  });
});
