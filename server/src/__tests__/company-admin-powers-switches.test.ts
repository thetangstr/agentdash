// AgentDash admin powers: the company switches (migration 0159) against a
// real database. The switches ride the company settings PATCH, which is
// owner/admin only; members read them. Same harness as
// company-admin-real-db-routes.test.ts.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentCeilingTemplates, authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { boardAuthService } from "../services/board-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Admin powers: the company switches, real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";

  beforeAll(async () => {
    home = await mkdtemp(join(process.env.TMPDIR ?? process.cwd(), "company-admin-powers-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("AGENTDASH_BILLING_DISABLED", "true");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-admin-powers-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function user(label: string) {
    const id = `${label}-${randomUUID()}`;
    await db.insert(authUsers).values({
      id,
      name: label,
      email: `${id}@acme-${randomUUID().slice(0, 8)}.example`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  /** The actor the board-key middleware would build for this user, from the database. */
  async function actorFor(userId: string) {
    const access = await boardAuthService(db).resolveBoardAccess(userId);
    return {
      type: "board",
      userId,
      source: "board_key",
      companyIds: access.companyIds,
      memberships: access.memberships,
      isInstanceAdmin: access.isInstanceAdmin,
    };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api/companies", companyRoutes(db, undefined, { allowMultiCompany: true, allowMultiTenantPerDomain: true }));
    a.use(errorHandler);
    return a;
  }

  async function seed() {
    const founderId = await user("founder");
    const created = await request(app(await actorFor(founderId)))
      .post("/api/companies")
      .send({ name: `Real ${randomUUID().slice(0, 8)}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const companyId = created.body.id as string;

    const memberId = await user("member");
    const pendingId = await user("pending");
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
      // A pending admin: the role alone must not pass.
      { companyId, principalType: "user", principalId: pendingId, status: "pending", membershipRole: "admin" },
    ]);
    return { companyId, founderId, memberId, pendingId };
  }

  it("every company starts with each power off and 50 records per Claude batch, readable by members", async () => {
    const { companyId, memberId } = await seed();
    const read = await request(app(await actorFor(memberId))).get(`/api/companies/${companyId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      adminDirectiveReadEnabled: false,
      adminTranscriptReadEnabled: false,
      assistantAdminBatchesEnabled: false,
      assistantBatchMaxRecords: 50,
      defaultCeilingTemplateId: null,
    });
  });

  it("owners and admins change the switches through the settings PATCH, and the change is logged", async () => {
    const { companyId, founderId } = await seed();
    const founder = app(await actorFor(founderId));
    const res = await request(founder).patch(`/api/companies/${companyId}`).send({
      adminDirectiveReadEnabled: true,
      adminTranscriptReadEnabled: true,
      assistantAdminBatchesEnabled: true,
      assistantBatchMaxRecords: 120,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      adminDirectiveReadEnabled: true,
      adminTranscriptReadEnabled: true,
      assistantAdminBatchesEnabled: true,
      assistantBatchMaxRecords: 120,
    });
    const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "company.updated")));
    expect(rows.some((row) => (row.details as Record<string, unknown>)?.assistantBatchMaxRecords === 120)).toBe(true);
  });

  it("refuses a member and a pending admin, and changes nothing", async () => {
    const { companyId, memberId, pendingId } = await seed();
    for (const userId of [memberId, pendingId]) {
      const res = await request(app(await actorFor(userId))).patch(`/api/companies/${companyId}`).send({ assistantAdminBatchesEnabled: true });
      expect(res.status).toBe(403);
      // A pending membership is refused earlier, by company access itself.
      if (userId === memberId) expect(res.body.error).toBe("Only owners and admins can change company settings.");
    }
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.assistantAdminBatchesEnabled).toBe(false);
  });

  it("keeps the record limit between 1 and 200 and takes one of the company's own ceiling templates", async () => {
    const { companyId, founderId } = await seed();
    const founder = app(await actorFor(founderId));
    for (const value of [0, 201, 1.5]) {
      const res = await request(founder).patch(`/api/companies/${companyId}`).send({ assistantBatchMaxRecords: value });
      expect(res.status, String(value)).toBe(400);
    }
    // The ceiling for new agents: one of this company's templates, or none.
    const [template] = await db.insert(agentCeilingTemplates).values({
      companyId, name: "Tight", ceiling: { permissions: [], monthlyBudgetCents: 0, destructiveActions: "blocked", dataScopes: [], providers: [], minimumApproval: "steward" } as never,
    }).returning();
    const res = await request(founder).patch(`/api/companies/${companyId}`).send({ defaultCeilingTemplateId: template!.id });
    expect(res.status).toBe(200);
    expect(res.body.defaultCeilingTemplateId).toBe(template!.id);
    const cleared = await request(founder).patch(`/api/companies/${companyId}`).send({ defaultCeilingTemplateId: null });
    expect(cleared.body.defaultCeilingTemplateId).toBeNull();
  });
});
