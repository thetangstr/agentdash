// AgentDash: SC-8 composes existing provision/delete guards and private fleet operations.
import { randomUUID } from "node:crypto";
import sodium from "libsodium-wrappers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { decryptField } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, cloudBilling, jobs } from "../db/schema.js";
import { configureStripeEndpoint, rotateBoxKey } from "../billing/admin.js";
import { billingVariables } from "../billing/credentials.js";
import { deleteHandler } from "../jobs/cleanup.js";
import { type JobContext, type JobRow } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { provisionHandler } from "../railway/provisioner.js";
import { Secret } from "../secret.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FakeRailwayBoxes } from "./fake-railway-boxes.js";
import { FAKE_WORKSPACE } from "./fake-railway.js";

const config = loadConfig({ DATABASE_URL: "postgres://unused", CLOUD_DATA_KEY: "44".repeat(32), CLOUD_ADMIN_TOKEN: "0123456789abcdef".repeat(4), CLOUD_STRIPE_CONTROL_KEY: "rk_test_controloffline", CLOUD_STRIPE_BOX_KEY: "rk_test_boxesoffline", CLOUD_STRIPE_PRO_PRICE_ID: "price_offline", CLOUD_RESEND_MANAGEMENT_KEY: "re_managementoffline", CLOUD_RESEND_DOMAIN_ID: "domain_offline" });
const logLines: string[] = []; const log = createLogger({ write: (l) => logLines.push(l) });
const TAG = "v2026.930.0";
let pg: TestDatabase, db: CloudDb, close: () => Promise<void>, accountId: string, escrow: Uint8Array, n = 0;
beforeAll(async () => { pg = await startTestDatabase(); await migrateCloudDb(pg.url); ({ db, close } = createCloudDb(pg.url)); const [a] = await db.insert(accounts).values({ email: "integration@example.test" }).returning(); accountId = a.id; await sodium.ready; escrow = sodium.crypto_box_keypair().publicKey; });
afterAll(async () => { await close?.(); await pg?.stop(); });
async function boxRow(id: string) { return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]; }
async function newBox() { const [b] = await db.insert(boxes).values({ accountId, slug: `integration-${++n}`, releaseTag: TAG }).returning(); await db.update(boxes).set({ state: "provisioning" }).where(eq(boxes.id, b.id)); return boxRow(b.id); }
function context(id: string, kind: JobRow["kind"] = "provision"): JobContext { return { db, job: { id: randomUUID(), boxId: id, kind, payload: { releaseTag: TAG }, state: "running", step: null, attempt: 1, runAfter: new Date(), lockedUntil: null, lockedBy: null, maxAttempts: 5, startedAt: new Date(), heartbeatAt: null, finishedAt: null, lastError: null, createdAt: new Date(), updatedAt: new Date() }, log, signal: new AbortController().signal, box: () => boxRow(id) }; }
function setup() {
  const fake = new FakeRailwayBoxes({ ghcrTags: [TAG] });
  const keys: Array<{ id: string; name: string }> = []; const created: any[] = [], revoked: string[] = [];
  let revokeFails = false;
  const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.resend.com") return fake.http(url, init);
    if (u.pathname.startsWith("/domains/")) return new Response(JSON.stringify({ id: "domain_offline", name: "mail.agentdash.cloud", status: "verified" }));
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); created.push(body); const k = { id: `mail_${created.length}`, name: body.name }; keys.push(k); return new Response(JSON.stringify({ ...k, token: `re_boxoffline${created.length}` })); }
    if (init?.method === "DELETE") {
      if (revokeFails) return new Response("re_secretmustnotpersist", { status: 503 });
      const id = u.pathname.split("/").at(-1)!; revoked.push(id); const i = keys.findIndex((k) => k.id === id); if (i >= 0) keys.splice(i, 1); return new Response('{"deleted":true}');
    }
    return new Response(JSON.stringify({ data: keys, has_more: false }));
  }) as typeof fetch;
  const client = fake.client({ log });
  const handler = provisionHandler({ client, workspaceId: FAKE_WORKSPACE, dataKeys: config.dataKeys, escrowPublicKey: escrow, edgeDomain: "agentdash.cloud", imageRepo: "ghcr.io/thetangstr/agentdash", sourceRepo: "thetangstr/agentdash", edgeLive: false, billingConfig: config, fetch: http, pollMs: 5, autoDeployGraceMs: 0 });
  async function steps(id: string, names: string[]) { for (const name of names) await handler.steps.find((s) => s.name === name)!.run(context(id)); }
  return { fake, client, http, created, revoked, handler, steps, setRevokeFails: (v: boolean) => { revokeFails = v; } };
}

