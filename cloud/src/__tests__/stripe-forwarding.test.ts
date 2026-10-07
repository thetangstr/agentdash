// SC-8 (GH #769): Stripe fan-out through the account's one webhook endpoint,
// the shared restricted key rotation, and per-box Resend keys. Embedded
// Postgres, a fake Railway API, a fake Resend API, and a fake box whose
// webhook route is the box's own shape: express.json capturing rawBody, then
// the real stripe package's constructEvent with the box's own secret.
// Nothing here reaches Stripe, Resend or Railway.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import Stripe from "stripe";
import request from "supertest";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdmin } from "../admin/run.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decryptField, parseKeyring } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, fleetSecrets, operatorAudit, stripeEvents } from "../db/schema.js";
import { boxResendKeyName, provisionBoxResendKey, revokeBoxResendKey, type ResendKeysClient } from "../email/resend-keys.js";
import type { Alert } from "../jobs/alerts.js";
import { deleteHandler } from "../jobs/cleanup.js";
import type { JobContext, JobRow } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { billingAndMailExtras } from "../railway/box-extras.js";
import { BoxKeyRotationError, promoteDeployedBillingRevs, startBillingPromotionPass, syncFleetBilling, WEBHOOK_SECRET_AAD } from "../stripe/box-billing.js";
import { RailwayClient } from "../railway/client.js";
import { Secret } from "../secret.js";
import { boxProjectDescription, boxProjectName } from "../railway/names.js";
import { checkBoxStripeKey, loadBillingConfig } from "../stripe/config.js";
import { ensureStripeEndpoint, FORWARDED_EVENTS, type StripeEndpointsClient } from "../stripe/endpoint.js";
import { BOX_STRIPE_KEY, fleetSecretStore, STRIPE_ENDPOINT_SECRET } from "../stripe/fleet-secrets.js";
import { DEAD_BODY_TTL_MS, MAX_ATTEMPTS, PARK_RETRY_MS, RETRY_SCHEDULE_MS, stripeForwarder } from "../stripe/forwarder.js";
import { boxSlugOf, parseStripeEvent } from "../stripe/routing.js";
import { signStripePayload, StripeSignatureError, verifyStripeSignature } from "../stripe/signature.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_TOKEN, FAKE_WORKSPACE, FakeRailway } from "./fake-railway.js";

const KEYS = parseKeyring("55".repeat(32));
const ACCOUNT_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const SHARED_KEY = `rk_test_${randomBytes(24).toString("hex")}`;
const SHARED_KEY_2 = `rk_test_${randomBytes(24).toString("hex")}`;
const ADMIN = randomBytes(32).toString("hex");
const stripeLib = new Stripe("sk_test_never_used_for_a_request_000000");

let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const alerts: Alert[] = [];
let clock = Date.now();
let n = 0;

const billing = loadBillingConfig({ CLOUD_STRIPE_WEBHOOK_SECRET: ACCOUNT_SECRET, CLOUD_STRIPE_PRO_PRICE_ID: "price_TestPro29", CLOUD_STRIPE_MODE: "test" });

// ---- the fake box -------------------------------------------------------

interface BoxReceipt {
  host: string;
  eventId: string;
  raw: string;
  edge: string | undefined;
}
const received: BoxReceipt[] = [];
/** Per upstream host: the box's own STRIPE_WEBHOOK_SECRET, and a forced status. */
const fakeBoxes = new Map<string, { secret: string; status?: number }>();
let boxServer: http.Server;
let boxPort = 0;

function startFakeBox(): Promise<void> {
  const app = express();
  // The box's own parser shape (server/src/app.ts): JSON, with the raw bytes kept for the signature.
  app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => void ((req as unknown as { rawBody: Buffer }).rawBody = buf) }));
  // The box's own route body (server/src/routes/billing.ts): constructEvent with its secret, 400 on failure.
  app.post("/api/billing/webhook", (req, res) => {
    const host = String(req.headers["x-forwarded-host-for-test"]);
    const box = fakeBoxes.get(host);
    if (!box) return void res.status(404).end();
    if (box.status) return void res.status(box.status).json({ error: "forced" });
    let event: Stripe.Event;
    try {
      event = stripeLib.webhooks.constructEvent((req as unknown as { rawBody: Buffer }).rawBody, req.header("stripe-signature") ?? "", box.secret);
    } catch {
      return void res.status(400).json({ error: "invalid signature" });
    }
    received.push({ host, eventId: event.id, raw: (req as unknown as { rawBody: Buffer }).rawBody.toString("utf8"), edge: req.header("x-agentdash-edge") });
    res.status(200).json({ received: true });
  });
  boxServer = http.createServer(app);
  return new Promise((resolve) => boxServer.listen(0, "127.0.0.1", () => {
    boxPort = (boxServer.address() as AddressInfo).port;
    resolve();
  }));
}

/** The forwarder's fetch: https://<upstream host>/… goes to the fake box, with the host kept in a header. */
const boxFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  expect(u.protocol).toBe("https:");
  const headers = new Headers(init?.headers);
  headers.set("x-forwarded-host-for-test", u.hostname);
  return fetch(`http://127.0.0.1:${boxPort}${u.pathname}`, { ...init, headers });
}) as typeof fetch;

// ---- helpers ------------------------------------------------------------

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  await startFakeBox();
});

afterAll(async () => {
  if (boxServer) {
    boxServer.closeAllConnections();
    await new Promise((r) => boxServer.close(r));
  }
  await close?.();
  await pg?.stop();
});

beforeEach(() => {
  alerts.length = 0;
  received.length = 0;
  clock = Date.now();
});

async function makeBox(state: "active" | "awaiting_claim" | "suspended" | "provisioning" | "deleted" = "active", opts: { withSecret?: boolean; webService?: boolean } = {}) {
  const slug = `sc${++n}x${Date.now() % 100000}`;
  const [acct] = await db.insert(accounts).values({ email: `founder-${slug}@example.test` }).returning();
  const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug, state: "requested" }).returning();
  const host = `web-${slug}.up.railway.app`;
  const boxSecret = `whsec_${randomBytes(24).toString("base64url")}`;
  const patch: Partial<typeof boxes.$inferInsert> = { upstreamHost: host };
  if (opts.withSecret !== false) {
    const { encryptField } = await import("../crypto.js");
    patch.stripeWebhookSecretEnc = encryptField(KEYS, boxSecret, WEBHOOK_SECRET_AAD);
  }
  if (opts.webService !== false) Object.assign(patch, { projectId: `proj-${slug}`, environmentId: `env-${slug}`, webServiceId: `svc-${slug}` });
  await db.update(boxes).set(patch).where(eq(boxes.id, box!.id));
  const path: Record<string, string[]> = {
    provisioning: ["provisioning"],
    awaiting_claim: ["provisioning", "awaiting_claim"],
    active: ["provisioning", "awaiting_claim", "active"],
    suspended: ["provisioning", "awaiting_claim", "active", "suspended"],
    deleted: ["provisioning", "awaiting_claim", "active", "pending_delete", "deleted"],
  };
  for (const s of path[state]!) await db.update(boxes).set({ state: s as typeof box.state }).where(eq(boxes.id, box!.id));
  fakeBoxes.set(host, { secret: boxSecret });
  projectInfo.set(`proj-${slug}`, { name: boxProjectName(slug), description: boxProjectDescription(box!.id), workspaceId: FAKE_WORKSPACE });
  return { id: box!.id, slug, host, boxSecret };
}

