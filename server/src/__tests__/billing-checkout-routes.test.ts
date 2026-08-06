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

// Subscription mutations are owner/admin-only, so these routes now resolve the
// caller's membership role. Default to owner: the pre-existing cases here are
// about what Stripe receives, not about authorization.
const mockAccessService = vi.hoisted(() => ({
  getMembership: vi.fn(),
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

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
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

async function createApp(
  stripe: ReturnType<typeof makeStripe>,
  trialDays = 14,
  actorOverrides: Record<string, unknown> = {},
) {
  const { billingRoutes } = await import("../routes/billing.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      ...actorOverrides,
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
    mockAccessService.getMembership.mockResolvedValue({
      status: "active",
      membershipRole: "owner",
    });
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

/**
 * Subscription mutations are owner decisions.
 *
 * Both of these routes authorized on `companyIds.includes(companyId)` — bare
 * membership. The portal route is the whole subscription: change the plan, change
 * the card, cancel outright. So any member of a workspace, including a viewer,
 * could cancel the company's subscription, and the first anyone would learn of it
 * is when the plan lapsed.
 *
 * Membership and administration are different questions. `companyIds` answers
 * "may this person see this company"; it was being used to answer "may they
 * decide what it pays for".
 */
describe("billing mutations require owner or admin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "Acme",
      stripeCustomerId: "cus_existing",
      planTier: "pro_active",
      planSeatsPaid: 3,
      planPeriodEnd: null,
    });
    mockCompanyService.update.mockResolvedValue(null);
    mockCompanyService.findByStripeSubscriptionId.mockResolvedValue(null);
    mockCompanyService.findByStripeCustomerId.mockResolvedValue(null);
  });

  const asRole = (membershipRole: string | null, status = "active") =>
    mockAccessService.getMembership.mockResolvedValue(
      membershipRole === null ? null : { status, membershipRole },
    );

  it("refuses the Stripe portal to a plain member, and never calls Stripe", async () => {
    asRole("member");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses the portal to a viewer", async () => {
    asRole("viewer");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses a member who is no longer active", async () => {
    asRole("owner", "revoked");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(403);
  });

  it("refuses starting a subscription as a plain member", async () => {
    // Committing the company to a paid plan is the same class of decision as
    // cancelling one.
    asRole("member");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).post("/api/billing/checkout-session").send({ companyId: "company-1" });

    expect(res.status).toBe(403);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("allows an owner", async () => {
    asRole("owner");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalled();
  });

  it("allows an admin", async () => {
    asRole("admin");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(200);
  });

  it("allows the founder's own machine without a membership row", async () => {
    // local_implicit is the single-user local install: there is no membership to
    // resolve, and refusing it would lock the owner out of their own billing.
    asRole(null);
    const stripe = makeStripe();
    const app = await createApp(stripe, 14, { source: "local_implicit" });

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(200);
  });

  it("allows an instance admin", async () => {
    asRole(null);
    const stripe = makeStripe();
    const app = await createApp(stripe, 14, { isInstanceAdmin: true });

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(200);
  });

  it("still refuses a non-member outright, before any role question", async () => {
    asRole("owner");
    const stripe = makeStripe();
    const app = await createApp(stripe, 14, { companyIds: ["other-company"] });

    const res = await request(app).post("/api/billing/portal-session").send({ companyId: "company-1" });

    expect(res.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("leaves reading the plan open to any member", async () => {
    // Seeing which plan you are on is not a decision. Hiding it would just drive
    // people to ask an owner what should be on their own screen.
    asRole("member");
    const stripe = makeStripe();
    const app = await createApp(stripe);

    const res = await request(app).get("/api/billing/status?companyId=company-1");

    expect(res.status).toBe(200);
  });
});
