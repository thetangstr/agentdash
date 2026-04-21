// AgentDash: Billing webhook → entitlement update integration test
// Uses real embedded PostgreSQL + full migrations so the entire
// webhook → billing_events → companyPlan update path is verified
// against a real schema.  No Stripe API calls are made.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  billingEvents,
  companies,
  companyMemberships,
  companyPlan,
  createDb,
} from "@agentdash/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { billingWebhookHandler } from "../routes/billing.js";
import type { BillingServiceDeps } from "../routes/billing.js";
import type { EntitlementsService } from "../services/entitlements.js";
import type { BillingProvider } from "@agentdash/billing";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Conditional skip on unsupported hosts
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping billing webhook integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubProvider(): BillingProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    cancelSubscription: vi.fn().mockResolvedValue({ status: "stubbed", reason: "no key" }),
    syncEntitlement: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRawBody(event: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("billing webhook → entitlement integration (real DB)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agentdash-billing-webhook-integration-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    // Clean up in FK-safe order
    await db.delete(billingEvents);
    await db.delete(companyPlan);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  async function seedCompany(stripeCustomerId: string | null = null): Promise<{ companyId: string }> {
    const id = randomUUID();
    userId = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Billing Test Co",
      issuePrefix: `BTC${id.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    if (stripeCustomerId) {
      await db.insert(companyPlan).values({
        companyId: id,
        planId: "free",
        stripeCustomerId,
      });
    }
    companyId = id;
    return { companyId: id };
  }

  function makeApp(entitlementsSvc: EntitlementsService) {
    // Use real entitlements service bound to real DB — imported lazily to
    // avoid top-level module mock pollution.
    const deps: BillingServiceDeps = {
      entitlements: entitlementsSvc,
      provider: makeStubProvider(),
      priceMap: { price_pro_monthly: "pro", price_enterprise_monthly: "enterprise" },
      // No webhookSecret → dev mode (signature verification skipped)
    };
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.post("/api/billing/webhook", billingWebhookHandler(db, deps));
    app.use(errorHandler);
    return app;
  }

  it("checkout.session.completed → creates companyPlan row with stripeCustomerId", async () => {
    const { companyId: cId } = await seedCompany(); // no Stripe IDs yet
    const { entitlementsService } = await import("../services/entitlements.js");
    const svc = entitlementsService(db);
    const app = makeApp(svc);

    const event = {
      id: `evt_checkout_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: cId,
          customer: "cus_integration_001",
          mode: "subscription",
        },
      },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // companyPlan row must exist with the Stripe customer ID persisted
    const planRows = await db
      .select({ stripeCustomerId: companyPlan.stripeCustomerId })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, cId))
      .limit(1);
    expect(planRows[0]?.stripeCustomerId).toBe("cus_integration_001");

    // billing_events audit row must be persisted
    const evtRows = await db
      .select({ id: billingEvents.id, stripeEventType: billingEvents.stripeEventType })
      .from(billingEvents)
      .where(eq(billingEvents.stripeEventId, event.id));
    expect(evtRows).toHaveLength(1);
    expect(evtRows[0]?.stripeEventType).toBe("checkout.session.completed");
  });

  it("customer.subscription.created → upgrades tier + saves subscription status + billing_events row", async () => {
    const { companyId: cId } = await seedCompany("cus_integration_sub");
    const { entitlementsService } = await import("../services/entitlements.js");
    const svc = entitlementsService(db);
    const app = makeApp(svc);

    const periodEnd = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days from now
    const event = {
      id: `evt_sub_created_${randomUUID()}`,
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_integration_001",
          customer: "cus_integration_sub",
          status: "active",
          current_period_end: periodEnd,
          items: {
            data: [{ price: { id: "price_pro_monthly" } }],
          },
        },
      },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // companyPlan must reflect the new tier and subscription status
    const planRows = await db
      .select({
        planId: companyPlan.planId,
        stripeSubscriptionId: companyPlan.stripeSubscriptionId,
        subscriptionStatus: companyPlan.subscriptionStatus,
        currentPeriodEnd: companyPlan.currentPeriodEnd,
      })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, cId))
      .limit(1);

    const plan = planRows[0];
    expect(plan?.planId).toBe("pro");
    expect(plan?.stripeSubscriptionId).toBe("sub_integration_001");
    expect(plan?.subscriptionStatus).toBe("active");
    expect(plan?.currentPeriodEnd).toBeInstanceOf(Date);
    expect(plan?.currentPeriodEnd!.getTime()).toBeCloseTo(periodEnd * 1000, -3);

    // billing_events audit row
    const evtRows = await db
      .select({ stripeEventType: billingEvents.stripeEventType, companyId: billingEvents.companyId })
      .from(billingEvents)
      .where(eq(billingEvents.stripeEventId, event.id));
    expect(evtRows).toHaveLength(1);
    expect(evtRows[0]?.stripeEventType).toBe("customer.subscription.created");
    expect(evtRows[0]?.companyId).toBe(cId);
  });

  it("customer.subscription.deleted → tier reverts to free, status set to canceled", async () => {
    const { companyId: cId } = await seedCompany("cus_integration_del");
    // Pre-seed a pro plan
    await db
      .insert(companyPlan)
      .values({
        companyId: cId,
        planId: "pro",
        stripeCustomerId: "cus_integration_del",
        stripeSubscriptionId: "sub_to_delete",
        subscriptionStatus: "active",
      })
      .onConflictDoUpdate({
        target: companyPlan.companyId,
        set: {
          planId: "pro",
          stripeCustomerId: "cus_integration_del",
          stripeSubscriptionId: "sub_to_delete",
          subscriptionStatus: "active",
        },
      });

    const { entitlementsService } = await import("../services/entitlements.js");
    const svc = entitlementsService(db);
    const app = makeApp(svc);

    const event = {
      id: `evt_sub_deleted_${randomUUID()}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_to_delete",
          customer: "cus_integration_del",
          status: "canceled",
        },
      },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);

    expect(res.status).toBe(200);

    const planRows = await db
      .select({ planId: companyPlan.planId, subscriptionStatus: companyPlan.subscriptionStatus })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, cId))
      .limit(1);

    expect(planRows[0]?.planId).toBe("free");
    expect(planRows[0]?.subscriptionStatus).toBe("canceled");

    // billing_events audit row present
    const evtRows = await db
      .select({ id: billingEvents.id })
      .from(billingEvents)
      .where(eq(billingEvents.stripeEventId, event.id));
    expect(evtRows).toHaveLength(1);
  });

  it("idempotency: second webhook with same stripeEventId is skipped (no duplicate billing_events row)", async () => {
    const { companyId: cId } = await seedCompany("cus_idempotent");
    const { entitlementsService } = await import("../services/entitlements.js");
    const svc = entitlementsService(db);
    const app = makeApp(svc);

    const eventId = `evt_idem_${randomUUID()}`;
    const event = {
      id: eventId,
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_idempotent", status: "open" } },
    };

    // First delivery
    const res1 = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);
    expect(res1.status).toBe(200);

    // Second delivery (Stripe retry)
    const res2 = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ received: true, skipped: true });

    // Only one billing_events row despite two POST calls
    const evtRows = await db
      .select({ id: billingEvents.id })
      .from(billingEvents)
      .where(eq(billingEvents.stripeEventId, eventId));
    expect(evtRows).toHaveLength(1);
  });

  it("invoice.payment_failed → sets subscriptionStatus to past_due", async () => {
    const { companyId: cId } = await seedCompany("cus_pastdue");
    await db
      .insert(companyPlan)
      .values({ companyId: cId, planId: "pro", stripeCustomerId: "cus_pastdue", subscriptionStatus: "active" })
      .onConflictDoUpdate({
        target: companyPlan.companyId,
        set: { planId: "pro", stripeCustomerId: "cus_pastdue", subscriptionStatus: "active" },
      });

    const { entitlementsService } = await import("../services/entitlements.js");
    const app = makeApp(entitlementsService(db));

    const event = {
      id: `evt_inv_fail_${randomUUID()}`,
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_pastdue", status: "open" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);
    expect(res.status).toBe(200);

    const planRows = await db
      .select({ subscriptionStatus: companyPlan.subscriptionStatus })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, cId))
      .limit(1);
    expect(planRows[0]?.subscriptionStatus).toBe("past_due");
  });

  it("invoice.paid → recovers status from past_due to active", async () => {
    const { companyId: cId } = await seedCompany("cus_recover");
    await db
      .insert(companyPlan)
      .values({ companyId: cId, planId: "pro", stripeCustomerId: "cus_recover", subscriptionStatus: "past_due" })
      .onConflictDoUpdate({
        target: companyPlan.companyId,
        set: { planId: "pro", stripeCustomerId: "cus_recover", subscriptionStatus: "past_due" },
      });

    const { entitlementsService } = await import("../services/entitlements.js");
    const app = makeApp(entitlementsService(db));

    const event = {
      id: `evt_inv_paid_${randomUUID()}`,
      type: "invoice.paid",
      data: { object: { customer: "cus_recover", status: "paid" } },
    };

    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(event);
    expect(res.status).toBe(200);

    const planRows = await db
      .select({ subscriptionStatus: companyPlan.subscriptionStatus })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, cId))
      .limit(1);
    expect(planRows[0]?.subscriptionStatus).toBe("active");
  });
});
