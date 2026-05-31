/**
 * End-to-end style integration test for the Stripe billing TRIAL lifecycle.
 *
 * Companion to the unit coverage in billing-*.test.ts. Where those cover
 * pieces in isolation, this drives the REAL Express billing router
 * (`billingRoutes(db, cfg)`) over HTTP via supertest, against a REAL embedded
 * Postgres (same harness as billing-webhook-entitlement-integration.test.ts),
 * with a real Stripe instance for signature crypto and stubbed Stripe network
 * calls. It walks the full trial lifecycle a Pro customer experiences:
 *
 *   1. POST /checkout-session  -> provisions a Stripe customer + a Checkout
 *                                 Session whose subscription_data carries the
 *                                 trial (trial_period_days).
 *   2. customer.subscription.created (status: trialing) -> company -> pro_trial
 *   3. customer.subscription.updated (status: active)   -> company -> pro_active
 *   4. customer.subscription.deleted (status: canceled) -> company -> pro_canceled
 *
 * It also asserts the two webhook safety invariants:
 *   - Signature verification: a body signed with the wrong secret is rejected
 *     (400) and does NOT mutate entitlements.
 *   - Idempotency: replaying an already-processed event id is a no-op — the
 *     ledger's unique-constraint short-circuit means the handler never re-runs.
 *
 * The webhook route reads `(req as any).rawBody` and verifies the signature
 * with `cfg.stripe.webhooks.constructEvent`. We give it a real Stripe instance
 * so the signature path is genuinely exercised, and capture the raw request
 * body in middleware exactly as the production app wiring does.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import Stripe from "stripe";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, stripeWebhookEvents } from "@paperclipai/db";
import { billingRoutes } from "../routes/billing.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const WEBHOOK_SECRET = "whsec_trial_lifecycle_test_secret";
const PRO_PRICE_ID = "price_pro_test";
const TRIAL_DAYS = 14;

// Real Stripe instance: we use ONLY its webhook crypto helpers
// (constructEvent / generateTestHeaderString) — no API key required for those.
// The network-touching methods below are stubbed via vi.spyOn per-test.
const stripe = new Stripe("sk_test_dummy", {
  apiVersion: "2024-06-20" as Stripe.LatestApiVersion,
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Webhook event factory + signed delivery helper.
// ---------------------------------------------------------------------------

function subscriptionEvent(
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  opts: {
    id: string;
    status: Stripe.Subscription.Status;
    customerId: string;
    subscriptionId: string;
    companyId: string;
    seats?: number;
  },
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: opts.id,
    object: "event",
    api_version: "2024-06-20",
    created: now,
    type,
    data: {
      object: {
        id: opts.subscriptionId,
        object: "subscription",
        customer: opts.customerId,
        status: opts.status,
        current_period_end: now + 30 * 86400,
        trial_end: opts.status === "trialing" ? now + TRIAL_DAYS * 86400 : null,
        items: { object: "list", data: [{ price: { id: PRO_PRICE_ID }, quantity: opts.seats ?? 1 }] },
        metadata: { companyId: opts.companyId },
      },
    },
  };
}

describeEmbeddedPostgres("billing trial lifecycle (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  // Mutable allow-list of company ids the injected actor "belongs to". Each
  // test seeds a company and pushes its id here before hitting a route.
  const ALL_COMPANY_IDS: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-billing-trial-");
    db = createDb(tempDb.connectionString);

    const cfg = {
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      proPriceId: PRO_PRICE_ID,
      trialDays: TRIAL_DAYS,
      publicBaseUrl: "http://localhost:3100",
    };

    app = express();
    // Capture the raw body the webhook route verifies the signature against,
    // and parse JSON for the protected routes. The order mirrors the real app:
    // raw capture must see the unparsed stream.
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    // Inject a board actor that is a member of every company so the protected
    // checkout-session route passes its authz guard. The webhook route does
    // not consult req.actor.
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        userId: "user-trial-test",
        companyIds: ALL_COMPANY_IDS,
      };
      next();
    });
    app.use("/api/billing", billingRoutes(db, cfg));
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(stripeWebhookEvents);
    await db.delete(companies);
    ALL_COMPANY_IDS.length = 0;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: {
    planTier?: string;
    stripeCustomerId?: string | null;
  } = {}): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Trial Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      planTier: opts.planTier ?? "free",
      stripeCustomerId: opts.stripeCustomerId ?? null,
    });
    ALL_COMPANY_IDS.push(companyId);
    return companyId;
  }

  async function tierOf(companyId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ planTier: companies.planTier })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row?.planTier ?? undefined;
  }

  async function deliverWebhook(
    event: Record<string, unknown>,
    opts: { secret?: string } = {},
  ) {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: opts.secret ?? WEBHOOK_SECRET,
    });
    return request(app)
      .post("/api/billing/webhook")
      .set("stripe-signature", header)
      .set("content-type", "application/json")
      .send(payload);
  }

  it("creates a checkout session that provisions a customer + trial subscription", async () => {
    const companyId = await seedCompany();

    const customerCreate = vi
      .spyOn(stripe.customers, "create")
      // @ts-expect-error — minimal stub of the Stripe response shape
      .mockResolvedValue({ id: "cus_checkout_1" });
    const sessionCreate = vi
      .spyOn(stripe.checkout.sessions, "create")
      // @ts-expect-error — minimal stub of the Stripe response shape
      .mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });

    const res = await request(app)
      .post("/api/billing/checkout-session")
      .send({ companyId });

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("checkout.stripe.com");

    // A customer was created and persisted, and the checkout session carried
    // the trial via subscription_data.trial_period_days.
    expect(customerCreate).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    const sessionArg = sessionCreate.mock.calls[0][0] as {
      mode: string;
      subscription_data: { trial_period_days: number };
      line_items: { price: string }[];
    };
    expect(sessionArg.mode).toBe("subscription");
    expect(sessionArg.subscription_data.trial_period_days).toBe(TRIAL_DAYS);
    expect(sessionArg.line_items[0].price).toBe(PRO_PRICE_ID);

    const [row] = await db
      .select({ stripeCustomerId: companies.stripeCustomerId })
      .from(companies)
      .where(eq(companies.id, companyId));
    expect(row.stripeCustomerId).toBe("cus_checkout_1");
  });

  it("flips company to pro_trial on customer.subscription.created (trialing)", async () => {
    const companyId = await seedCompany({ stripeCustomerId: "cus_trial_1" });
    expect(await tierOf(companyId)).toBe("free");

    const res = await deliverWebhook(
      subscriptionEvent("customer.subscription.created", {
        id: "evt_created_1",
        status: "trialing",
        customerId: "cus_trial_1",
        subscriptionId: "sub_trial_1",
        companyId,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(await tierOf(companyId)).toBe("pro_trial");

    const [row] = await db
      .select({
        stripeSubscriptionId: companies.stripeSubscriptionId,
        stripeCustomerId: companies.stripeCustomerId,
      })
      .from(companies)
      .where(eq(companies.id, companyId));
    expect(row.stripeSubscriptionId).toBe("sub_trial_1");
    expect(row.stripeCustomerId).toBe("cus_trial_1");
  });

  it("promotes pro_trial -> pro_active on customer.subscription.updated (active)", async () => {
    const companyId = await seedCompany({ stripeCustomerId: "cus_trial_2" });

    await deliverWebhook(
      subscriptionEvent("customer.subscription.created", {
        id: "evt_created_2",
        status: "trialing",
        customerId: "cus_trial_2",
        subscriptionId: "sub_trial_2",
        companyId,
      }),
    );
    expect(await tierOf(companyId)).toBe("pro_trial");

    const res = await deliverWebhook(
      subscriptionEvent("customer.subscription.updated", {
        id: "evt_updated_2",
        status: "active",
        customerId: "cus_trial_2",
        subscriptionId: "sub_trial_2",
        companyId,
      }),
    );

    expect(res.status).toBe(200);
    expect(await tierOf(companyId)).toBe("pro_active");
  });

  it("demotes to pro_canceled on customer.subscription.deleted", async () => {
    const companyId = await seedCompany({ stripeCustomerId: "cus_trial_3" });

    await deliverWebhook(
      subscriptionEvent("customer.subscription.created", {
        id: "evt_created_3",
        status: "trialing",
        customerId: "cus_trial_3",
        subscriptionId: "sub_trial_3",
        companyId,
      }),
    );
    await deliverWebhook(
      subscriptionEvent("customer.subscription.updated", {
        id: "evt_updated_3",
        status: "active",
        customerId: "cus_trial_3",
        subscriptionId: "sub_trial_3",
        companyId,
      }),
    );
    expect(await tierOf(companyId)).toBe("pro_active");

    const res = await deliverWebhook(
      subscriptionEvent("customer.subscription.deleted", {
        id: "evt_deleted_3",
        status: "canceled",
        customerId: "cus_trial_3",
        subscriptionId: "sub_trial_3",
        companyId,
      }),
    );

    expect(res.status).toBe(200);
    expect(await tierOf(companyId)).toBe("pro_canceled");
  });

  it("walks the full lifecycle free -> pro_trial -> pro_active -> pro_canceled", async () => {
    const companyId = await seedCompany({ stripeCustomerId: "cus_life" });
    const tiers: (string | undefined)[] = [];
    tiers.push(await tierOf(companyId)); // free

    await deliverWebhook(
      subscriptionEvent("customer.subscription.created", {
        id: "evt_life_1",
        status: "trialing",
        customerId: "cus_life",
        subscriptionId: "sub_life",
        companyId,
      }),
    );
    tiers.push(await tierOf(companyId)); // pro_trial

    await deliverWebhook(
      subscriptionEvent("customer.subscription.updated", {
        id: "evt_life_2",
        status: "active",
        customerId: "cus_life",
        subscriptionId: "sub_life",
        companyId,
      }),
    );
    tiers.push(await tierOf(companyId)); // pro_active

    await deliverWebhook(
      subscriptionEvent("customer.subscription.deleted", {
        id: "evt_life_3",
        status: "canceled",
        customerId: "cus_life",
        subscriptionId: "sub_life",
        companyId,
      }),
    );
    tiers.push(await tierOf(companyId)); // pro_canceled

    expect(tiers).toEqual(["free", "pro_trial", "pro_active", "pro_canceled"]);
  });

  it("rejects a webhook with an invalid signature and does not mutate entitlements", async () => {
    const companyId = await seedCompany({ stripeCustomerId: "cus_badsig" });

    const res = await deliverWebhook(
      subscriptionEvent("customer.subscription.created", {
        id: "evt_bad_sig",
        status: "trialing",
        customerId: "cus_badsig",
        subscriptionId: "sub_badsig",
        companyId,
      }),
      { secret: "whsec_wrong_secret" },
    );

    expect(res.status).toBe(400);
    // Entitlement untouched and nothing recorded in the ledger.
    expect(await tierOf(companyId)).toBe("free");
    const ledgerRows = await db
      .select({ eventId: stripeWebhookEvents.eventId })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, "evt_bad_sig"));
    expect(ledgerRows).toHaveLength(0);
  });

  it("treats a replayed event id as an idempotent no-op", async () => {
    const companyId = await seedCompany({ stripeCustomerId: "cus_dupe" });
    const event = subscriptionEvent("customer.subscription.created", {
      id: "evt_dupe",
      status: "trialing",
      customerId: "cus_dupe",
      subscriptionId: "sub_dupe",
      companyId,
    });

    const first = await deliverWebhook(event);
    expect(first.status).toBe(200);
    expect(await tierOf(companyId)).toBe("pro_trial");

    // Manually downgrade so we can prove the replay does NOT re-apply the
    // entitlement (the ledger short-circuits before applyFromSubscription).
    await db
      .update(companies)
      .set({ planTier: "free" })
      .where(eq(companies.id, companyId));

    const replay = await deliverWebhook(event);
    expect(replay.status).toBe(200);
    expect(await tierOf(companyId)).toBe("free");

    // Exactly one ledger row exists for the event id.
    const ledgerRows = await db
      .select({ eventId: stripeWebhookEvents.eventId })
      .from(stripeWebhookEvents)
      .where(eq(stripeWebhookEvents.eventId, "evt_dupe"));
    expect(ledgerRows).toHaveLength(1);
  });
});
