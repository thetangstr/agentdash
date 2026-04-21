// AgentDash: Billing routes integration tests
// Mounts billingRoutes and billingWebhookHandler on a test Express app.
// Uses stub provider — no real Stripe calls made.

import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { billingRoutes, billingWebhookHandler } from "../routes/billing.js";
import type { BillingServiceDeps } from "../routes/billing.js";
import type { EntitlementsService } from "../services/entitlements.js";
import type { BillingProvider } from "@agentdash/billing";
import type { Db } from "@agentdash/db";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeEntitlements(): EntitlementsService {
  return {
    getTier: vi.fn().mockResolvedValue("free"),
    setTier: vi.fn().mockResolvedValue(undefined),
    getEntitlements: vi.fn().mockResolvedValue({ tier: "free", features: {}, limits: {} }),
    setStripeIds: vi.fn().mockResolvedValue(undefined),
    setSubscriptionStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(): BillingProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ status: "stubbed", reason: "billing not configured" }),
    cancelSubscription: vi.fn().mockResolvedValue({ status: "stubbed", reason: "billing not configured" }),
    syncEntitlement: vi.fn().mockResolvedValue(undefined),
  };
}

/** Db mock that returns no rows for selects and accepts inserts.
 *  Idempotency is now insert-first: when `existingBillingEvent` is true the
 *  insert returns [] (mimicking ON CONFLICT DO NOTHING on the unique index),
 *  otherwise it returns a single {id} row. */
function makeDb(existingBillingEvent = false): Db {
  const insertedRows = existingBillingEvent ? [] : [{ id: "evt-row-1" }];
  return {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockResolvedValue([]);
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

function makeApp(db: Db, deps: BillingServiceDeps, companyIds: string[] = ["company-test"]) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  // Inject actor
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
  // Webhook needs raw body — attach handler directly
  app.post("/api/billing/webhook", billingWebhookHandler(db, deps));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/companies/:companyId/billing/checkout-session", () => {
  it("returns 400 with error when provider is stubbed (billing not configured)", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/checkout-session")
      .send({ targetTier: "pro" });

    // Stub provider throws because status=stubbed — route returns 400
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 400 for invalid targetTier", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/checkout-session")
      .send({ targetTier: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetTier/i);
  });

  it("returns 403 when user does not have company access", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    // Actor has no company IDs
    const app = makeApp(db, deps, []);

    const res = await request(app)
      .post("/api/companies/company-test/billing/checkout-session")
      .send({ targetTier: "pro" });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/companies/:companyId/billing/portal-session", () => {
  it("returns 400 when no Stripe provider configured", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
      // No stripeProvider
    };
    const app = makeApp(db, deps);

    const res = await request(app)
      .post("/api/companies/company-test/billing/portal-session")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stripe billing provider not configured/i);
  });
});

describe("POST /api/billing/webhook (no auth, dev mode)", () => {
  it("returns 200 with received=true in dev mode (no webhook secret)", async () => {
    const db = makeDb();
    const entitlements = makeEntitlements();
    const deps: BillingServiceDeps = {
      entitlements,
      provider: makeProvider(),
      priceMap: {},
      // No webhookSecret — dev mode
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_dev_001",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("creates a billing_events row on webhook receipt", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_audit_001",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_none", status: "open" } },
    };

    await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    // insert should have been called to persist the billing_event
    expect((db.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("returns received=true with skipped=true on duplicate stripeEventId (idempotency)", async () => {
    // DB returns existing billing event on idempotency check
    const db = makeDb(true);
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    const app = makeApp(db, deps);

    const event = {
      id: "evt_dup_001",
      type: "invoice.paid",
      data: { object: { customer: "cus_abc" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, skipped: true });
  });

  it("returns 400 when rawBody is missing", async () => {
    const db = makeDb();
    const deps: BillingServiceDeps = {
      entitlements: makeEntitlements(),
      provider: makeProvider(),
      priceMap: {},
    };
    // Create app WITHOUT the rawBody verify — so rawBody is undefined
    const app = express();
    app.use(express.json()); // no verify callback
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "u1", source: "session", isInstanceAdmin: false, companyIds: [] };
      next();
    });
    app.post("/api/billing/webhook", billingWebhookHandler(db, deps));
    app.use(errorHandler);

    const event = { id: "evt_nobody", type: "invoice.paid", data: { object: {} } };
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/raw body/i);
  });
});
