// AgentDash (SC-8, GH #769): a hosted box writes box_slug into its Stripe
// metadata, and an event the self-serve control plane forwards (re-signed
// with the box's own STRIPE_WEBHOOK_SECRET by cloud/src/stripe/signature.ts)
// passes the box's real, unmodified webhook route: the real stripe package's
// constructEvent, the ledger and entitlement sync on embedded Postgres.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, stripeWebhookEvents } from "@paperclipai/db";
import { billingRoutes } from "../routes/billing.js";
import { billingService } from "../services/billing.js";
// The control plane's signer, exactly as it forwards (no copy of the algorithm here).
import { signStripePayload } from "../../../cloud/src/stripe/signature.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function fakeStripe() {
  return {
    customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
    checkout: { sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.com/pay/sess_test" })) } },
    billingPortal: { sessions: { create: vi.fn() } },
  };
}

function companiesStub() {
  return { getById: vi.fn(async () => ({ id: "co-1", name: "Acme", stripeCustomerId: null })), update: vi.fn(async () => null) };
}

const baseConfig = { proPriceId: "price_test123", trialDays: 14, publicBaseUrl: "https://acme.agentdash.cloud", configured: true };

describe("box_slug in Stripe metadata (SC-8)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes box_slug beside companyId on the customer, the session and the subscription when the box has a slug", async () => {
    const stripe = fakeStripe();
    await billingService({ stripe, companies: companiesStub(), config: { ...baseConfig, boxSlug: "acme" } }).createCheckoutSession("co-1");
    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { companyId: "co-1", box_slug: "acme" } }));
    const session = (stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(session.metadata).toEqual({ companyId: "co-1", box_slug: "acme" });
    expect(session.subscription_data.metadata).toEqual({ companyId: "co-1", box_slug: "acme" });
  });

  it("reads AGENTDASH_BOX_SLUG when the config does not say", async () => {
    vi.stubEnv("AGENTDASH_BOX_SLUG", " beta ");
    const stripe = fakeStripe();
    await billingService({ stripe, companies: companiesStub(), config: baseConfig }).createCheckoutSession("co-1");
    const session = (stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(session.subscription_data.metadata).toEqual({ companyId: "co-1", box_slug: "beta" });
  });

  it("adds nothing on a self-hosted instance (no slug)", async () => {
    vi.stubEnv("AGENTDASH_BOX_SLUG", "");
    const stripe = fakeStripe();
    await billingService({ stripe, companies: companiesStub(), config: baseConfig }).createCheckoutSession("co-1");
    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { companyId: "co-1" } }));
    const session = (stripe.checkout.sessions.create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(session.metadata).toBeUndefined();
    expect(session.subscription_data.metadata).toEqual({ companyId: "co-1" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("a forwarded event through the box's real webhook route (SC-8)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const BOX_SECRET = "whsec_this_box_only_" + randomUUID().replace(/-/g, "");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-forwarded-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(stripeWebhookEvents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boxApp() {
    const app = express();
    // The box's own parser (server/src/app.ts): the raw bytes are kept for the signature.
    app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => void ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
    app.use(
      "/api/billing",
      billingRoutes(db, {
        // A real SDK: constructEvent needs no network.
        stripe: new Stripe("sk_test_not_used_for_requests_0000", { apiVersion: "2026-04-22.dahlia" }),
        configured: true,
        webhookSecret: BOX_SECRET,
        proPriceId: "price_test123",
        trialDays: 14,
        publicBaseUrl: "https://acme.agentdash.cloud",
      }),
    );
    return app;
  }

  it("accepts the re-signed event and moves planTier to pro_trial; a tampered body or another box's secret is refused", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Forwarded Co",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      planTier: "free",
      stripeCustomerId: "cus_forwarded",
    });
    const periodEnd = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000);
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_forwarded_trial_1",
        object: "event",
        type: "customer.subscription.created",
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: {
          object: {
            id: "sub_forwarded",
            object: "subscription",
            customer: "cus_forwarded",
            status: "trialing",
            metadata: { companyId, box_slug: "acme" },
            items: { data: [{ quantity: 2, current_period_end: periodEnd }] },
          },
        },
      }),
      "utf8",
    );
    const app = boxApp();

    const tampered = Buffer.from(raw.toString("utf8").replace("trialing", "active___"), "utf8");
    const refused = await request(app).post("/api/billing/webhook").set("content-type", "application/json").set("stripe-signature", signStripePayload(raw, BOX_SECRET)).send(tampered.toString("utf8"));
    expect(refused.status).toBe(400);
    const otherBox = await request(app).post("/api/billing/webhook").set("content-type", "application/json").set("stripe-signature", signStripePayload(raw, "whsec_another_box")).send(raw.toString("utf8"));
    expect(otherBox.status).toBe(400);

    const ok = await request(app).post("/api/billing/webhook").set("content-type", "application/json").set("stripe-signature", signStripePayload(raw, BOX_SECRET)).send(raw.toString("utf8"));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });
    const [company] = await db.select({ planTier: companies.planTier, planSeatsPaid: companies.planSeatsPaid }).from(companies).where(eq(companies.id, companyId));
    expect(company).toEqual({ planTier: "pro_trial", planSeatsPaid: 2 });
  });
});
