// Feature-flag write authority, against a real database.
//
// Flags switch on security-relevant behavior (document access, the co-worker
// bridge, the DoD guard), so writing one is an owner/admin decision. Real
// routes, real authz, real activity log — including the authz.refused rows the
// refusal reporter writes.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  featureFlags,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { setAuthzRefusalDb } from "../routes/authz.js";
import { featureFlagRoutes } from "../routes/feature-flags.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FLAG = "coworker_bridge_enabled";

describeEmbeddedPostgres("feature-flag routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-feature-flag-routes-");
    db = createDb(tempDb.connectionString);
    setAuthzRefusalDb(db);
  }, 30_000);

  afterEach(async () => {
    // Refusal rows are written fire-and-forget; let them land before cleanup.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.delete(activityLog);
    await db.delete(featureFlags);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    setAuthzRefusalDb(null);
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `FF ${randomUUID()}`, issuePrefix: `F${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const ownerId = `owner-${randomUUID()}`;
    const adminId = `admin-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    const instanceAdminId = `instance-admin-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: adminId, status: "active", membershipRole: "admin" },
      { companyId: company.id, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
      // The instance admin is only a plain member here: the pass must come
      // from the instance role, not from the company role.
      { companyId: company.id, principalType: "user", principalId: instanceAdminId, status: "active", membershipRole: "member" },
    ]);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Worker", role: "engineer", status: "idle", adapterType: "hermes_local" })
      .returning()
      .then((rows) => rows[0]!);
    const board = (userId: string, role: string, isInstanceAdmin = false) => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, status: "active", membershipRole: role }],
    });
    return {
      company,
      agent,
      owner: board(ownerId, "owner"),
      admin: board(adminId, "admin"),
      member: board(memberId, "member"),
      instanceAdmin: board(instanceAdminId, "member", true),
      agentActor: { type: "agent", agentId: agent.id, companyId: company.id, source: "agent_key" },
    };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", featureFlagRoutes(db));
    a.use(errorHandler);
    return a;
  }

  const put = (actor: Record<string, unknown>, companyId: string, body: unknown = { enabled: true }) =>
    request(app(actor)).put(`/api/companies/${companyId}/feature-flags/${FLAG}`).send(body as object);

  async function flagRows(companyId: string) {
    return db
      .select()
      .from(featureFlags)
      .where(and(eq(featureFlags.companyId, companyId), eq(featureFlags.flagKey, FLAG)));
  }

  async function activity(action: string) {
    return db.select().from(activityLog).where(eq(activityLog.action, action));
  }

  async function refusalReasons() {
    const rows = await activity("authz.refused");
    return rows.map((row) => (row.details as Record<string, unknown> | null)?.reasonCode);
  }

  it("refuses an agent of the company, writes nothing, and records the refusal", async () => {
    const { company, agentActor } = await seed();
    const res = await put(agentActor, company.id);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Agents cannot change feature flags/);
    expect(await flagRows(company.id)).toHaveLength(0);
    expect(await activity("feature_flag.updated")).toHaveLength(0);
    await vi.waitFor(async () => expect(await refusalReasons()).toEqual(["AGENT_FEATURE_FLAG_FORBIDDEN"]));
  });

  it("refuses a plain member, writes nothing, and records the refusal", async () => {
    const { company, member } = await seed();
    const res = await put(member, company.id);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Only a workspace owner or admin can change feature flags/);
    expect(await flagRows(company.id)).toHaveLength(0);
    expect(await activity("feature_flag.updated")).toHaveLength(0);
    await vi.waitFor(async () => expect(await refusalReasons()).toEqual(["COMPANY_ADMINISTRATOR_REQUIRED"]));
  });

  it("refuses the agent before looking at the body", async () => {
    const { company, agentActor } = await seed();
    const res = await put(agentActor, company.id, { enabled: "yes" });
    expect(res.status).toBe(403);
  });

  it("lets a company owner and a company admin change a flag", async () => {
    const { company, owner, admin } = await seed();
    const on = await put(owner, company.id, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ companyId: company.id, flagKey: FLAG, enabled: true });
    const off = await put(admin, company.id, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false });
    expect((await flagRows(company.id)).map((row) => row.enabled)).toEqual([false]);
  });

  it("lets an instance admin change a flag without a company admin role", async () => {
    const { company, instanceAdmin } = await seed();
    const res = await put(instanceAdmin, company.id);
    expect(res.status).toBe(200);
    expect((await flagRows(company.id)).map((row) => row.enabled)).toEqual([true]);
  });

  it("records each change with the actor, the flag, and the old and new value", async () => {
    const { company, owner, admin } = await seed();
    expect((await put(owner, company.id, { enabled: true })).status).toBe(200);
    expect((await put(admin, company.id, { enabled: false })).status).toBe(200);
    const rows = (await activity("feature_flag.updated")).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      companyId: company.id,
      actorType: "user",
      actorId: owner.userId,
      entityType: "company",
      entityId: company.id,
      details: { flagKey: FLAG, enabled: true, previousEnabled: null },
    });
    expect(rows[1]).toMatchObject({
      actorId: admin.userId,
      details: { flagKey: FLAG, enabled: false, previousEnabled: true },
    });
  });

  it("still validates the body for an admin", async () => {
    const { company, owner } = await seed();
    const res = await put(owner, company.id, { enabled: "yes" });
    expect(res.status).toBe(400);
    expect(await flagRows(company.id)).toHaveLength(0);
    expect(await activity("feature_flag.updated")).toHaveLength(0);
  });

  it("leaves reads open to members and agents of the company", async () => {
    const { company, owner, member, agentActor } = await seed();
    expect((await put(owner, company.id)).status).toBe(200);
    for (const actor of [member, agentActor]) {
      const list = await request(app(actor)).get(`/api/companies/${company.id}/feature-flags`);
      expect(list.status).toBe(200);
      expect(list.body).toEqual([expect.objectContaining({ flagKey: FLAG, enabled: true })]);
      const one = await request(app(actor)).get(`/api/companies/${company.id}/feature-flags/${FLAG}`);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ flagKey: FLAG, enabled: true });
      const missing = await request(app(actor)).get(`/api/companies/${company.id}/feature-flags/not_a_flag`);
      expect(missing.status).toBe(404);
    }
  });

  it("still refuses an agent of another company before the role check", async () => {
    const { company } = await seed();
    const other = await seed();
    const res = await put(other.agentActor, company.id);
    expect(res.status).toBe(403);
    expect(await flagRows(company.id)).toHaveLength(0);
    await vi.waitFor(async () => expect(await refusalReasons()).toEqual(["AGENT_CROSS_COMPANY"]));
  });
});
