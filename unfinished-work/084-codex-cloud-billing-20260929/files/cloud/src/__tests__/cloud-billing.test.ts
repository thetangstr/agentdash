// AgentDash: SC-8 signatures are checked independently by the real box Stripe SDK.
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Secret } from "../secret.js";
import { loadConfig } from "../config.js";
import { encryptField } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxes, stripeDeliveries } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { stripeSignature, subscriptionPlanTier, verifyStripeSignature } from "../billing/stripe.js";
import { stripeWebhook } from "../billing/webhook.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

const Stripe = createRequire(new URL("../../../server/package.json", import.meta.url))("stripe");
const sdk = new Stripe("sk_test_offline_only");
const secret = new Secret("whsec_offline_test_signature");
const logLines: string[] = [];
const log = createLogger({ write: (line) => logLines.push(line) });
const config = loadConfig({ DATABASE_URL: "postgres://unused", CLOUD_DATA_KEY: "44".repeat(32), CLOUD_ADMIN_TOKEN: "0123456789abcdef".repeat(4), CLOUD_STRIPE_WEBHOOK_SECRET: secret.reveal(), CLOUD_STRIPE_CONTROL_KEY: "rk_test_controloffline", CLOUD_STRIPE_BOX_KEY: "rk_test_boxesoffline", CLOUD_STRIPE_PRO_PRICE_ID: "price_offline" });
let pg: TestDatabase, db: CloudDb, close: () => Promise<void>, boxId: string;
beforeAll(async () => {
  pg = await startTestDatabase(); await migrateCloudDb(pg.url); ({ db, close } = createCloudDb(pg.url));
  const [account] = await db.insert(accounts).values({ email: "billing@example.test" }).returning();
  const [box] = await db.insert(boxes).values({ accountId: account.id, slug: "billing-box", upstreamHost: "billing-box.up.railway.app", stripeWebhookSecretEnc: encryptField(config.dataKeys, secret.reveal(), "boxes.stripe_webhook_secret_enc") }).returning();
  boxId = box.id;
  await db.update(boxes).set({ state: "provisioning" }).where(eq(boxes.id, box.id));
});
afterAll(async () => { await close?.(); await pg?.stop(); });

