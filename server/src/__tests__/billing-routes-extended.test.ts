// AgentDash: Extended billing routes tests
// Covers gaps in the existing billing-routes.test.ts:
//   - checkout-session returns { url } when provider resolves with redirect
//   - portal-session succeeds when stripeProvider is present + company has a customer ID
//   - webhook with invalid signature (webhookSecret set) returns 400
//   - customer.subscription.updated event is processed correctly
//   - unknown event type is silently accepted (no 500)
//   - checkout.session.completed without client_reference_id is a no-op (no 500)

import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { billingRoutes, billingWebhookHandler } from "../routes/billing.js";
import type { BillingServiceDeps } from "../routes/billing.js";
import type { EntitlementsService } from "../services/entitlements.js";
import type { BillingProvider } from "@agentdash/billing";
import type { StripeBillingProvider } from "@agentdash/billing";
import type { Db } from "@agentdash/db";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeEntitlements(): EntitlementsService {
  return {
    getTier: vi.fn().mockResolvedValue("pro"),
    setTier: vi.fn().mockResolvedValue(undefined),
    getEntitlements: vi.fn().mockResolvedValue({ tier: "pro", features: {}, limits: {} }),
    setStripeIds: vi.fn().mockResolvedValue(undefined),
    setSubscriptionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(): BillingProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    cancelSubscription: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    syncEntitlement: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRedirectProvider(): BillingProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({
      status: "redirect",
      url: "https://checkout.stripe.com/pay/cs_test_integration",
    }),
    cancelSubscription: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    syncEntitlement: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStripeProvider(opts: {
  portalUrl?: string;
  customerId?: string | null;
  constructResult?: "valid" | "throw";
} = {}): StripeBillingProvider {
  const { portalUrl = "https://billing.stripe.com/session/test_portal", customerId = "cus_abc" } = opts;
  return {
    createPortalSession: vi.fn().mockResolvedValue({ url: portalUrl }),
    constructWebhookEvent: vi.fn().mockImplementation((rawBody, sig, secret) => {
      if (opts.constructResult === "throw") {
        throw new Error("No signatures found matching the expected signature");
      }
      return JSON.parse(rawBody.toString());
    }),
  } as unknown as StripeBillingProvider;
}

/**
 * Build a mock db that returns the given row-sets in order, one per .limit() call.
 * Each entry in `rowSets` corresponds to one db.select()...limit() chain invocation.
 * Once all sets are consumed, subsequent calls return [].
 */
function makeMultiDb(
  rowSets: Array<Record<string, unknown>[]>,
  options: { idempotencyInserted?: boolean } = {},
): Db {
  let callCount = 0;
  const insertedRows = options.idempotencyInserted === false ? [] : [{ id: "evt-row-1" }];
  return {
    select: vi.fn().mockImplementation(() => {
      const currentSet = rowSets[callCount] ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(currentSet);
      });
      return chain;
    }),
    insert: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.values = vi.fn().mockReturnValue(chain);
      chain.onConflictDoNothing = vi.fn().mockReturnValue(chain);
      chain.returning = vi.fn().mockResolvedValue(insertedRows);
      chain.then = (onResolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(onResolve);
      return chain;
    }),
    update: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockResolvedValue(undefined);
      return chain;
    }),
  } as unknown as Db;
}

/** Convenience: db that always returns empty rows. With `existingEvent`,
 *  the idempotency-gate insert returns [] (mimicking unique-index conflict). */
function makeDb(opts: { stripeCustomerId?: string | null; existingEvent?: boolean } = {}): Db {
  const { existingEvent = false } = opts;
  return makeMultiDb([], { idempotencyInserted: existingEvent ? false : undefined });
}

function makeApp(
  db: Db,
  deps: BillingServiceDeps,
  companyIds: string[] = ["company-test"],
) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds,
    };
    next();
  });
  app.use("/api", billingRoutes(db, deps));
  app.post("/api/billing/webhook", billingWebhookHandler(db, deps));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: checkout-session with real redirect provider
// ---------------------------------------------------------------------------

