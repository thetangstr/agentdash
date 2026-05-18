import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, stripeWebhookEvents } from "@paperclipai/db";
import { companyService } from "../services/companies.js";
import { entitlementSync } from "../services/entitlement-sync.js";
import { stripeWebhookLedger } from "../services/stripe-webhook-ledger.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Stripe webhook entitlement integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-webhook-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(stripeWebhookEvents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("flips a free company to pro_trial for customer.subscription.created", async () => {
    const companyId = randomUUID();
    const periodEnd = new Date("2026-06-01T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Billing Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      planTier: "free",
      stripeCustomerId: "cus_trialing",
    });

    const sync = entitlementSync({
      companies: companyService(db),
      ledger: stripeWebhookLedger(db),
    });

    await sync.dispatch({
      id: "evt_subscription_created_trialing",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_trialing",
          customer: "cus_trialing",
          status: "trialing",
          current_period_end: Math.floor(periodEnd.getTime() / 1000),
          items: { data: [{ quantity: 3 }] },
        },
      },
    });

    const [company] = await db
      .select({
        planTier: companies.planTier,
        planSeatsPaid: companies.planSeatsPaid,
        planPeriodEnd: companies.planPeriodEnd,
        stripeCustomerId: companies.stripeCustomerId,
        stripeSubscriptionId: companies.stripeSubscriptionId,
      })
      .from(companies)
      .where(eq(companies.id, companyId));
    const [ledgerEvent] = await db
      .select({
        eventId: stripeWebhookEvents.eventId,
        eventType: stripeWebhookEvents.eventType,
      })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, "evt_subscription_created_trialing"));

    expect(company).toEqual({
      planTier: "pro_trial",
      planSeatsPaid: 3,
      planPeriodEnd: periodEnd,
      stripeCustomerId: "cus_trialing",
      stripeSubscriptionId: "sub_trialing",
    });
    expect(ledgerEvent).toEqual({
      eventId: "evt_subscription_created_trialing",
      eventType: "customer.subscription.created",
    });
  });
});