describe("SC-8 provisioning and cleanup integration", () => {
  it("writes billing/mail variables and reuses keys after a failed Railway upsert", async () => {
    const b = await newBox(), s = setup(); await s.steps(b.id, ["reserve", "project", "postgres", "web"]);
    s.fake.failNext(/variableCollectionUpsert/, { status: 503 });
    await expect(s.steps(b.id, ["variables"])).rejects.toThrow();
    const saved = await boxRow(b.id); expect(saved.resendApiKeyEnc).toBeTruthy(); expect(saved.stripeWebhookSecretEnc).toBeTruthy();
    await s.steps(b.id, ["variables"]); const finished = await boxRow(b.id); const variables = s.fake.svc(finished.webServiceId).variables;
    expect(s.created).toHaveLength(1); expect(variables).toMatchObject({ STRIPE_SECRET_KEY: "rk_test_boxesoffline", STRIPE_TRIAL_DAYS: "14", AGENTDASH_FREE_AGENT_CAP: "2", AGENTDASH_EMAIL_FROM: "AgentDash <no-reply@mail.agentdash.cloud>", RESEND_API_KEY: "re_boxoffline1" });
    expect(variables.STRIPE_WEBHOOK_SECRET).toBe(decryptField(config.dataKeys, saved.stripeWebhookSecretEnc!, "boxes.stripe_webhook_secret_enc"));
    expect(variables.AGENTDASH_EDGE_SECRET).toBeUndefined();
    const persisted = JSON.stringify({ events: await db.select().from(boxEvents), jobs: await db.select().from(jobs) });
    expect(persisted).not.toContain(variables.STRIPE_WEBHOOK_SECRET); expect(persisted).not.toContain("re_boxoffline1"); expect(logLines.join()).not.toContain("re_boxoffline1");
  });
  it("refuses incomplete billing config before creating any Railway project", async () => {
    const b = await newBox(), s = setup(); const handler = provisionHandler({ client: s.client, workspaceId: FAKE_WORKSPACE, dataKeys: config.dataKeys, escrowPublicKey: escrow, edgeDomain: "agentdash.cloud", imageRepo: "ghcr.io/thetangstr/agentdash", sourceRepo: "thetangstr/agentdash", edgeLive: false, billingConfig: { ...config, billing: undefined } });
    await expect(handler.steps[0].run(context(b.id))).rejects.toThrow("SC-8"); expect(s.fake.calls).toEqual([]);
  });
  it("does not mint provider keys after a failed variable read", async () => {
    const b = await newBox(), s = setup(); await s.steps(b.id, ["reserve", "project", "postgres", "web"]);
    s.fake.failVariablesRead = "names";
    await expect(s.steps(b.id, ["variables"])).rejects.toThrow(); expect(s.created).toEqual([]);
  });
  it("keeps cleanup pending until Resend revocation succeeds, including old jobs resuming at mark_deleted", async () => {
    const b = await newBox(), s = setup(); await billingVariables(db, b.id, config, { fetch: s.http });
    await db.update(boxes).set({ state: "failed" }).where(eq(boxes.id, b.id)); await db.update(boxes).set({ state: "cleanup" }).where(eq(boxes.id, b.id));
    const handler = deleteHandler({ client: s.client, workspaceId: FAKE_WORKSPACE, billingConfig: config, fetch: s.http });
    const ctx = context(b.id, "delete"); await handler.steps[0].run(ctx);
    s.setRevokeFails(true); await expect(handler.steps.find((step) => step.name === "mark_deleted")!.run(ctx)).rejects.toThrow("Resend request failed");
    expect((await boxRow(b.id)).state).toBe("cleanup"); expect((await boxRow(b.id)).resendApiKeyId).toBeTruthy();
    s.setRevokeFails(false); await handler.steps.find((step) => step.name === "mark_deleted")!.run(ctx);
    expect((await boxRow(b.id)).state).toBe("deleted"); expect(s.revoked).toEqual(["mail_1"]);
  });
  it("retains the existing claimed-box deletion guard before any key revocation", async () => {
    const b = await newBox(), s = setup(); await db.update(boxes).set({ state: "failed" }).where(eq(boxes.id, b.id)); await db.update(boxes).set({ state: "cleanup", claimedAt: new Date() }).where(eq(boxes.id, b.id));
    const handler = deleteHandler({ client: s.client, workspaceId: FAKE_WORKSPACE, billingConfig: config, fetch: s.http });
    await expect(handler.steps[0].run(context(b.id, "delete"))).rejects.toThrow("claimed"); expect(s.revoked).toEqual([]);
  });
});