describe("POST /api/companies/:companyId/billing/checkout-session — redirect provider", () => {
  it("returns 200 with { url } when provider returns redirect status", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeRedirectProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/checkout-session")
      .send({ targetTier: "pro" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
    expect(res.body.url).toBe("https://checkout.stripe.com/pay/cs_test_integration");
  });

  it("returns 200 with { url } for enterprise tier", async () => {
    const db = makeDb();
    const provider = makeRedirectProvider();
    (provider.createCheckoutSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "redirect",
      url: "https://checkout.stripe.com/pay/cs_test_enterprise",
    });
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider,
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/checkout-session")
      .send({ targetTier: "enterprise" });

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("checkout.stripe.com");
  });

  it("rejects 'free' as targetTier with 400", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/checkout-session")
      .send({ targetTier: "free" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetTier/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: portal-session with stripeProvider present
// ---------------------------------------------------------------------------

describe("POST /api/companies/:companyId/billing/portal-session — with stripeProvider", () => {
  it("returns 200 with { url } when company has a stripeCustomerId", async () => {
    // Portal service does one db.select to look up stripeCustomerId
    const db = makeMultiDb([[{ stripeCustomerId: "cus_abc" }]]);
    const stripeProvider = makeStripeProvider({ portalUrl: "https://billing.stripe.com/session/portal_abc" });
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      stripeProvider,
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/portal-session")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://billing.stripe.com/session/portal_abc");
    expect(stripeProvider.createPortalSession).toHaveBeenCalledOnce();
  });

  it("returns 400 when company has no stripeCustomerId", async () => {
    // db returns a row with null stripeCustomerId
    const db = makeMultiDb([[{ stripeCustomerId: null }]]);
    const stripeProvider = makeStripeProvider({ customerId: null });
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      stripeProvider,
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/portal-session")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no stripe customer/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: webhook signature verification
// ---------------------------------------------------------------------------

describe("POST /api/billing/webhook — with webhookSecret", () => {
  it("returns 400 when signature verification fails", async () => {
    const db = makeDb();
    const stripeProvider = makeStripeProvider({ constructResult: "throw" });
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      stripeProvider,
      webhookSecret: "whsec_test_secret",
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_bad_sig",
      type: "invoice.paid",
      data: { object: { customer: "cus_abc" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "invalid_sig")
      .send(event);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("returns 200 when constructWebhookEvent succeeds", async () => {
    const db = makeDb();
    const stripeProvider = makeStripeProvider({ constructResult: "valid" });
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      stripeProvider,
      webhookSecret: "whsec_test_secret",
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_valid_sig",
      type: "invoice.paid",
      data: { object: { customer: "cus_none" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=12345,v1=abc")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: customer.subscription.updated event
// ---------------------------------------------------------------------------

describe("POST /api/billing/webhook — customer.subscription.updated", () => {
  it("processes subscription update, re-maps tier, and returns received=true", async () => {
    // Webhook handler idempotency uses db.insert()...returning() (not a select).
    // The first db.select()...limit() call is lookupCompanyByStripeCustomer.
    const db = makeMultiDb([
      [{ companyId: "company-test" }], // lookupCompanyByStripeCustomer
    ]);
    const entitlements = makeEntitlements();
    const deps: BillingServiceDeps = {
      entitlements,
      provider: makeProvider(),
      priceMap: { price_enterprise_monthly: "enterprise" },
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_upd_001",
          customer: "cus_xyz",
          status: "active",
          current_period_end: 1980000000,
          items: { data: [{ price: { id: "price_enterprise_monthly" } }] },
        },
      },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    // Tier re-mapping should have been triggered
    expect(entitlements.setTier).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: unknown event type (no crash)
// ---------------------------------------------------------------------------

describe("POST /api/billing/webhook — unknown event type", () => {
  it("returns 200 received=true without error for unhandled event types", async () => {
    const db = makeDb();
    const entitlements = makeEntitlements();
    const deps: BillingServiceDeps = {
      entitlements,
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_unknown_001",
      type: "customer.created",  // not handled by billing service
      data: { object: { id: "cus_new_xyz" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    // No entitlements mutations should occur
    expect(entitlements.setTier).not.toHaveBeenCalled();
    expect(entitlements.setSubscriptionStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: checkout.session.completed without client_reference_id
// ---------------------------------------------------------------------------

describe("POST /api/billing/webhook — checkout.session.completed edge cases", () => {
  it("returns 200 without error when client_reference_id is missing", async () => {
    const db = makeDb();
    const entitlements = makeEntitlements();
    const deps: BillingServiceDeps = {
      entitlements,
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_checkout_no_ref",
      type: "checkout.session.completed",
      data: {
        object: {
          // No client_reference_id
          customer: "cus_orphan",
          mode: "subscription",
        },
      },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    // setStripeIds must NOT be called if there's no company to map to
    expect(entitlements.setStripeIds).not.toHaveBeenCalled();
  });
});
