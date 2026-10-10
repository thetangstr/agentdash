// AgentDash: actual box webhook must commit entitlements with its ledger and ignore stale snapshots.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companies, companyMemberships, createDb, stripeWebhookEvents } from "@paperclipai/db";
import { billingRoutes } from "../routes/billing.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadConfig } from "../../../cloud/src/config.js";
import { encryptField } from "../../../cloud/src/crypto.js";
import { createCloudDb, migrateCloudDb } from "../../../cloud/src/db/client.js";
import { accounts, boxes, stripeDeliveries } from "../../../cloud/src/db/schema.js";
import { createLogger } from "../../../cloud/src/logger.js";
import { stripeWebhook } from "../../../cloud/src/billing/webhook.js";
import { startTestDatabase } from "../../../cloud/src/__tests__/embedded-pg.js";

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("../auth/email.js", () => ({ sendEmail }));

const support = await getEmbeddedPostgresTestSupport();
const run = support.supported ? describe : describe.skip;
const secret = "whsec_boxofflineretry";
const stripe = new Stripe("sk_test_offline_only");
const controlSecret = "whsec_control_offline_only";
const config = loadConfig({ DATABASE_URL: "postgres://unused", CLOUD_DATA_KEY: "55".repeat(32), CLOUD_ADMIN_TOKEN: "abcdef0123456789".repeat(4), CLOUD_STRIPE_WEBHOOK_SECRET: controlSecret, CLOUD_STRIPE_CONTROL_KEY: "rk_test_controloffline", CLOUD_STRIPE_BOX_KEY: "rk_test_boxesoffline", CLOUD_STRIPE_PRO_PRICE_ID: "price_offline" });
run("cloud forwarding into the actual box", () => {
  let db: ReturnType<typeof createDb>, pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let cloud: ReturnType<typeof createCloudDb>, cloudPg: Awaited<ReturnType<typeof startTestDatabase>>;
  let current: any;
  const retrieve = vi.spyOn(stripe.subscriptions, "retrieve").mockImplementation(async () => current);
  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("sc8-box-retry-"); db = createDb(pg.connectionString);
    cloudPg = await startTestDatabase(); await migrateCloudDb(cloudPg.url); cloud = createCloudDb(cloudPg.url);
  }, 60_000);
  afterAll(async () => { retrieve.mockRestore(); vi.unstubAllEnvs(); await cloud?.close(); await cloudPg?.stop(); await pg?.cleanup(); });
  async function setup(tier = "free") {
    const id = randomUUID(), suffix = id.replaceAll("-", "");
    const slug = `proof-${suffix.slice(0, 8)}`;
    vi.stubEnv("AGENTDASH_BOX_SLUG", slug);
    await db.insert(companies).values({ id, name: "SC8 Synthetic", issuePrefix: `S${suffix.slice(0, 6)}`, planTier: tier, stripeCustomerId: `cus_${suffix}`, stripeSubscriptionId: `sub_${suffix}` });
    const sub = { id: `sub_${suffix}`, customer: `cus_${suffix}`, status: "trialing", current_period_end: 1_800_000_000, items: { data: [{ quantity: 3 }] }, metadata: { companyId: id, box_slug: slug } };
    current = sub;
    const app = express(); app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    app.use("/api/billing", billingRoutes(db, { stripe, webhookSecret: secret, proPriceId: "price_offline", trialDays: 14, publicBaseUrl: "https://proof-box.agentdash.cloud" }));
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: "retry" }); });
    const event = { id: `evt_${suffix}`, object: "event", type: "customer.subscription.updated", data: { object: sub } };
    async function deliver(value = event) { const raw = JSON.stringify(value); return request(app).post("/api/billing/webhook").set("content-type", "application/json").set("stripe-signature", stripe.webhooks.generateTestHeaderString({ payload: raw, secret })).send(raw); }
    const [account] = await cloud.db.insert(accounts).values({ email: `${suffix}@example.test` }).returning();
    const [box] = await cloud.db.insert(boxes).values({ accountId: account.id, slug, upstreamHost: `${slug}.up.railway.app`, stripeWebhookSecretEnc: encryptField(config.dataKeys, secret, "boxes.stripe_webhook_secret_enc") }).returning();
    await cloud.db.update(boxes).set({ state: "provisioning", planTier: tier }).where(eq(boxes.id, box.id));
    const forwarded: Buffer[] = [];
    const fetchOffline = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.stripe.com/")) return new Response(JSON.stringify(current));
      expect(String(url)).toBe(`https://${slug}.up.railway.app/api/billing/webhook`);
      const raw = Buffer.from(init!.body as Uint8Array); forwarded.push(raw);
      const response = await request(app).post("/api/billing/webhook").set(Object.fromEntries(new Headers(init?.headers))).send(raw.toString("utf8"));
      return new Response(JSON.stringify(response.body), { status: response.status });
    }) as unknown as typeof fetch;
    const control = express(); control.post("/webhook", express.raw({ type: "application/json", inflate: false }), stripeWebhook({ db: cloud.db, config, log: createLogger({ write: () => {} }), alerter: { send: async () => {} }, fetch: fetchOffline }));
    async function fanout(value = event) {
      const raw = JSON.stringify({ ...value, proof: "é🚀" }, null, 1) + "\n";
      const response = await request(control).post("/webhook").set("content-type", "application/json").set("stripe-signature", stripe.webhooks.generateTestHeaderString({ payload: raw, secret: controlSecret })).send(raw);
      if (forwarded.length) expect(forwarded.at(-1)).toEqual(Buffer.from(raw));
      return response;
    }
    return { id, sub, app, event, deliver, fanout, box, forwarded };
  }
  it("keeps a canceled company canceled when an older active event is signed and delivered", async () => {
    const s = await setup("pro_canceled"); current = { ...s.sub, status: "canceled" };
    const stale = { ...s.event, data: { object: { ...s.sub, status: "active" } } };
    expect((await s.fanout(stale)).status).toBe(200);
    expect((await db.select().from(companies).where(eq(companies.id, s.id)))[0].planTier).toBe("pro_canceled");
    expect((await cloud.db.select().from(boxes).where(eq(boxes.id, s.box.id)))[0].planTier).toBe("pro_canceled");
    expect(retrieve).toHaveBeenCalledWith(s.sub.id, { timeout: 5_000, maxNetworkRetries: 0 });
  });
  it("rolls back the ledger when the entitlement update fails, then applies a same-event retry", async () => {
    const s = await setup();
    await db.execute(sql`create function sc8_fail_entitlement() returns trigger language plpgsql as $$ begin raise exception 'offline write failure'; end $$`);
    await db.execute(sql`create trigger sc8_fail_entitlement before update of plan_tier on companies for each row execute function sc8_fail_entitlement()`);
    try { expect((await s.fanout()).status).toBe(502); }
    finally { await db.execute(sql`drop trigger sc8_fail_entitlement on companies`); await db.execute(sql`drop function sc8_fail_entitlement()`); }
    expect(await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, s.event.id))).toHaveLength(0);
    expect(await cloud.db.select().from(stripeDeliveries).where(eq(stripeDeliveries.eventId, s.event.id))).toHaveLength(0);
    expect((await s.fanout()).status).toBe(200);
    expect((await db.select().from(companies).where(eq(companies.id, s.id)))[0]).toMatchObject({ planTier: "pro_trial", planSeatsPaid: 3 });
    expect(await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, s.event.id))).toHaveLength(1);
    expect(await cloud.db.select().from(stripeDeliveries).where(eq(stripeDeliveries.eventId, s.event.id))).toHaveLength(1);
    expect(s.forwarded).toHaveLength(2);
  });
  it.each(["id", "customer", "company", "box"])("denies a current subscription with changed %s routing without poisoning the ledger", async (field) => {
    const s = await setup();
    current = { ...s.sub, metadata: { ...s.sub.metadata } };
    if (field === "id") current.id = "sub_wrong";
    if (field === "customer") current.customer = "cus_wrong";
    if (field === "company") current.metadata.companyId = randomUUID();
    if (field === "box") current.metadata.box_slug = "wrong-box";
    expect((await s.deliver()).status).toBe(500);
    expect((await db.select().from(companies).where(eq(companies.id, s.id)))[0].planTier).toBe("free");
    expect(await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, s.event.id))).toHaveLength(0);
  });
  it("releases a blocked delivery after the bounded database lock wait and permits retry", async () => {
    const s = await setup();
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const lock = db.transaction(async (tx) => { await tx.select().from(companies).where(eq(companies.id, s.id)).for("update"); acquired(); await held; });
    await ready;
    const timeout = setTimeout(release, 4_000);
    try { expect((await s.deliver()).status).toBe(500); }
    finally { clearTimeout(timeout); release(); await lock; }
    expect(await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, s.event.id))).toHaveLength(0);
    expect((await s.deliver()).status).toBe(200);
  }, 10_000);
  it("forwards trial_will_end and sends the actual box reminder only after commit, once on replay", async () => {
    const s = await setup("pro_trial");
    const userId = randomUUID(), email = `${userId}@example.test`, now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Synthetic Founder", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: s.id, principalType: "user", principalId: userId, status: "active" });
    sendEmail.mockClear();
    const emailLedgerCounts: number[] = [];
    sendEmail.mockImplementation(async () => { emailLedgerCounts.push((await db.select().from(stripeWebhookEvents).where(eq(stripeWebhookEvents.eventId, s.event.id))).length); });
    const event = { ...s.event, type: "customer.subscription.trial_will_end", data: { object: { ...s.sub, trial_end: Math.floor(Date.now() / 1000) + 3 * 86400 } } };
    await db.execute(sql`create function sc8_fail_trial_ledger() returns trigger language plpgsql as $$ begin raise exception 'offline ledger failure'; end $$`);
    await db.execute(sql`create trigger sc8_fail_trial_ledger before insert on stripe_webhook_events for each row execute function sc8_fail_trial_ledger()`);
    try { expect((await s.fanout(event)).status).toBe(502); expect(sendEmail).not.toHaveBeenCalled(); }
    finally { await db.execute(sql`drop trigger sc8_fail_trial_ledger on stripe_webhook_events`); await db.execute(sql`drop function sc8_fail_trial_ledger()`); }
    expect((await s.fanout(event)).status).toBe(200);
    expect((await s.fanout(event)).status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(emailLedgerCounts).toEqual([1]);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: email, subject: "Your AgentDash Pro trial ends in 3 days" }));
    expect((await db.select().from(companies).where(eq(companies.id, s.id)))[0].planTier).toBe("pro_trial");
  });
});