/** What the fake Railway answers for each box's project and latest web deployment. */
const projectInfo = new Map<string, { name: string; description: string; workspaceId: string }>();
const deployments = new Map<string, { id: string; status: string; createdAt: string }>();

async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}

async function eventRow(eventId: string) {
  return (await db.select().from(stripeEvents).where(eq(stripeEvents.eventId, eventId)))[0];
}

function forwarder(extra: Partial<Parameters<typeof stripeForwarder>[0]> = {}) {
  return stripeForwarder({
    db,
    log,
    keys: KEYS,
    billing,
    store: fleetSecretStore(db, KEYS),
    alerter: { send: async (a) => void alerts.push(a) },
    fetch: boxFetch,
    now: () => clock,
    deliverOnReceive: false,
    ...extra,
  });
}

let evtSeq = 0;
function subscriptionEvent(opts: { slug?: string | null; status?: string; created?: number; customer?: string; type?: string; livemode?: boolean } = {}) {
  evtSeq += 1;
  const metadata: Record<string, string> = { companyId: "co-1" };
  if (opts.slug) metadata.box_slug = opts.slug;
  return {
    id: `evt_test_${evtSeq}_${randomBytes(4).toString("hex")}`,
    object: "event",
    type: opts.type ?? "customer.subscription.created",
    created: opts.created ?? Math.floor(clock / 1000),
    livemode: opts.livemode ?? false,
    // Non-ASCII and spacing on purpose: the box must get the exact bytes Stripe signed.
    data: { object: { id: `sub_${evtSeq}`, object: "subscription", customer: opts.customer ?? (opts.slug ? `cus_${opts.slug}` : `cus_T${evtSeq}`), status: opts.status ?? "trialing", metadata, description: "Café Zürich ✓" } },
  };
}

/** Sign as Stripe signs, with Stripe's own test helper. */
function stripeSigned(event: unknown, secret = ACCOUNT_SECRET, timestamp = Math.floor(clock / 1000)) {
  const raw = Buffer.from(JSON.stringify(event, null, 2), "utf8");
  const header = stripeLib.webhooks.generateTestHeaderString({ payload: raw.toString("utf8"), secret, timestamp });
  return { raw, header };
}

function listening(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function noSecretInLogs(...secrets: string[]) {
  const all = logLines.join("\n");
  for (const s of secrets) expect(all).not.toContain(s);
}

// ---- signatures ---------------------------------------------------------

describe("Stripe signatures", () => {
  it("our re-signed header is accepted by the stripe package's own constructEvent; a tampered body is refused", () => {
    const raw = Buffer.from(JSON.stringify(subscriptionEvent({ slug: "acme" })), "utf8");
    const secret = "whsec_box_own_secret_abc";
    const header = signStripePayload(raw, secret);
    expect(stripeLib.webhooks.constructEvent(raw, header, secret).type).toBe("customer.subscription.created");
    const tampered = Buffer.from(raw.toString("utf8").replace("trialing", "active"), "utf8");
    expect(() => stripeLib.webhooks.constructEvent(tampered, header, secret)).toThrow();
    expect(() => stripeLib.webhooks.constructEvent(raw, header, "whsec_some_other_box")).toThrow();
  });

  it("verifies what Stripe's own test helper signs, and refuses tampering, stale timestamps and the wrong secret", () => {
    const { raw, header } = stripeSigned(subscriptionEvent());
    const nowSec = Math.floor(clock / 1000);
    expect(() => verifyStripeSignature(raw, header, [ACCOUNT_SECRET], { nowSec })).not.toThrow();
    // During an endpoint secret roll either secret verifies.
    expect(() => verifyStripeSignature(raw, header, ["whsec_new_one", ACCOUNT_SECRET], { nowSec })).not.toThrow();
    expect(() => verifyStripeSignature(Buffer.concat([raw, Buffer.from(" ")]), header, [ACCOUNT_SECRET], { nowSec })).toThrow(StripeSignatureError);
    expect(() => verifyStripeSignature(raw, header, ["whsec_wrong"], { nowSec })).toThrow(StripeSignatureError);
    expect(() => verifyStripeSignature(raw, header, [ACCOUNT_SECRET], { nowSec: nowSec + 301 })).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(raw, undefined, [ACCOUNT_SECRET], { nowSec })).toThrow(/missing/);
    expect(() => verifyStripeSignature(raw, header, [], { nowSec })).toThrow(/no webhook secret/);
  });

  it("finds box_slug on subscriptions, checkout sessions and invoices (both API shapes)", () => {
    const ev = (object: Record<string, unknown>) => parseStripeEvent(Buffer.from(JSON.stringify({ id: "evt_1", type: "x.y", created: 1, livemode: false, data: { object } })))!;
    expect(boxSlugOf(ev({ metadata: { box_slug: "acme" } }))).toBe("acme");
    expect(boxSlugOf(ev({ parent: { subscription_details: { metadata: { box_slug: "beta" } } } }))).toBe("beta");
    expect(boxSlugOf(ev({ subscription_details: { metadata: { box_slug: "gamma" } } }))).toBe("gamma");
    expect(boxSlugOf(ev({ metadata: { companyId: "c" } }))).toBeNull();
    expect(parseStripeEvent(Buffer.from("not json"))).toBeNull();
  });
});

// ---- receive and deliver ------------------------------------------------

