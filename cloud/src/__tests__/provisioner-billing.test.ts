// SC-8 (GH #769): a provisioned box gets the shared Stripe key, its own
// webhook secret (kept encrypted by the control plane), the price, 14 trial
// days and its own sending-only Resend key, in the variables step's single
// upsert, before the first deploy. Fake Railway, fake Resend, embedded Postgres.
import { randomBytes, randomUUID } from "node:crypto";
import sodium from "libsodium-wrappers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptField, parseKeyring } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { boxes, jobs } from "../db/schema.js";
import type { ResendKeysClient } from "../email/resend-keys.js";
import { createBoxForOperator } from "../jobs/ops.js";
import type { JobContext, JobRow } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { billingAndMailExtras } from "../railway/box-extras.js";
import { provisionHandler } from "../railway/provisioner.js";
import { settingsService } from "../settings.js";
import { WEBHOOK_SECRET_AAD } from "../stripe/box-billing.js";
import { loadBillingConfig } from "../stripe/config.js";
import { BOX_STRIPE_KEY, fleetSecretStore } from "../stripe/fleet-secrets.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_WORKSPACE } from "./fake-railway.js";
import { FakeRailwayBoxes } from "./fake-railway-boxes.js";

const caps = vi.hoisted(() => ({ claimTrackingReady: true }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

const TAG = "v2026.930.0";
const KEYS = parseKeyring("66".repeat(32));
const SHARED_KEY = `rk_test_${randomBytes(24).toString("hex")}`;
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  await sodium.ready;
  const s = settingsService(db);
  await s.set("provisioning_enabled", true, "test");
  await s.set("daily_cap", 1000, "test");
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

describe("provisioning with Stripe and Resend (SC-8)", () => {
  it("puts the billing and mail variables in the first upsert and keeps the box's webhook secret encrypted", async () => {
    const billing = loadBillingConfig({
      CLOUD_STRIPE_PRO_PRICE_ID: "price_TestPro29",
      CLOUD_RESEND_ADMIN_API_KEY: "re_admin_fake_key_for_tests",
      CLOUD_RESEND_BOX_DOMAIN_ID: "dom-mail-agentdash-cloud",
    });
    const store = fleetSecretStore(db, KEYS);
    await store.set(BOX_STRIPE_KEY, SHARED_KEY, "test");
    const resendKeys: Array<{ id: string; name: string; domainId: string }> = [];
    const resend: ResendKeysClient = {
      async create(input) {
        const id = `key-${randomUUID()}`;
        resendKeys.push({ id, ...input });
        return { id, token: `re_box_${randomBytes(10).toString("hex")}` };
      },
      async list() {
        return resendKeys.map(({ id, name }) => ({ id, name }));
      },
      async remove() {
        return "deleted";
      },
    };
    const fake = new FakeRailwayBoxes({ ghcrTags: [TAG] });
    const escrow = sodium.crypto_box_keypair();
    const handler = provisionHandler({
      client: fake.client({ log }),
      workspaceId: FAKE_WORKSPACE,
      dataKeys: KEYS,
      escrowPublicKey: escrow.publicKey,
      edgeDomain: "agentdash.cloud",
      imageRepo: "ghcr.io/thetangstr/agentdash",
      sourceRepo: "thetangstr/agentdash",
      edgeLive: false,
      fetch: fake.http,
      pollMs: 5,
      autoDeployGraceMs: 0,
      boxExtras: billingAndMailExtras({ keys: KEYS, billing, store, resend }),
    });

    const slug = `bill${Date.now() % 100000}`;
    const created = await createBoxForOperator(db, { slug, email: `founder-${slug}@example.test`, releaseTag: TAG }, "test");
    await db.update(jobs).set({ state: "dead" }).where(eq(jobs.boxId, created.boxId));
    const boxRow = async () => (await db.select().from(boxes).where(eq(boxes.id, created.boxId)))[0]!;
    const job = { id: randomUUID(), boxId: created.boxId, kind: "provision", payload: null, startedAt: new Date() } as JobRow;
    const ctx: JobContext = { db, job, log, signal: new AbortController().signal, box: boxRow };
    for (const name of ["reserve", "project", "postgres", "web", "variables"]) await handler.steps.find((s) => s.name === name)!.run(ctx);

    const box = await boxRow();
    const upserts = fake.calls
      .filter((c) => c.op === "variableCollectionUpsert" && (c.variables.i as { serviceId: string }).serviceId === box.webServiceId)
      .map((c) => (c.variables.i as { variables: Record<string, string> }).variables);
    expect(upserts).toHaveLength(1);
    const v = upserts[0]!;
    expect(v).toMatchObject({
      STRIPE_SECRET_KEY: SHARED_KEY,
      STRIPE_PRO_PRICE_ID: "price_TestPro29",
      STRIPE_TRIAL_DAYS: "14",
      AGENTDASH_FREE_AGENT_CAP: "2",
      AGENTDASH_BOX_SLUG: slug,
      AGENTDASH_EMAIL_FROM: "AgentDash <no-reply@mail.agentdash.cloud>",
    });
    expect(v.STRIPE_WEBHOOK_SECRET).toMatch(/^whsec_/);
    expect(v.RESEND_API_KEY).toMatch(/^re_box_/);
    expect(decryptField(KEYS, box.stripeWebhookSecretEnc!, WEBHOOK_SECRET_AAD)).toBe(v.STRIPE_WEBHOOK_SECRET);
    expect(box.stripeConfigPendingRev).toBe("k1.price_TestPro29.14");
    expect(box.stripeConfigRev).toBeNull();
    expect(resendKeys).toEqual([expect.objectContaining({ id: box.resendKeyId, name: `agentdash-box-${slug}`, domainId: "dom-mail-agentdash-cloud" })]);

    // A re-run of the step (a resumed job) keeps the box's webhook secret and its Resend key.
    await handler.steps.find((s) => s.name === "variables")!.run(ctx);
    const again = fake.calls.filter((c) => c.op === "variableCollectionUpsert" && (c.variables.i as { serviceId: string }).serviceId === box.webServiceId).at(-1)!;
    const v2 = (again.variables.i as { variables: Record<string, string> }).variables;
    expect(v2.STRIPE_WEBHOOK_SECRET).toBe(v.STRIPE_WEBHOOK_SECRET);
    expect(v2.RESEND_API_KEY).toBeUndefined();
    expect(resendKeys).toHaveLength(1);

    const all = logLines.join("\n");
    for (const secret of [SHARED_KEY, v.STRIPE_WEBHOOK_SECRET!, v.RESEND_API_KEY!]) expect(all).not.toContain(secret);
    const events = await db.execute(sql`select detail::text as d from box_events where box_id = ${created.boxId}`);
    for (const secret of [SHARED_KEY, v.STRIPE_WEBHOOK_SECRET!, v.RESEND_API_KEY!]) expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("a demo or internal box gets AGENTDASH_BILLING_DISABLED and Resend, but no Stripe config", async () => {
    const billing = loadBillingConfig({
      CLOUD_STRIPE_PRO_PRICE_ID: "price_TestPro29",
      CLOUD_RESEND_ADMIN_API_KEY: "re_admin_fake_key_for_tests",
      CLOUD_RESEND_BOX_DOMAIN_ID: "dom-mail-agentdash-cloud",
    });
    const store = fleetSecretStore(db, KEYS);
    await store.set(BOX_STRIPE_KEY, SHARED_KEY, "test");
    const resend: ResendKeysClient = {
      async create(input) {
        return { id: `key-${randomUUID()}`, token: `re_box_${randomBytes(10).toString("hex")}`, ...input };
      },
      async list() {
        return [];
      },
      async remove() {
        return "deleted";
      },
    };
    const fake = new FakeRailwayBoxes({ ghcrTags: [TAG] });
    const handler = provisionHandler({
      client: fake.client({ log }),
      workspaceId: FAKE_WORKSPACE,
      dataKeys: KEYS,
      escrowPublicKey: sodium.crypto_box_keypair().publicKey,
      edgeDomain: "agentdash.cloud",
      imageRepo: "ghcr.io/thetangstr/agentdash",
      sourceRepo: "thetangstr/agentdash",
      edgeLive: false,
      fetch: fake.http,
      pollMs: 5,
      autoDeployGraceMs: 0,
      boxExtras: billingAndMailExtras({ keys: KEYS, billing, store, resend }),
    });

    for (const purpose of ["demo", "internal"] as const) {
      const slug = `${purpose}${Date.now() % 100000}`;
      const created = await createBoxForOperator(db, { slug, email: `f-${slug}@example.test`, releaseTag: TAG, purpose }, "test");
      await db.update(jobs).set({ state: "dead" }).where(eq(jobs.boxId, created.boxId));
      const boxRow = async () => (await db.select().from(boxes).where(eq(boxes.id, created.boxId)))[0]!;
      const job = { id: randomUUID(), boxId: created.boxId, kind: "provision", payload: null, startedAt: new Date() } as JobRow;
      const ctx: JobContext = { db, job, log, signal: new AbortController().signal, box: boxRow };
      for (const name of ["reserve", "project", "postgres", "web", "variables"]) await handler.steps.find((s) => s.name === name)!.run(ctx);

      const box = await boxRow();
      const upserts = fake.calls
        .filter((c) => c.op === "variableCollectionUpsert" && (c.variables.i as { serviceId: string }).serviceId === box.webServiceId)
        .map((c) => (c.variables.i as { variables: Record<string, string> }).variables);
      const v = upserts.at(-1)!;
      expect(v.AGENTDASH_BILLING_DISABLED).toBe("true");
      for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID", "STRIPE_TRIAL_DAYS"]) expect(v[key]).toBeUndefined();
      expect(v.RESEND_API_KEY).toMatch(/^re_box_/);
      expect(box.stripeWebhookSecretEnc).toBeNull();
      expect(box.stripeConfigPendingRev).toBeNull();
      const skipped = await db.execute(
        sql`select detail::text as d from box_events where box_id = ${created.boxId} and kind = 'billing_mail_skipped'`,
      );
      expect(JSON.stringify(skipped)).toContain("billing");
    }
  });
});
