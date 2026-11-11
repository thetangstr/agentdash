import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, fredRegistrations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { countBillableAgents } from "../services/guide-capacity.js";
import { buildRequireTierDeps } from "../middleware/build-tier-deps.js";
import { exceededFreeTierCapacityAction, withCompanyTierCapacityLock } from "../services/tier-policy.js";

describe("protected Fred guide inclusion on migrated PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const priorStripe = process.env.STRIPE_SECRET_KEY;
  const priorDisabled = process.env.AGENTDASH_BILLING_DISABLED;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("fred-cap-");
    db = createDb(temporary.connectionString);
    process.env.STRIPE_SECRET_KEY = "sk_test_fred_capacity_fixture";
    delete process.env.AGENTDASH_BILLING_DISABLED;
  });
  afterAll(async () => {
    await temporary?.cleanup();
    if (priorStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorStripe;
    if (priorDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED; else process.env.AGENTDASH_BILLING_DISABLED = priorDisabled;
  });
  async function company(name: string) {
    return (await db.insert(companies).values({ name, issuePrefix: randomUUID().slice(0, 8), planTier: "free" }).returning())[0];
  }
  async function agent(companyId: string, name: string, extra: Partial<typeof agents.$inferInsert> = {}) {
    return (await db.insert(agents).values({ companyId, name, ...extra }).returning())[0];
  }
  it("keeps a custom Fred and forged metadata billable, excluding only the registered principal", async () => {
    const c = await company("Guide inclusion fixture");
    const guide = await agent(c.id, "Fred", { status: "paused" });
    await agent(c.id, "Fred", { metadata: { builtIn: true, systemAgent: "fred", includedGuide: true } });
    await agent(c.id, "Old worker", { status: "terminated" });
    expect(await countBillableAgents(db, c.id)).toBe(2);
    await db.insert(fredRegistrations).values({ companyId: c.id, agentId: guide.id, ownerUserId: "fixture-owner", mandateVersion: "fred-v1" });
    expect(await countBillableAgents(db, c.id)).toBe(1);
    expect(await buildRequireTierDeps(db).counts.agents(c.id)).toBe(1);
  });
  it("cannot exempt a foreign company's agent even with a malformed protected row", async () => {
    const a = await company("Guide scope A"), b = await company("Guide scope B");
    const foreign = await agent(b.id, "Fred");
    await db.insert(fredRegistrations).values({ companyId: a.id, agentId: foreign.id, ownerUserId: "fixture-owner", mandateVersion: "fred-v1" });
    expect(await countBillableAgents(db, b.id)).toBe(1);
    expect(await countBillableAgents(db, a.id)).toBe(0);
  });
  it("preserves the free worker cap while the registered guide remains included", async () => {
    const c = await company("Guide plus worker");
    const guide = await agent(c.id, "Fred");
    await db.insert(fredRegistrations).values({ companyId: c.id, agentId: guide.id, ownerUserId: "fixture-owner", mandateVersion: "fred-v1" });
    const before = await withCompanyTierCapacityLock(db, c.id, tx => exceededFreeTierCapacityAction(buildRequireTierDeps(tx), c.id, { agents: 1 }));
    expect(before).toBeNull();
    await agent(c.id, "Chief of Staff", { role: "chief_of_staff" });
    const after = await withCompanyTierCapacityLock(db, c.id, tx => exceededFreeTierCapacityAction(buildRequireTierDeps(tx), c.id, { agents: 1 }));
    expect(after).toBe("hire");
    expect(await countBillableAgents(db, c.id)).toBe(1);
  });
  it("rejects duplicate company and cross-registration principal identities", async () => {
    const a = await company("Guide unique A"), b = await company("Guide unique B");
    const guide = await agent(a.id, "Fred");
    await db.insert(fredRegistrations).values({ companyId: a.id, agentId: guide.id, ownerUserId: "fixture-owner", mandateVersion: "fred-v1" });
    await expect(db.insert(fredRegistrations).values({ companyId: a.id, ownerUserId: "other", mandateVersion: "fred-v1" })).rejects.toThrow();
    await expect(db.insert(fredRegistrations).values({ companyId: b.id, agentId: guide.id, ownerUserId: "other", mandateVersion: "fred-v1" })).rejects.toThrow();
    await expect(db.insert(fredRegistrations).values({ companyId: b.id, state: "approved" as never, ownerUserId: "other", mandateVersion: "fred-v1" })).rejects.toThrow();
  });
});
