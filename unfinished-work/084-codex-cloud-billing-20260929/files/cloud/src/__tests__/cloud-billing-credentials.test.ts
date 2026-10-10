// AgentDash: SC-8 key lifecycle is exercised only against local provider fakes.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxes } from "../db/schema.js";
import { billingVariables, revokeBoxMail } from "../billing/credentials.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

const config = loadConfig({ DATABASE_URL: "postgres://unused", CLOUD_DATA_KEY: "44".repeat(32), CLOUD_ADMIN_TOKEN: "0123456789abcdef".repeat(4), CLOUD_STRIPE_CONTROL_KEY: "rk_test_controloffline", CLOUD_STRIPE_BOX_KEY: "rk_test_boxesoffline", CLOUD_STRIPE_PRO_PRICE_ID: "price_offline", CLOUD_RESEND_MANAGEMENT_KEY: "re_managementoffline", CLOUD_RESEND_DOMAIN_ID: "domain_offline" });
let pg: TestDatabase, db: CloudDb, close: () => Promise<void>, accountId: string, n = 0;
beforeAll(async () => { pg = await startTestDatabase(); await migrateCloudDb(pg.url); ({ db, close } = createCloudDb(pg.url)); const [a] = await db.insert(accounts).values({ email: "keys@example.test" }).returning(); accountId = a.id; });
afterAll(async () => { await close?.(); await pg?.stop(); });
async function newBox() { return (await db.insert(boxes).values({ accountId, slug: `keys-${++n}` }).returning())[0]; }
function fake(options: { domain?: string; verified?: boolean; createFail?: boolean } = {}) {
  const keys: Array<{ id: string; name: string }> = []; const creations: any[] = []; const deleted: string[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith("/domains/")) return new Response(JSON.stringify({ id: "domain_offline", name: options.domain ?? "mail.agentdash.cloud", status: options.verified === false ? "pending" : "verified" }));
    if (init?.method === "DELETE") { const id = u.pathname.split("/").at(-1)!; deleted.push(id); const i = keys.findIndex((k) => k.id === id); if (i >= 0) keys.splice(i, 1); return new Response(JSON.stringify({ deleted: true })); }
    if (init?.method === "POST") {
      if (options.createFail) throw new Error("re_shouldneverleak");
      const body = JSON.parse(String(init.body)); creations.push(body); const key = { id: `key_${creations.length}`, name: body.name }; keys.push(key); return new Response(JSON.stringify({ ...key, token: `re_tokenoffline${creations.length}` }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: keys, has_more: false }));
  }) as unknown as typeof fetch;
  return { f, keys, creations, deleted };
}
describe("provisioned billing and mail credentials", () => {
  it("stores authenticated ciphertext before variable writes and reuses credentials on retry", async () => {
    const box = await newBox(); const provider = fake();
    const first = await billingVariables(db, box.id, config, { fetch: provider.f });
    const second = await billingVariables(db, box.id, config, { fetch: provider.f });
    expect(second).toEqual(first); expect(provider.creations).toHaveLength(1);
    expect(first).toMatchObject({ STRIPE_SECRET_KEY: "rk_test_boxesoffline", STRIPE_PRO_PRICE_ID: "price_offline", STRIPE_TRIAL_DAYS: "14", AGENTDASH_FREE_AGENT_CAP: "2", RESEND_API_KEY: "re_tokenoffline1", AGENTDASH_EMAIL_FROM: "AgentDash <no-reply@mail.agentdash.cloud>" });
    expect(first.STRIPE_WEBHOOK_SECRET).toMatch(/^whsec_/);
    expect(provider.creations[0]).toEqual({ name: `agentdash-box-${box.id}`, permission: "sending_access", domain_id: "domain_offline" });
    const [stored] = await db.select().from(boxes).where(eq(boxes.id, box.id));
    expect(stored.resendApiKeyEnc).not.toContain("re_tokenoffline1"); expect(stored.stripeWebhookSecretEnc).not.toContain(first.STRIPE_WEBHOOK_SECRET);
  });
  it("revokes an orphan created before a crash and creates one recoverable replacement", async () => {
    const box = await newBox(); const provider = fake(); provider.keys.push({ id: "key_orphan", name: `agentdash-box-${box.id}` }, { id: "key_other", name: "unrelated" });
    await billingVariables(db, box.id, config, { fetch: provider.f });
    expect(provider.deleted).toEqual(["key_orphan"]); expect(provider.keys.some((k) => k.id === "key_other")).toBe(true);
  });
  it("recovers an actual create-before-persistence failure without leaving duplicate keys", async () => {
    const box = await newBox(); const provider = fake();
    await db.execute(sql`create function offline_fail_key_save() returns trigger language plpgsql as $$ begin raise exception 'offline crash simulation'; end $$`);
    await db.execute(sql`create trigger offline_fail_key_save before update of resend_api_key_id on boxes for each row execute function offline_fail_key_save()`);
    try { await expect(billingVariables(db, box.id, config, { fetch: provider.f })).rejects.toThrow(); }
    finally { await db.execute(sql`drop trigger offline_fail_key_save on boxes`); await db.execute(sql`drop function offline_fail_key_save()`); }
    expect(provider.keys).toHaveLength(1);
    await billingVariables(db, box.id, config, { fetch: provider.f });
    expect(provider.deleted).toEqual(["key_1"]); expect(provider.keys).toHaveLength(1); expect(provider.creations).toHaveLength(2);
  });
  it("finds and revokes a stable-name orphan beyond the first provider page", async () => {
    const box = await newBox(); const provider = fake(); provider.keys.push({ id: "key_orphan", name: `agentdash-box-${box.id}` });
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === "/api-keys" && !init?.method?.match(/POST|DELETE/) && !u.searchParams.has("after")) return new Response(JSON.stringify({ data: Array.from({ length: 100 }, (_, i) => ({ id: `page${i}`, name: "unrelated" })), has_more: true }));
      return provider.f(url, init);
    });
    await billingVariables(db, box.id, config, { fetch: f });
    expect(provider.deleted).toEqual(["key_orphan"]); expect(f.mock.calls.some((call) => String(call[0]).includes("after=page99"))).toBe(true);
  });
  it("rejects unverified/wrong domains before minting a key", async () => {
    const box = await newBox(); const provider = fake({ domain: "other.example" });
    await expect(billingVariables(db, box.id, config, { fetch: provider.f })).rejects.toThrow("Resend domain"); expect(provider.creations).toHaveLength(0);
  });
  it("serializes concurrent key requests and never exposes provider error text", async () => {
    const box = await newBox(); const provider = fake();
    const results = await Promise.all([billingVariables(db, box.id, config, { fetch: provider.f }), billingVariables(db, box.id, config, { fetch: provider.f })]);
    expect(results[0]).toEqual(results[1]); expect(provider.creations).toHaveLength(1);
    const other = await newBox(); const failed = fake({ createFail: true });
    await expect(billingVariables(db, other.id, config, { fetch: failed.f })).rejects.toThrow("Resend request failed");
    try { await billingVariables(db, other.id, config, { fetch: failed.f }); } catch (e) { expect(String(e)).not.toContain("re_shouldneverleak"); }
  });
  it("revokes exactly the box key and clears reusable ciphertext; retries do nothing", async () => {
    const box = await newBox(); const provider = fake();
    await billingVariables(db, box.id, config, { fetch: provider.f });
    await revokeBoxMail(db, box.id, config, { fetch: provider.f }); await revokeBoxMail(db, box.id, config, { fetch: provider.f });
    expect(provider.deleted).toEqual(["key_1"]);
    const [stored] = await db.select().from(boxes).where(eq(boxes.id, box.id)); expect(stored.resendApiKeyId).toBeNull(); expect(stored.resendApiKeyEnc).toBeNull();
  });
  it("retains revocation material after provider failure and treats a retry's 404 as already revoked", async () => {
    const box = await newBox(); const provider = fake(); await billingVariables(db, box.id, config, { fetch: provider.f });
    const failed = (async (url: string | URL | Request, init?: RequestInit) => init?.method === "DELETE" ? new Response("re_shouldneverleak", { status: 503 }) : provider.f(url, init)) as typeof fetch;
    await expect(revokeBoxMail(db, box.id, config, { fetch: failed })).rejects.toThrow("Resend request failed");
    expect((await db.select().from(boxes).where(eq(boxes.id, box.id)))[0].resendApiKeyId).toBe("key_1");
    const already = (async (url: string | URL | Request, init?: RequestInit) => init?.method === "DELETE" ? new Response("", { status: 404 }) : provider.f(url, init)) as typeof fetch;
    await revokeBoxMail(db, box.id, config, { fetch: already });
    expect((await db.select().from(boxes).where(eq(boxes.id, box.id)))[0].resendApiKeyEnc).toBeNull();
  });
});
