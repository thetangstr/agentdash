/**
 * Tests for STRIPE_WEBHOOK_SECRET validation (#161).
 *
 * Covers:
 *  1. createApp throws when STRIPE_SECRET_KEY is set + STRIPE_WEBHOOK_SECRET is empty
 *  2. createApp succeeds when STRIPE_SECRET_KEY is unset (billing-disabled mode)
 *  3. billingRoutes webhook handler returns 503 when cfg.webhookSecret is empty at runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { billingRoutes } from "../routes/billing.js";
import { createApp } from "../app.js";

// ---------------------------------------------------------------------------
// Helpers for billing route tests (runtime defensive check)
// ---------------------------------------------------------------------------

function makeStripe(overrides: Record<string, any> = {}) {
  return {
    customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
    checkout: { sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.com/pay/sess_test" })) } },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/portal/sess_test" })) } },
    webhooks: {
      constructEvent: vi.fn((_raw: any, sig: string, _secret: string) => {
        if (sig !== "valid-sig") throw new Error("invalid signature");
        return { id: "evt_test", type: "invoice.paid", data: { object: { id: "in_test" } } };
      }),
    },
    ...overrides,
  };
}

function makeFakeDb(): any {
  return new Proxy({}, {
    get(_target, _prop) {
      const chain: any = new Proxy(() => chain, {
        get(_t, _p) { return chain; },
        apply() { return Promise.resolve([]); },
      });
      return chain;
    },
  });
}

function buildWebhookApp(webhookSecret: string) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }));

  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", userId: "user-1", companyIds: ["co-1"], source: "session" };
    next();
  });

  app.use("/api/billing", billingRoutes(makeFakeDb(), {
    stripe: makeStripe(),
    webhookSecret,
    proPriceId: "price_test",
    trialDays: 14,
    publicBaseUrl: "https://app.example.com",
  }));

  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}

// ---------------------------------------------------------------------------
// 1 & 2. Startup validation inside createApp
//
// The validation guard runs synchronously at the top of the billing-mount
// section in createApp, before any `import("stripe")` dynamic import.
// We set env vars, call createApp with minimal opts, and expect it to either
// reject immediately (error cases) or resolve past the guard (success cases).
//
// For error cases we pass `STRIPE_SECRET_KEY` but a bad/missing
// `STRIPE_WEBHOOK_SECRET`. createApp throws before touching the Stripe SDK.
// For success cases we either omit STRIPE_SECRET_KEY (dev mode, no-op) or
// provide both vars. When both are provided createApp will try to import
// the real "stripe" package which IS available in the test environment,
// and will proceed until it finishes wiring routes.
// ---------------------------------------------------------------------------

const MINIMAL_OPTS: any = {
  uiMode: "none",
  serverPort: 3100,
  storageService: { uploadFile: vi.fn(), getFileUrl: vi.fn(), deleteFile: vi.fn() },
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: true,
  companyDeletionEnabled: false,
};

describe("createApp startup validation — STRIPE_WEBHOOK_SECRET", () => {
  // Save and restore env vars around each test
  let savedStripeKey: string | undefined;
  let savedWebhookSecret: string | undefined;

  beforeEach(() => {
    savedStripeKey = process.env.STRIPE_SECRET_KEY;
    savedWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    // Ensure Stripe is disabled by default — individual tests opt in
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (savedStripeKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = savedStripeKey;
    }
    if (savedWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = savedWebhookSecret;
    }
    vi.restoreAllMocks();
  });

  it("throws when STRIPE_SECRET_KEY is set and STRIPE_WEBHOOK_SECRET is missing", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    // STRIPE_WEBHOOK_SECRET deliberately absent

    await expect(createApp(makeFakeDb(), MINIMAL_OPTS)).rejects.toThrow(
      "STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set",
    );
  });

  it("throws when STRIPE_SECRET_KEY is set and STRIPE_WEBHOOK_SECRET is whitespace-only", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = "   "; // whitespace-only

    await expect(createApp(makeFakeDb(), MINIMAL_OPTS)).rejects.toThrow(
      "STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set",
    );
  });

  it("does not throw when STRIPE_SECRET_KEY is unset (billing-disabled / local dev)", async () => {
    // Both env vars absent — dev mode, no Stripe, guard is skipped entirely.
    await expect(createApp(makeFakeDb(), MINIMAL_OPTS)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Runtime defensive check: webhook handler returns 503 with empty secret
// ---------------------------------------------------------------------------

describe("POST /api/billing/webhook — runtime empty-secret guard", () => {
  it("returns 503 when webhookSecret is empty string", async () => {
    const app = buildWebhookApp("");

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "valid-sig")
      .send(Buffer.from(JSON.stringify({ type: "test" })));

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Webhook secret not configured" });
  });

  it("returns 503 when webhookSecret is whitespace-only", async () => {
    const app = buildWebhookApp("   ");

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "valid-sig")
      .send(Buffer.from(JSON.stringify({ type: "test" })));

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Webhook secret not configured" });
  });

  it("returns 400 with invalid signature when secret is present", async () => {
    const app = buildWebhookApp("wh_secret");

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", "invalid-sig")
      .send(Buffer.from(JSON.stringify({ type: "test" })));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid signature" });
  });
});