describe("Stripe-format signatures", () => {
  it("mirrors box entitlement states, including denial after failed payment", () => {
    expect(["trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "paused"].map(subscriptionPlanTier)).toEqual(["pro_trial", "pro_active", "pro_past_due", "pro_canceled", "pro_canceled", "free", "free"]);
  });
  it("uses exact bytes accepted by real Stripe constructEvent, including whitespace and UTF-8", () => {
    const raw = Buffer.from('{ "id":"evt_signature", "object":"event", "message":"é🚀" }\n');
    const signature = stripeSignature(raw, secret);
    expect(sdk.webhooks.constructEvent(raw, signature, secret.reveal()).id).toBe("evt_signature");
    expect(() => sdk.webhooks.constructEvent(Buffer.concat([raw, Buffer.from(" ")]), signature, secret.reveal())).toThrow();
    expect(verifyStripeSignature(raw, signature, secret)).toBe(true);
    expect(verifyStripeSignature(Buffer.concat([raw, Buffer.from(" ")]), signature, secret)).toBe(false);
  });
  it("rejects expired/future/malformed signatures and supports multiple v1 values", () => {
    const raw = Buffer.from("{}"); const now = 1_700_000_000;
    expect(verifyStripeSignature(raw, stripeSignature(raw, secret, now - 301), secret, now)).toBe(false);
    expect(verifyStripeSignature(raw, stripeSignature(raw, secret, now + 301), secret, now)).toBe(false);
    expect(verifyStripeSignature(raw, "t=no,v1=bad", secret, now)).toBe(false);
    expect(verifyStripeSignature(raw, stripeSignature(raw, secret, now) + ",v1=" + "00".repeat(32), secret, now)).toBe(true);
  });
});

describe("signed control-plane fanout", () => {
  let n = 0;
  function event(slug = "billing-box", status?: string) {
    return Buffer.from(JSON.stringify({ id: `evt_offline_${++n}`, object: "event", type: status ? "customer.subscription.updated" : "checkout.session.completed", created: 100 + n, data: { object: { id: status ? "sub_offline" : "cs_offline", metadata: { box_slug: slug, companyId: "co_a" }, status } } }) + "\n");
  }
  function app(f: typeof fetch, alerts: unknown[] = []) {
    const app = express();
    app.post("/webhook", express.raw({ type: "application/json", limit: "256kb", inflate: false }), stripeWebhook({ db, config, log, alerter: { send: async (a) => { alerts.push(a); } }, fetch: f }));
    return app;
  }
  function post(app: express.Express, raw: Buffer, signature = stripeSignature(raw, secret)) {
    return request(app).post("/webhook").set("content-type", "application/json").set("stripe-signature", signature).send(raw.toString("utf8"));
  }
  it("forwards original bytes to the DB-recorded host with real Stripe-compatible auth; replay is deduplicated", async () => {
    const raw = event(); const f = vi.fn(async (url, options) => {
      expect(url).toBe("https://billing-box.up.railway.app/api/billing/webhook");
      expect(Buffer.from(options!.body as Buffer)).toEqual(raw);
      expect(sdk.webhooks.constructEvent(Buffer.from(options!.body as Uint8Array), (options!.headers as Record<string, string>)["stripe-signature"], secret.reveal()).id).toContain("evt_offline_");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const service = app(f);
    expect((await post(service, raw)).status).toBe(200);
    expect((await post(service, raw)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await db.select().from(stripeDeliveries)).some((row) => row.boxId === boxId)).toBe(true);
  });
  it("denies tampering before parsing or outbound work", async () => {
    const raw = event(); const f = vi.fn();
    expect((await post(app(f), Buffer.concat([raw, Buffer.from(" ")]), stripeSignature(raw, secret))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("acknowledges unknown signed slugs, alerts and never fans out", async () => {
    const f = vi.fn(); const alerts: unknown[] = [];
    expect((await post(app(f, alerts), event("unknown-box"))).status).toBe(200);
    expect(f).not.toHaveBeenCalled(); expect(alerts).toHaveLength(1);
  });
  it("retries a failed box delivery rather than marking it complete", async () => {
    const raw = event(); const f = vi.fn().mockResolvedValueOnce(new Response("whsec_should_not_echo", { status: 503 })).mockResolvedValue(new Response("{}"));
    const service = app(f);
    expect((await post(service, raw)).status).toBe(502); expect((await post(service, raw)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2); expect(logLines.join("\n")).not.toContain("whsec_should_not_echo");
  });
  it("serializes concurrent duplicate deliveries", async () => {
    const raw = event(); const f = vi.fn(async () => new Response("{}")); const service = app(f);
    const responses = await Promise.all([post(service, raw), post(service, raw)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]); expect(f).toHaveBeenCalledTimes(1);
  });
  it("uses current Stripe subscription state when an older update arrives after cancellation", async () => {
    const f = vi.fn(async (url) => String(url).startsWith("https://api.stripe.com/") ? new Response(JSON.stringify({ id: "sub_offline", status: "canceled", metadata: { box_slug: "billing-box" } })) : new Response("{}"));
    await db.update(boxes).set({ planTier: "pro" }).where(eq(boxes.id, boxId));
    expect((await post(app(f), event("billing-box", "active"))).status).toBe(200);
    expect((await db.select().from(boxes).where(eq(boxes.id, boxId)))[0].planTier).toBe("pro_canceled");
  });
  it("rejects reuse of an event ID with different signed bytes", async () => {
    const raw = event(); const f = vi.fn(async () => new Response("{}")); const service = app(f);
    expect((await post(service, raw)).status).toBe(200);
    const changed = Buffer.from(raw.toString().replace("co_a", "co_b"));
    expect((await post(service, changed)).status).toBe(400); expect(f).toHaveBeenCalledTimes(1);
  });
  it("never follows a target outside the DB-known Railway host boundary", async () => {
    const raw = event(); const f = vi.fn();
    await db.update(boxes).set({ upstreamHost: "attacker.example" }).where(eq(boxes.id, boxId));
    try { expect((await post(app(f), raw)).status).toBe(502); expect(f).not.toHaveBeenCalled(); }
    finally { await db.update(boxes).set({ upstreamHost: "billing-box.up.railway.app" }).where(eq(boxes.id, boxId)); }
  });
  it("authenticates the direct box request through the existing edge gate without changing its launch flag", async () => {
    const edgeSecret = "offline-edge-credential-0123456789abcdef";
    await db.update(boxes).set({ edgeSecretEnc: encryptField(config.dataKeys, edgeSecret, "boxes.edge_secret_enc") }).where(eq(boxes.id, boxId));
    const f = vi.fn(async (_url, init) => { expect(new Headers(init?.headers).get("x-agentdash-edge")).toBe(edgeSecret); return new Response("{}"); });
    expect((await post(app(f), event())).status).toBe(200); expect(config.edgeLive).toBe(false); expect(logLines.join()).not.toContain(edgeSecret);
  });
  it("replays after the box accepted but the delivery transaction failed to commit", async () => {
    const raw = event(); const f = vi.fn(async () => new Response("{}")); const service = app(f);
    await db.execute(sql`create function offline_fail_delivery() returns trigger language plpgsql as $$ begin raise exception 'offline crash simulation'; end $$`);
    await db.execute(sql`create trigger offline_fail_delivery before insert on stripe_deliveries for each row execute function offline_fail_delivery()`);
    try { expect((await post(service, raw)).status).toBe(502); }
    finally { await db.execute(sql`drop trigger offline_fail_delivery on stripe_deliveries`); await db.execute(sql`drop function offline_fail_delivery()`); }
    expect((await post(service, raw)).status).toBe(200); expect(f).toHaveBeenCalledTimes(2);
  });
});