describe("the account webhook endpoint", () => {
  it("forwards a Stripe-signed event to its box; the box's constructEvent accepts the exact bytes; plan_tier follows", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const event = subscriptionEvent({ slug: box.slug, status: "trialing", customer: "cus_Learned1" });
    const { raw, header } = stripeSigned(event);
    const r = await fwd.receive(raw, header);
    expect(r).toEqual({ status: 200, body: { received: true } });
    const row = await eventRow(event.id);
    expect(row).toMatchObject({ state: "pending", boxSlug: box.slug, boxId: box.id, attempts: 0 });
    expect(row!.bodyEnc).not.toContain("Café");
    expect((await boxRow(box.id)).planTier).toBe("pro_trial");
    expect((await boxRow(box.id)).stripeCustomerId).toBe("cus_Learned1");

    expect(await fwd.deliver(row!.id)).toBe("delivered");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ host: box.host, eventId: event.id });
    expect(received[0]!.raw).toBe(raw.toString("utf8"));
    const after = await eventRow(event.id);
    expect(after).toMatchObject({ state: "delivered", attempts: 1, lastStatus: 200, bodyEnc: null });
    noSecretInLogs(ACCOUNT_SECRET, box.boxSecret, "Café");
  });

  it("refuses a tampered body or a bad signature with 400 and stores nothing", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const event = subscriptionEvent({ slug: box.slug });
    const { raw, header } = stripeSigned(event);
    const tampered = Buffer.from(raw.toString("utf8").replace("trialing", "active"));
    expect((await fwd.receive(tampered, header)).status).toBe(400);
    expect((await fwd.receive(raw, "t=1,v1=" + "0".repeat(64))).status).toBe(400);
    expect((await fwd.receive(raw, undefined)).status).toBe(400);
    expect(await eventRow(event.id)).toBeUndefined();
  });

  it("acknowledges a repeated event id (Stripe retry or replay) without forwarding it twice", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const event = subscriptionEvent({ slug: box.slug });
    const { raw, header } = stripeSigned(event);
    expect((await fwd.receive(raw, header)).body).toEqual({ received: true });
    await fwd.deliverDue();
    expect((await fwd.receive(raw, header)).body).toEqual({ received: true, duplicate: true });
    await fwd.deliverDue();
    expect(received.filter((x) => x.eventId === event.id)).toHaveLength(1);
  });

  it("drops an unknown box_slug with 200 and an alert; an event naming no box is dropped quietly", async () => {
    const fwd = forwarder();
    const unknown = subscriptionEvent({ slug: "nosuchbox99" });
    const a = stripeSigned(unknown);
    expect(await fwd.receive(a.raw, a.header)).toEqual({ status: 200, body: { received: true, dropped: "unknown_box", duplicate: false } });
    expect(await eventRow(unknown.id)).toMatchObject({ state: "dropped", reason: "unknown_box", bodyEnc: null });
    expect(alerts).toEqual([expect.objectContaining({ kind: "stripe_unknown_box", slug: "nosuchbox99" })]);

    alerts.length = 0;
    const none = subscriptionEvent({ slug: null, customer: "cus_NeverSeen" });
    const b = stripeSigned(none);
    expect((await fwd.receive(b.raw, b.header)).body).toMatchObject({ dropped: "no_box_slug" });
    expect(alerts).toEqual([]);

    // The script-provisioned launch box shares the account but keeps its own endpoint: dropped quietly.
    const launch = stripeSigned(subscriptionEvent({ slug: "launch" }));
    const quiet = forwarder({ billing: { ...billing, stripeIgnoredSlugs: ["launch"] } });
    expect((await quiet.receive(launch.raw, launch.header)).body).toMatchObject({ dropped: "ignored_box" });
    expect(alerts).toEqual([]);
  });

  it("routes a later event without box_slug (an invoice) by the customer an earlier event taught it", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const first = stripeSigned(subscriptionEvent({ slug: box.slug, customer: "cus_RouteMe7" }));
    await fwd.receive(first.raw, first.header);
    const invoice = { id: `evt_inv_${randomBytes(4).toString("hex")}`, type: "invoice.paid", created: Math.floor(clock / 1000), livemode: false, data: { object: { id: "in_1", customer: "cus_RouteMe7" } } };
    const s = stripeSigned(invoice);
    expect((await fwd.receive(s.raw, s.header)).body).toEqual({ received: true });
    expect(await eventRow(invoice.id)).toMatchObject({ state: "pending", boxSlug: box.slug });
  });

  it("drops events of the other Stripe mode", async () => {
    const box = await makeBox("active");
    const ev = subscriptionEvent({ slug: box.slug, livemode: true });
    const s = stripeSigned(ev);
    expect((await forwarder().receive(s.raw, s.header)).body).toMatchObject({ dropped: "livemode_mismatch" });
  });

  it("answers 503 when no endpoint secret is configured, so Stripe retries", async () => {
    const fwd = forwarder({ billing: { ...billing, stripeWebhookSecrets: [] } });
    const s = stripeSigned(subscriptionEvent());
    expect((await fwd.receive(s.raw, s.header)).status).toBe(503);
  });

  it("never lets an older subscription event overwrite a newer plan_tier", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const now = Math.floor(clock / 1000);
    const newer = stripeSigned(subscriptionEvent({ slug: box.slug, status: "active", created: now, type: "customer.subscription.updated" }));
    const older = stripeSigned(subscriptionEvent({ slug: box.slug, status: "trialing", created: now - 60 }));
    await fwd.receive(newer.raw, newer.header);
    await fwd.receive(older.raw, older.header);
    expect((await boxRow(box.id)).planTier).toBe("pro_active");
    const canceled = stripeSigned(subscriptionEvent({ slug: box.slug, status: "canceled", created: now + 5, type: "customer.subscription.deleted" }));
    await fwd.receive(canceled.raw, canceled.header);
    expect((await boxRow(box.id)).planTier).toBe("pro_canceled");
  });

  it("parks events for a suspended box without spending attempts, then delivers once it is active", async () => {
    const box = await makeBox("suspended");
    const fwd = forwarder();
    const ev = subscriptionEvent({ slug: box.slug });
    const s = stripeSigned(ev);
    await fwd.receive(s.raw, s.header);
    const id = (await eventRow(ev.id))!.id;
    expect(await fwd.deliver(id)).toBe("pending");
    const parked = (await eventRow(ev.id))!;
    expect(parked).toMatchObject({ attempts: 0, reason: "parked:box_suspended" });
    expect(parked.nextAttemptAt.getTime()).toBe(clock + PARK_RETRY_MS);
    expect(received).toHaveLength(0);
    await db.update(boxes).set({ state: "active" }).where(eq(boxes.id, box.id));
    clock += PARK_RETRY_MS;
    await fwd.deliverDue();
    expect((await eventRow(ev.id))!.state).toBe("delivered");
    expect(received.filter((r) => r.eventId === ev.id)).toHaveLength(1);
  });

  it("security review: a box cannot claim another box's customer, or point its own subscription at a victim box", async () => {
    const victim = await makeBox("active");
    const attacker = await makeBox("active");
    const fwd = forwarder();
    // Both boxes bind their customers through ordinary checkouts.
    for (const [b, status] of [[victim, "active"], [attacker, "trialing"]] as const) {
      const s = stripeSigned(subscriptionEvent({ slug: b.slug, customer: `cus_${b.slug}`, status, created: Math.floor(clock / 1000) - 100 }));
      await fwd.receive(s.raw, s.header);
    }
    expect((await boxRow(victim.id)).stripeCustomerId).toBe(`cus_${victim.slug}`);
    await fwd.deliverDue();
    received.length = 0;

    // Shape 1: the attacker writes box_slug=<attacker> on the VICTIM's customer, to divert its events.
    const divert = subscriptionEvent({ slug: attacker.slug, customer: `cus_${victim.slug}`, status: "canceled", type: "customer.subscription.updated" });
    const d = stripeSigned(divert);
    expect((await fwd.receive(d.raw, d.header)).body).toMatchObject({ held: "customer_bound_to_another_box" });
    expect(await eventRow(divert.id)).toMatchObject({ state: "dead", reason: "customer_bound_to_another_box", boxId: victim.id });
    expect(alerts.at(-1)).toMatchObject({ kind: "stripe_routing_conflict", slug: attacker.slug });

    // Shape 2: the attacker writes box_slug=<victim> on its OWN subscription, to corrupt the victim's tier.
    const corrupt = subscriptionEvent({ slug: victim.slug, customer: `cus_${attacker.slug}`, status: "canceled", type: "customer.subscription.deleted" });
    const c = stripeSigned(corrupt);
    expect((await fwd.receive(c.raw, c.header)).body).toMatchObject({ held: "customer_bound_to_another_box" });
    expect(await eventRow(corrupt.id)).toMatchObject({ state: "dead", boxId: attacker.id });

    // A fresh customer naming the victim (bound already to another customer) is held too.
    const fresh = stripeSigned(subscriptionEvent({ slug: victim.slug, customer: "cus_BrandNew99", status: "canceled" }));
    expect((await fwd.receive(fresh.raw, fresh.header)).body).toMatchObject({ held: "box_bound_to_another_customer" });

    // Nothing moved: bindings, tiers, and no forward to either box.
    await fwd.deliverDue();
    expect(received).toEqual([]);
    expect(await boxRow(victim.id)).toMatchObject({ stripeCustomerId: `cus_${victim.slug}`, planTier: "pro_active" });
    expect(await boxRow(attacker.id)).toMatchObject({ stripeCustomerId: `cus_${attacker.slug}`, planTier: "pro_trial" });
    expect((await fwd.list("dead")).filter((e) => [divert.id, corrupt.id].includes(e.eventId))).toHaveLength(2);
    // The database refuses one customer on two boxes outright.
    await expect(db.update(boxes).set({ stripeCustomerId: `cus_${victim.slug}` }).where(eq(boxes.id, attacker.id))).rejects.toThrow();
    // An operator may redeliver a held event: it goes to the box the customer is bound to.
    expect(await fwd.redeliver(divert.id)).toEqual({ ok: true });
    await fwd.deliverDue();
    expect(received.map((r) => [r.host, r.eventId])).toEqual([[victim.host, divert.id]]);
  });

  it("breaks a same-second plan_tier tie by the more final status", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const t = Math.floor(clock / 1000);
    const canceled = stripeSigned(subscriptionEvent({ slug: box.slug, status: "canceled", created: t, type: "customer.subscription.deleted" }));
    const active = stripeSigned(subscriptionEvent({ slug: box.slug, status: "active", created: t, type: "customer.subscription.updated" }));
    await fwd.receive(canceled.raw, canceled.header);
    await fwd.receive(active.raw, active.header);
    expect((await boxRow(box.id)).planTier).toBe("pro_canceled");
  });

  it("forwards only to Railway service domains", async () => {
    const box = await makeBox("active");
    await db.update(boxes).set({ upstreamHost: "attacker.example.com" }).where(eq(boxes.id, box.id));
    const fwd = forwarder();
    const ev = subscriptionEvent({ slug: box.slug });
    const s = stripeSigned(ev);
    await fwd.receive(s.raw, s.header);
    expect(await fwd.deliver((await eventRow(ev.id))!.id)).toBe("pending");
    expect((await eventRow(ev.id))!.reason).toBe("parked:box_has_no_railway_upstream_host");
    expect(received).toEqual([]);
  });

  it("expires dead-letter bodies after 30 days, keeping the row", async () => {
    const box = await makeBox("active");
    fakeBoxes.get(box.host)!.status = 503;
    const fwd = forwarder();
    const ev = subscriptionEvent({ slug: box.slug });
    const s = stripeSigned(ev);
    await fwd.receive(s.raw, s.header);
    await db.update(stripeEvents).set({ attempts: MAX_ATTEMPTS - 1 }).where(eq(stripeEvents.eventId, ev.id));
    expect(await fwd.deliver((await eventRow(ev.id))!.id)).toBe("dead");
    expect(await fwd.pruneDeadBodies()).toBe(0);
    await db.update(stripeEvents).set({ updatedAt: new Date(clock - DEAD_BODY_TTL_MS - 1000) }).where(eq(stripeEvents.eventId, ev.id));
    expect(await fwd.pruneDeadBodies()).toBe(1);
    expect(await eventRow(ev.id)).toMatchObject({ state: "dead", bodyEnc: null });
    expect(await fwd.redeliver(ev.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("drops events for a deleted box", async () => {
    const box = await makeBox("deleted");
    const s = stripeSigned(subscriptionEvent({ slug: box.slug }));
    expect((await forwarder().receive(s.raw, s.header)).body).toMatchObject({ dropped: "box_deleted" });
  });

  it("retries a failing box on the schedule, then dead-letters it with an alert; redeliver puts it back", async () => {
    const box = await makeBox("active");
    fakeBoxes.get(box.host)!.status = 500;
    const fwd = forwarder();
    const ev = subscriptionEvent({ slug: box.slug });
    const s = stripeSigned(ev);
    await fwd.receive(s.raw, s.header);
    const id = (await eventRow(ev.id))!.id;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await fwd.deliver(id)).toBe("pending");
      const row = (await eventRow(ev.id))!;
      expect(row).toMatchObject({ attempts: i, lastStatus: 500, reason: "box answered HTTP 500" });
      expect(row.nextAttemptAt.getTime()).toBe(clock + RETRY_SCHEDULE_MS[i - 1]!);
      // Not due yet: a second worker does nothing.
      expect(await fwd.deliver(id)).toBe("skipped");
      clock += RETRY_SCHEDULE_MS[i - 1]!;
    }
    expect(await fwd.deliver(id)).toBe("dead");
    expect(alerts).toEqual([expect.objectContaining({ kind: "stripe_delivery_dead", slug: box.slug })]);

    const dead = await fwd.list("dead");
    const view = dead.find((d) => d.eventId === ev.id)!;
    expect(view).toMatchObject({ state: "dead", attempts: MAX_ATTEMPTS, boxSlug: box.slug });
    expect(JSON.stringify(view)).not.toContain("bodyEnc");

    fakeBoxes.get(box.host)!.status = undefined;
    expect(await fwd.redeliver(ev.id)).toEqual({ ok: true });
    await fwd.deliverDue();
    expect((await eventRow(ev.id))!.state).toBe("delivered");
    expect(await fwd.redeliver(ev.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("a box whose secret differs from the control plane's refuses the forward (400) and the event retries", async () => {
    const box = await makeBox("active");
    fakeBoxes.get(box.host)!.secret = "whsec_box_was_changed_by_hand";
    const fwd = forwarder();
    const ev = subscriptionEvent({ slug: box.slug });
    const s = stripeSigned(ev);
    await fwd.receive(s.raw, s.header);
    expect(await fwd.deliver((await eventRow(ev.id))!.id)).toBe("pending");
    expect((await eventRow(ev.id))!.lastStatus).toBe(400);
  });
});

// ---- the HTTP route -----------------------------------------------------

function appConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: pg.url,
    CLOUD_DATA_KEY: "55".repeat(32),
    CLOUD_ADMIN_TOKEN: ADMIN,
    CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1",
    CLOUD_STRIPE_WEBHOOK_SECRET: ACCOUNT_SECRET,
    CLOUD_STRIPE_PRO_PRICE_ID: "price_TestPro29",
    ...extra,
  });
}

describe("POST /api/cloud/stripe/webhook (through the app)", () => {
  it("gets the raw bytes (the JSON parser does not run first) and answers 200; a bad signature gets 400", async () => {
    const box = await makeBox("active");
    const fwd = forwarder();
    const app = createApp({ db, config: appConfig(), log, stripe: { forwarder: fwd, railway: null, endpoints: null } });
    const ev = subscriptionEvent({ slug: box.slug });
    const s = stripeSigned(ev);
    const ok = await request(app).post("/api/cloud/stripe/webhook").set("content-type", "application/json").set("stripe-signature", s.header).send(s.raw.toString("utf8"));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });
    const bad = await request(app).post("/api/cloud/stripe/webhook").set("content-type", "application/json").set("stripe-signature", s.header).send(s.raw.toString().replace("trialing", "active"));
    expect(bad.status).toBe(400);
  });

  it("the admin CLI lists dead letters and redelivers through /internal/stripe", async () => {
    const app = createApp({ db, config: appConfig(), log, stripe: { forwarder: forwarder(), railway: null, endpoints: null } });
    const server = await listening(app);
    try {
      const port = (server.address() as AddressInfo).port;
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch };
      const env = { CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_CONTROL_URL: `http://127.0.0.1:${port}` };
      expect(await runAdmin(["stripe", "events"], env, io)).toBe(0);
      expect(Array.isArray(JSON.parse(out.join("\n")))).toBe(true);
      out.length = 0;
      expect(await runAdmin(["stripe", "status"], env, io)).toBe(0);
      expect(JSON.parse(out.join("\n"))).toMatchObject({ mode: "test", webhookUrl: "https://www.agentdash.cloud/api/cloud/stripe/webhook", proPriceId: "price_TestPro29" });
      expect(await runAdmin(["stripe", "redeliver", "evt_nope"], env, io)).toBe(1);
      expect(err.join("\n")).toContain("404");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // GH #923: a GET must not write. The status page used to run
  // promoteDeployedBillingRevs, updating stripe_config_rev and inserting
  // billing_variables_live box events on a read any monitoring caller can
  // trigger. Promotion belongs to the background pass; status only
  // reports the pending count.
  it("GET /internal/stripe/status reports a pending rev without promoting it — the background pass does", async () => {
    const box = await makeBox("active");
    const store = fleetSecretStore(db, KEYS);
    await store.set(BOX_STRIPE_KEY, SHARED_KEY, "test", null);
    await db
      .update(boxes)
      .set({ stripeConfigRev: null, stripeConfigPendingRev: "k1.price_TestPro29.14", stripeConfigPendingSince: new Date() })
      .where(eq(boxes.id, box.id));
    // The deploy after the send succeeded — promotion is due.
    deployed(box.slug);
    const { fake } = fakeRailwayForVars();
    const app = createApp({ db, config: appConfig(), log, stripe: { forwarder: forwarder(), railway: fake.client({ log }), endpoints: null } });
    const server = await listening(app);
    try {
      const port = (server.address() as AddressInfo).port;
      const out: string[] = [];
      const io = { out: (l: string) => out.push(l), err: () => {}, fetch };
      const env = { CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_CONTROL_URL: `http://127.0.0.1:${port}` };
      expect(await runAdmin(["stripe", "status"], env, io)).toBe(0);
      const status = JSON.parse(out.join("\n"));
      expect(status).toMatchObject({ targetRev: "k1.price_TestPro29.14", boxesPendingDeploy: 1 });
      // The read changed nothing: the box still waits for the background pass.
      expect(await boxRow(box.id)).toMatchObject({ stripeConfigRev: null, stripeConfigPendingRev: "k1.price_TestPro29.14" });
      const rows = await db.select().from(boxEvents).where(eq(boxEvents.boxId, box.id));
      expect(rows.filter((r) => r.kind === "billing_variables_live")).toHaveLength(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // The promotion the status used to do is the background pass's job now.
    expect(await promoteDeployedBillingRevs({ db, client: fake.client({ log }), log })).toBe(1);
    expect(await boxRow(box.id)).toMatchObject({ stripeConfigRev: "k1.price_TestPro29.14", stripeConfigPendingRev: null });
    const rows = await db.select().from(boxEvents).where(eq(boxEvents.boxId, box.id));
    expect(rows.filter((r) => r.kind === "billing_variables_live")).toHaveLength(1);
  });
});

// ---- shared key rotation ------------------------------------------------

function fakeRailwayForVars() {
  const fake = new FakeRailway();
  const upserts: Array<{ serviceId: string; variables: Record<string, string>; skipDeploys: boolean }> = [];
  const failFor = new Set<string>();
  fake.resolvers.push({
    match: /variableCollectionUpsert\(/,
    op: "variableCollectionUpsert",
    resolve: (v) => {
      const i = v.i as { serviceId: string; variables: Record<string, string>; skipDeploys: boolean };
      if (failFor.has(i.serviceId)) throw new Error("Service not found");
      upserts.push({ serviceId: i.serviceId, variables: i.variables, skipDeploys: i.skipDeploys });
      return { variableCollectionUpsert: true };
    },
  });
  fake.resolvers.push({
    match: /project\(id:\$id\)\{ id name description workspaceId\s+environments/,
    op: "projectDetail",
    resolve: (v) => {
      const p = projectInfo.get(String(v.id));
      if (!p) throw new Error("Project not found");
      return { project: { id: v.id, ...p, environments: { edges: [] }, services: { edges: [] }, volumes: { edges: [] } } };
    },
  });
  fake.resolvers.push({
    match: /deployments\(first:1/,
    op: "deployments",
    resolve: (v) => {
      const d = deployments.get((v.i as { serviceId: string }).serviceId);
      return { deployments: { edges: d ? [{ node: d }] : [] } };
    },
  });
  return { fake, upserts, failFor };
}

/** The box's web service finished a deployment now (after anything sent before this call). */
function deployed(slug: string, status = "SUCCESS") {
  deployments.set(`svc-${slug}`, { id: `dep-${randomBytes(3).toString("hex")}`, status, createdAt: new Date(Date.now() + 1000).toISOString() });
}

// ---- the background billing-rev promotion pass (GH #923 review) ---------------

describe("the billing rev promotion pass", () => {
  const REV = "k9.price_TestPro29.14";
  async function pendingBox(state: "active" | "deleted" | "provisioning") {
    const box = await makeBox(state);
    await db.update(boxes).set({ stripeConfigRev: null, stripeConfigPendingRev: REV, stripeConfigPendingSince: new Date() }).where(eq(boxes.id, box.id));
    deployed(box.slug);
    return box;
  }
  const polled = (fake: FakeRailway, slug: string) =>
    fake.calls.filter((c) => c.op === "deployments" && (c.variables.i as { serviceId?: string } | undefined)?.serviceId === `svc-${slug}`).length;

  it("never polls Railway for a deleted or failed box, and still promotes a live one", async () => {
    const live = await pendingBox("active");
    const deleted = await pendingBox("deleted");
    // A box whose provisioning failed (the only way into "failed").
    const failed = await pendingBox("provisioning");
    await db.update(boxes).set({ state: "failed" }).where(eq(boxes.id, failed.id));
    const { fake } = fakeRailwayForVars();
    await promoteDeployedBillingRevs({ db, client: fake.client({ log }), log });
    expect(polled(fake, live.slug)).toBe(1);
    expect(polled(fake, deleted.slug)).toBe(0);
    expect(polled(fake, failed.slug)).toBe(0);
    expect(await boxRow(live.id)).toMatchObject({ stripeConfigRev: REV, stripeConfigPendingRev: null });
    // The others are left exactly as they were: no promotion, no event.
    for (const b of [deleted, failed]) {
      expect(await boxRow(b.id)).toMatchObject({ stripeConfigRev: null, stripeConfigPendingRev: REV });
      const rows = await db.select().from(boxEvents).where(eq(boxEvents.boxId, b.id));
      expect(rows.filter((r) => r.kind === "billing_variables_live")).toHaveLength(0);
    }
  });

  it("never runs two passes at once: a tick while one is in flight is skipped", async () => {
    const box = await pendingBox("active");
    const { fake } = fakeRailwayForVars();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    const gated = (async (url: string | URL | Request, init?: RequestInit) => {
      entered += 1;
      await gate;
      return fake.fetch(url, init);
    }) as typeof fetch;
    const client = new RailwayClient({ token: new Secret(FAKE_TOKEN), fetch: gated, url: "http://fake.railway.invalid/graphql", log });
    // The timer never fires during the test; runOnce is what the timer calls.
    const pass = startBillingPromotionPass({ db, client, log, intervalMs: 3_600_000 });
    try {
      const first = pass.runOnce();
      await vi.waitFor(() => expect(entered).toBeGreaterThan(0));
      const callsBefore = entered;
      expect(await pass.runOnce()).toBeNull();
      expect(entered).toBe(callsBefore);
      release();
      expect(await first).toBeGreaterThanOrEqual(1);
      expect(await boxRow(box.id)).toMatchObject({ stripeConfigRev: REV, stripeConfigPendingRev: null });
      // Once the pass finished, the next tick runs again.
      expect(await pass.runOnce()).not.toBeNull();
    } finally {
      pass.stop();
    }
  });

  it("logs a failed pass instead of throwing, and stays usable", async () => {
    const broken = { select: () => { throw new Error("db down"); } } as unknown as CloudDb;
    const { fake } = fakeRailwayForVars();
    const pass = startBillingPromotionPass({ db: broken, client: fake.client({ log }), log, intervalMs: 3_600_000 });
    try {
      logLines.length = 0;
      expect(await pass.runOnce()).toBe(0);
      expect(logLines.some((l) => l.includes("billing rev promotion pass failed"))).toBe(true);
      expect(await pass.runOnce()).toBe(0);
    } finally {
      pass.stop();
    }
  });
});

describe("rotate-box-key", () => {
  beforeEach(async () => {
    await db.execute(sql`update boxes set stripe_config_rev = 'k0.old.14', stripe_config_pending_rev = null, stripe_config_pending_since = null where state <> 'deleted'`);
    deployments.clear();
  });

  it("refuses to write to a project that is protected, renamed, untagged or outside the boxes workspace", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const good = await makeBox("active");
    const renamed = await makeBox("active");
    const untagged = await makeBox("active");
    const foreign = await makeBox("active");
    projectInfo.set(`proj-${renamed.slug}`, { ...projectInfo.get(`proj-${renamed.slug}`)!, name: "agentdash" });
    projectInfo.set(`proj-${untagged.slug}`, { ...projectInfo.get(`proj-${untagged.slug}`)!, description: "someone else's project" });
    projectInfo.set(`proj-${foreign.slug}`, { ...projectInfo.get(`proj-${foreign.slug}`)!, workspaceId: "ws-personal" });
    const { fake, upserts } = fakeRailwayForVars();
    const r = await syncFleetBilling(
      { db, keys: KEYS, billing, store: fleetSecretStore(db, KEYS), client: fake.client({ log }), workspaceId: FAKE_WORKSPACE, log },
      { newKey: SHARED_KEY, apply: true, actor: "test" },
    );
    for (const bad of [renamed, untagged, foreign]) {
      expect(r.boxes.find((b) => b.slug === bad.slug)).toMatchObject({ outcome: "failed", error: expect.stringMatching(/refusing/) });
      expect(upserts.some((u) => u.serviceId === `svc-${bad.slug}`)).toBe(false);
    }
    expect(upserts.some((u) => u.serviceId === `svc-${good.slug}`)).toBe(true);
    // Without a workspace configured nothing is written at all.
    const none = await syncFleetBilling({ db, keys: KEYS, billing, store: fleetSecretStore(db, KEYS), client: fake.client({ log }), workspaceId: null, log }, { apply: true, actor: "test" });
    expect(none.updated).toBe(0);
    for (const bad of [renamed, untagged, foreign]) projectInfo.set(`proj-${bad.slug}`, { name: boxProjectName(bad.slug), description: boxProjectDescription(bad.id), workspaceId: FAKE_WORKSPACE });
  });

  it("refuses keys that are not restricted keys of the fleet's mode", () => {
    expect(checkBoxStripeKey("sk_test_abcdefghijkl", "test")).toMatch(/restricted/);
    expect(checkBoxStripeKey("rk_live_abcdefghijkl", "test")).toMatch(/test-mode/);
    expect(checkBoxStripeKey("rk_test_abcdefghijkl", "test")).toBeNull();
  });

  it("dry run by default: plans every live box, stores nothing and calls Railway never", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const box = await makeBox("active");
    const { fake, upserts } = fakeRailwayForVars();
    const store = fleetSecretStore(db, KEYS);
    const r = await syncFleetBilling({ db, keys: KEYS, billing, store, client: fake.client({ log }), workspaceId: FAKE_WORKSPACE, log }, { newKey: SHARED_KEY, apply: false, actor: "test" });
    expect(r).toMatchObject({ dryRun: true, key: "new", keyVersion: 1, targetRev: "k1.price_TestPro29.14" });
    expect(r.boxes.find((b) => b.slug === box.slug)).toMatchObject({ outcome: "would_update" });
    expect(upserts).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(await store.info(BOX_STRIPE_KEY)).toBeNull();
    expect(JSON.stringify(r)).not.toContain(SHARED_KEY);
  });

  it("apply stores the key once, upserts the four variables per box, and resumes after a partial failure", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const a = await makeBox("active");
    const b = await makeBox("suspended");
    const noService = await makeBox("active", { webService: false, withSecret: false });
    const needsSecret = await makeBox("awaiting_claim", { withSecret: false });
    const { fake, upserts, failFor } = fakeRailwayForVars();
    failFor.add(`svc-${b.slug}`);
    const store = fleetSecretStore(db, KEYS);
    const deps = { db, keys: KEYS, billing, store, client: fake.client({ log }), workspaceId: FAKE_WORKSPACE, log };

    const first = await syncFleetBilling(deps, { newKey: SHARED_KEY, apply: true, actor: "test" });
    expect(first.key).toBe("new");
    expect(first.failed).toBe(1);
    expect(first.boxes.find((x) => x.slug === b.slug)).toMatchObject({ outcome: "failed" });
    expect(first.boxes.find((x) => x.slug === noService.slug)).toBeUndefined();
    const forA = upserts.find((u) => u.serviceId === `svc-${a.slug}`)!;
    expect(forA.variables).toEqual({ STRIPE_SECRET_KEY: SHARED_KEY, STRIPE_WEBHOOK_SECRET: a.boxSecret, STRIPE_PRO_PRICE_ID: "price_TestPro29", STRIPE_TRIAL_DAYS: "14" });
    expect(forA.skipDeploys).toBe(true);
    // A box without a webhook secret gets one, stored encrypted first.
    const generated = upserts.find((u) => u.serviceId === `svc-${needsSecret.slug}`)!.variables.STRIPE_WEBHOOK_SECRET!;
    expect(generated).toMatch(/^whsec_/);
    expect(decryptField(KEYS, (await boxRow(needsSecret.id)).stripeWebhookSecretEnc!, WEBHOOK_SECRET_AAD)).toBe(generated);
    // Sent under skipDeploys: pending, NOT counted as running until a later deploy succeeds.
    expect(await boxRow(a.id)).toMatchObject({ stripeConfigRev: null, stripeConfigPendingRev: "k1.price_TestPro29.14" });
    expect((await boxRow(b.id)).stripeConfigPendingRev).toBeNull();
    expect(first.pendingDeploy).toBeGreaterThanOrEqual(2);
    // A failed deploy, or one from before the upsert, promotes nothing; a later successful one does.
    deployed(a.slug, "FAILED");
    deployments.set(`svc-${needsSecret.slug}`, { id: "dep-old", status: "SUCCESS", createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    await promoteDeployedBillingRevs(deps);
    expect((await boxRow(a.id)).stripeConfigRev).toBeNull();
    expect((await boxRow(needsSecret.id)).stripeConfigRev).toBeNull();
    deployed(a.slug);
    expect(await promoteDeployedBillingRevs(deps)).toBe(1);
    expect(await boxRow(a.id)).toMatchObject({ stripeConfigRev: "k1.price_TestPro29.14", stripeConfigPendingRev: null });
    const [stored] = await db.select().from(fleetSecrets).where(eq(fleetSecrets.name, BOX_STRIPE_KEY));
    expect(stored!.valueEnc).not.toContain(SHARED_KEY);
    const [audit] = await db.select().from(operatorAudit).where(eq(operatorAudit.kind, "fleet_secret_changed")).orderBy(sql`id desc`).limit(1);
    expect(JSON.stringify(audit!.detail)).not.toContain(SHARED_KEY);

    // Resume with the stored key: only the failed box is sent again.
    failFor.clear();
    upserts.length = 0;
    const resumed = await syncFleetBilling(deps, { apply: true, actor: "test" });
    expect(resumed).toMatchObject({ key: "not_given", updated: 1, failed: 0, remaining: 0 });
    expect(upserts.map((u) => u.serviceId)).toEqual([`svc-${b.slug}`]);

    // The same key again is a no-op; a new one bumps the version and goes to every box, redeploying when asked.
    upserts.length = 0;
    expect(await syncFleetBilling(deps, { newKey: SHARED_KEY, apply: true, actor: "test" })).toMatchObject({ key: "unchanged", updated: 0 });
    const rotated = await syncFleetBilling(deps, { newKey: SHARED_KEY_2, apply: true, redeploy: true, actor: "test" });
    expect(rotated).toMatchObject({ key: "new", keyVersion: 2, targetRev: "k2.price_TestPro29.14", failed: 0 });
    expect(upserts.length).toBeGreaterThanOrEqual(3);
    expect(upserts.every((u) => u.variables.STRIPE_SECRET_KEY === SHARED_KEY_2 && u.skipDeploys === false)).toBe(true);
    noSecretInLogs(SHARED_KEY, SHARED_KEY_2, a.boxSecret, generated);
  });

  it("demo and internal boxes are left out of the fleet sync (GH #861: they never bill)", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const demo = await makeBox("active");
    const internal = await makeBox("active");
    const canary = await makeBox("active");
    await db.update(boxes).set({ purpose: "demo" }).where(eq(boxes.id, demo.id));
    await db.update(boxes).set({ purpose: "internal" }).where(eq(boxes.id, internal.id));
    await db.update(boxes).set({ purpose: "canary" }).where(eq(boxes.id, canary.id));
    const { fake, upserts } = fakeRailwayForVars();
    const r = await syncFleetBilling(
      { db, keys: KEYS, billing, store: fleetSecretStore(db, KEYS), client: fake.client({ log }), workspaceId: FAKE_WORKSPACE, log },
      { newKey: SHARED_KEY, apply: true, actor: "test" },
    );
    for (const skipped of [demo, internal]) {
      expect(r.boxes.find((b) => b.slug === skipped.slug)).toBeUndefined();
      expect(upserts.some((u) => u.serviceId === `svc-${skipped.slug}`)).toBe(false);
    }
    expect(upserts.some((u) => u.serviceId === `svc-${canary.slug}`)).toBe(true);
    await db.update(boxes).set({ purpose: "customer" }).where(inArray(boxes.id, [demo.id, internal.id, canary.id]));
  });

  it("an apply that cannot finish does not store the new key (SC-8 review)", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const store = fleetSecretStore(db, KEYS);
    const { fake } = fakeRailwayForVars();
    await expect(
      syncFleetBilling(
        { db, keys: KEYS, billing: { ...billing, stripeProPriceId: null }, store, client: fake.client({ log }), workspaceId: FAKE_WORKSPACE, log },
        { newKey: SHARED_KEY, apply: true, actor: "t" },
      ),
    ).rejects.toThrow(/CLOUD_STRIPE_PRO_PRICE_ID/);
    const auditsBefore = (await db.select().from(operatorAudit).where(eq(operatorAudit.kind, "fleet_secret_changed"))).length;
    await expect(
      syncFleetBilling({ db, keys: KEYS, billing, store, client: null, workspaceId: FAKE_WORKSPACE, log }, { newKey: SHARED_KEY, apply: true, actor: "t" }),
    ).rejects.toThrow(/no Railway token/);
    expect(await store.info(BOX_STRIPE_KEY)).toBeNull();
    expect((await db.select().from(operatorAudit).where(eq(operatorAudit.kind, "fleet_secret_changed"))).length).toBe(auditsBefore);
  });

  it("refuses a wrong-mode key and a run with no key stored", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const deps = { db, keys: KEYS, billing, store: fleetSecretStore(db, KEYS), client: null, workspaceId: FAKE_WORKSPACE, log };
    await expect(syncFleetBilling(deps, { newKey: "rk_live_abcdefghijklmnop", apply: true, actor: "t" })).rejects.toThrow(BoxKeyRotationError);
    await expect(syncFleetBilling(deps, { apply: false, actor: "t" })).rejects.toThrow(/no shared box key/);
  });

  it("the admin CLI reads the key from stdin, dry-runs by default and applies with --apply", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const box = await makeBox("active");
    const { fake, upserts } = fakeRailwayForVars();
    const app = createApp({ db, config: appConfig({ CLOUD_RAILWAY_WORKSPACE_ID: FAKE_WORKSPACE }), log, stripe: { forwarder: forwarder(), railway: fake.client({ log }), endpoints: null } });
    const server = await listening(app);
    try {
      const port = (server.address() as AddressInfo).port;
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch, readStdin: async () => `${SHARED_KEY}\n` };
      // stripe status counts a box as behind until a deploy after the upsert succeeded.
      const env = { CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_CONTROL_URL: `http://127.0.0.1:${port}` };
      expect(await runAdmin(["stripe", "rotate-box-key"], env, io)).toBe(0);
      expect(JSON.parse(out.join("\n"))).toMatchObject({ dryRun: true, key: "new" });
      expect(err.join("\n")).toContain("dry run");
      expect(upserts).toHaveLength(0);
      out.length = 0;
      expect(await runAdmin(["stripe", "rotate-box-key", "--apply"], env, io)).toBe(0);
      expect(JSON.parse(out.join("\n"))).toMatchObject({ dryRun: false, key: "new", failed: 0 });
      expect(upserts.some((u) => u.serviceId === `svc-${box.slug}`)).toBe(true);
      expect(out.join("\n")).not.toContain(SHARED_KEY);
      out.length = 0;
      await runAdmin(["stripe", "status"], env, io);
      const before = JSON.parse(out.join("\n")) as { boxesBehind: number; boxesPendingDeploy: number };
      expect(before.boxesPendingDeploy).toBeGreaterThanOrEqual(1);
      expect(before.boxesBehind).toBeGreaterThanOrEqual(before.boxesPendingDeploy);
      deployed(box.slug);
      // GH #923: status is read-only now — the background pass is
      // what turns a succeeded deploy into a running rev.
      expect(await promoteDeployedBillingRevs({ db, client: fake.client({ log }), log })).toBeGreaterThanOrEqual(1);
      out.length = 0;
      await runAdmin(["stripe", "status"], env, io);
      const after = JSON.parse(out.join("\n")) as { boxesBehind: number; boxesPendingDeploy: number };
      expect(after.boxesBehind).toBe(before.boxesBehind - 1);
      expect(after.boxesPendingDeploy).toBe(before.boxesPendingDeploy - 1);
      expect(await runAdmin(["stripe", "rotate-box-key", "--bogus"], env, io)).toBe(64);
      expect(await runAdmin(["stripe", "rotate-box-key"], env, { ...io, readStdin: async () => "  " })).toBe(2);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ---- the account endpoint ----------------------------------------------

describe("stripe endpoint ensure", () => {
  it("creates the one endpoint with the box API version and stores its secret; an existing one is left alone", async () => {
    await db.execute(sql`delete from fleet_secrets where name = ${STRIPE_ENDPOINT_SECRET}`);
    const created: unknown[] = [];
    const endpoints: Array<{ id: string; url: string }> = [];
    const client: StripeEndpointsClient = {
      async list() {
        return endpoints.map((e) => ({ ...e, status: "enabled", enabledEvents: [...FORWARDED_EVENTS], apiVersion: "2026-04-22.dahlia" }));
      },
      async create(input) {
        created.push(input);
        endpoints.push({ id: "we_1", url: input.url });
        return { id: "we_1", secret: "whsec_from_stripe_create_123" };
      },
    };
    const store = fleetSecretStore(db, KEYS);
    const url = "https://www.agentdash.cloud/api/cloud/stripe/webhook";
    expect(await ensureStripeEndpoint({ client, store, url, apply: false, actor: "t" })).toMatchObject({ outcome: "would_create" });
    expect(created).toHaveLength(0);
    expect(await ensureStripeEndpoint({ client, store, url, apply: true, actor: "t" })).toMatchObject({ outcome: "created", apiVersion: "2026-04-22.dahlia" });
    expect((await store.reveal(STRIPE_ENDPOINT_SECRET))!.value).toBe("whsec_from_stripe_create_123");
    expect(await ensureStripeEndpoint({ client, store, url, apply: true, actor: "t" })).toMatchObject({ outcome: "exists", secretStored: true });
    expect(created).toHaveLength(1);

    // The forwarder now verifies with the stored secret, with no env secret at all.
    const box = await makeBox("active");
    const fwd = forwarder({ billing: { ...billing, stripeWebhookSecrets: [] } });
    const s = stripeSigned(subscriptionEvent({ slug: box.slug }), "whsec_from_stripe_create_123");
    expect((await fwd.receive(s.raw, s.header)).status).toBe(200);
  });
});

// ---- Resend keys --------------------------------------------------------

function fakeResend() {
  const keys = new Map<string, { name: string; domainId: string; token: string }>();
  let seq = 0;
  const calls: string[] = [];
  const client: ResendKeysClient = {
    async create(input) {
      seq += 1;
      const id = `key-0000-${seq.toString().padStart(4, "0")}`;
      const token = `re_box_${randomBytes(12).toString("hex")}`;
      keys.set(id, { name: input.name, domainId: input.domainId, token });
      calls.push(`create:${input.name}`);
      return { id, token };
    },
    async list() {
      calls.push("list");
      return [...keys.entries()].map(([id, k]) => ({ id, name: k.name }));
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      return keys.delete(id) ? "deleted" : "not_found";
    },
  };
  return { client, keys, calls };
}

describe("per-box Resend keys", () => {
  it("makes a sending-only key per box (revoking orphans by name first), and revokes it at delete", async () => {
    const box = await makeBox("provisioning");
    const { client, keys } = fakeResend();
    // An orphan from a crash before its id was recorded.
    await client.create({ name: boxResendKeyName(box.slug), domainId: "dom-orphan" });
    const row = await boxRow(box.id);
    const token = await provisionBoxResendKey(db, client, row, "dom-mail-agentdash");
    expect(token).toMatch(/^re_box_/);
    expect([...keys.values()]).toEqual([expect.objectContaining({ name: boxResendKeyName(box.slug), domainId: "dom-mail-agentdash", token })]);
    const recorded = (await boxRow(box.id)).resendKeyId!;
    expect(keys.has(recorded)).toBe(true);
    const events = await db.select().from(boxEvents).where(eq(boxEvents.boxId, box.id));
    expect(JSON.stringify(events)).not.toContain(token);

    expect(await revokeBoxResendKey(db, client, await boxRow(box.id), "test")).toBe(1);
    expect(keys.size).toBe(0);
    expect((await boxRow(box.id)).resendKeyId).toBeNull();
  });

  it("the provisioner extras add Stripe and Resend variables, keep an existing Resend key, and record the rev as pending after commit", async () => {
    await db.execute(sql`delete from fleet_secrets`);
    const store = fleetSecretStore(db, KEYS);
    await store.set(BOX_STRIPE_KEY, SHARED_KEY, "test");
    const resendCfg = { ...billing, resendAdminKey: null, resendBoxDomainId: "dom-mail-agentdash" };
    const { client } = fakeResend();
    const extras = billingAndMailExtras({ keys: KEYS, billing: resendCfg, store, resend: client });
    const box = await makeBox("provisioning", { withSecret: false });
    const ctx = { db, box: await boxRow(box.id), log, signal: new AbortController().signal };

    const fresh = await extras.prepare({ ...ctx, names: new Set() });
    expect(Object.keys(fresh.vars).sort()).toEqual(["AGENTDASH_EMAIL_FROM", "RESEND_API_KEY", "STRIPE_PRO_PRICE_ID", "STRIPE_SECRET_KEY", "STRIPE_TRIAL_DAYS", "STRIPE_WEBHOOK_SECRET"]);
    expect(fresh.vars.STRIPE_SECRET_KEY).toBe(SHARED_KEY);
    expect((await boxRow(box.id)).stripeConfigRev).toBeNull();
    await fresh.commit();
    expect((await boxRow(box.id)).stripeConfigPendingRev).toBe("k1.price_TestPro29.14");

    const again = await extras.prepare({ ...ctx, box: await boxRow(box.id), names: new Set(["RESEND_API_KEY"]) });
    expect(again.vars.RESEND_API_KEY).toBeUndefined();
    expect(again.vars.STRIPE_WEBHOOK_SECRET).toBe(fresh.vars.STRIPE_WEBHOOK_SECRET);

    // Without the fleet config, nothing Stripe is set and the skip is recorded.
    const bare = billingAndMailExtras({ keys: KEYS, billing: { ...billing, stripeProPriceId: null }, store, resend: null });
    const other = await makeBox("provisioning");
    const r = await bare.prepare({ ...ctx, box: await boxRow(other.id), names: new Set() });
    expect(r.vars).toEqual({});
    await r.commit();
    const [ev] = await db.select().from(boxEvents).where(eq(boxEvents.boxId, other.id));
    expect(ev).toMatchObject({ kind: "billing_mail_skipped" });
  });

  it("the delete job revokes the box's Resend key after the project delete", async () => {
    const { client, keys } = fakeResend();
    const box = await makeBox("provisioning");
    await provisionBoxResendKey(db, client, await boxRow(box.id), "dom-x");
    expect(keys.size).toBe(1);
    const handler = deleteHandler({ client: new FakeRailway().client(), workspaceId: FAKE_WORKSPACE, resend: client });
    const step = handler.steps.find((s) => s.name === "revoke_resend_key")!;
    expect(handler.steps.map((s) => s.name)).toEqual(["delete_project", "revoke_resend_key", "mark_deleted"]);
    const ctx = { db, job: { id: "j", boxId: box.id } as JobRow, log, signal: new AbortController().signal, box: () => boxRow(box.id) } as JobContext;
    await step.run(ctx);
    expect(keys.size).toBe(0);
    await step.run(ctx); // idempotent
  });
});