describe("SC-8 endpoint and fleet administration", () => {
  it("registers one endpoint with a stable idempotency key, encrypts its secret and returns no key material", async () => {
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === "POST" ? new Response(JSON.stringify({ id: "we_offline", url: "https://www.agentdash.cloud/api/cloud/stripe/webhook", secret: "whsec_endpointoffline" })) : new Response('{"data":[],"has_more":false}'));
    const result = await configureStripeEndpoint(db, config, { fetch: f }); expect(JSON.stringify(result)).not.toContain("whsec_");
    await configureStripeEndpoint(db, config, { fetch: f }); expect(f).toHaveBeenCalledTimes(2);
    const post = f.mock.calls.find((call) => call[1]?.method === "POST")!; expect((post[1]?.headers as Record<string, string>)["idempotency-key"]).toMatch(/^agentdash-cloud-webhook-/);
    expect(String(post[1]?.body)).toContain("customer.subscription.updated");
    expect(String(post[1]?.body)).toContain("customer.subscription.trial_will_end");
    const [row] = await db.select().from(cloudBilling); expect(decryptField(config.dataKeys, row.stripeEndpointSecretEnc!, "cloud_billing.stripe_endpoint_secret_enc")).toBe("whsec_endpointoffline");
  });
  it("drops duplicate endpoint creation after a crash rather than minting a second endpoint", async () => {
    await db.update(cloudBilling).set({ stripeEndpointId: null, stripeEndpointSecretEnc: null }).where(eq(cloudBilling.id, "cloud"));
    const f = vi.fn(async () => new Response('{"data":[{"id":"we_exists","url":"https://www.agentdash.cloud/api/cloud/stripe/webhook"}],"has_more":false}'));
    await expect(configureStripeEndpoint(db, config, { fetch: f })).rejects.toThrow("saved CLOUD_STRIPE_WEBHOOK_SECRET"); expect(f).toHaveBeenCalledOnce();
  });
  it("rotates only tagged known projects, persists an encrypted future key and never deploys", async () => {
    const b = await newBox(), s = setup(); await s.steps(b.id, ["reserve", "project", "postgres", "web"]);
    const beforeRotation = s.fake.calls.length;
    const result = await rotateBoxKey(db, config, s.client, FAKE_WORKSPACE, new Secret("rk_test_newboxesoffline"));
    expect(result.updated).toContain(b.slug); expect(s.fake.calls.slice(beforeRotation).map((c) => c.op)).not.toContain("serviceInstanceDeployV2");
    const stored = await boxRow(b.id); expect(s.fake.svc(stored.webServiceId).variables.STRIPE_SECRET_KEY).toBe("rk_test_newboxesoffline");
    const future = await billingVariables(db, b.id, config, { fetch: s.http }); expect(future.STRIPE_SECRET_KEY).toBe("rk_test_newboxesoffline");
    const project = s.fake.projects.get(stored.projectId!)!; project.description = "wrong-tag";
    const refused = await rotateBoxKey(db, config, s.client, FAKE_WORKSPACE, new Secret("rk_test_otherboxesoffline"));
    expect(refused.failed).toContainEqual({ slug: b.slug, reason: "guard_or_variable_update_failed" }); expect(s.fake.svc(stored.webServiceId).variables.STRIPE_SECRET_KEY).toBe("rk_test_newboxesoffline");
    expect(JSON.stringify({ result, refused })).not.toContain("rk_test_");
    expect(logLines.join()).not.toContain("rk_test_newboxesoffline");
  });
});
