// The company budget is a company setting: owner/admin only, against a real
// database. PATCH /companies/:id/budgets and a company-scope
// POST /budgets/policies refuse a plain member; an owner or admin may set it,
// and the PATCH answers under the same spend read rule as the company routes.
// Agent and project scopes keep their own rules (tested elsewhere).
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { costRoutes } from "../routes/costs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REFUSAL = "Only owners and admins can change the company budget.";

describeEmbeddedPostgres("company budget writes need an owner or admin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-budget-admin-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `Budget ${randomUUID()}`,
        issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}`,
        budgetMonthlyCents: 10_000,
        spentMonthlyCents: 4_321,
      })
      .returning()
      .then((rows) => rows[0]!);
    const adminId = `admin-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: adminId, status: "active", membershipRole: "admin" },
      { companyId: company.id, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
    ]);
    const board = (userId: string, role: string) => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, status: "active", membershipRole: role }],
    });
    return { company, admin: board(adminId, "admin"), member: board(memberId, "member") };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", costRoutes(db));
    a.use(errorHandler);
    return a;
  }

  async function companyPolicies(companyId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "company")));
  }

  it("refuses a member setting the company budget, writes nothing and returns no spend", async () => {
    const { company, member } = await seed();
    const res = await request(app(member)).patch(`/api/companies/${company.id}/budgets`).send({ budgetMonthlyCents: 99_999 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
    expect(JSON.stringify(res.body)).not.toContain("4321");
    const [row] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(row!.budgetMonthlyCents).toBe(10_000);
    expect(await companyPolicies(company.id)).toHaveLength(0);
  });

  it("lets an admin set it, answering under the spend read rule (admins read spend)", async () => {
    const { company, admin } = await seed();
    const res = await request(app(admin)).patch(`/api/companies/${company.id}/budgets`).send({ budgetMonthlyCents: 20_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.budgetMonthlyCents).toBe(20_000);
    // Spend is recomputed from cost events; what matters is that an admin is
    // shown it, where a reader without spend access gets null.
    expect(typeof res.body.spentMonthlyCents).toBe("number");
    expect((await companyPolicies(company.id)).map((row) => row.amount)).toEqual([20_000]);
  });

  it("refuses a member a company-scope budget policy; an admin may set one", async () => {
    const { company, member, admin } = await seed();
    const body = { scopeType: "company", scopeId: company.id, amount: 30_000, windowKind: "calendar_month_utc" };
    const refused = await request(app(member)).post(`/api/companies/${company.id}/budgets/policies`).send(body);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe(REFUSAL);
    expect(await companyPolicies(company.id)).toHaveLength(0);

    const allowed = await request(app(admin)).post(`/api/companies/${company.id}/budgets/policies`).send(body);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect((await companyPolicies(company.id)).map((row) => row.amount)).toEqual([30_000]);
  });

  // A company-scope budget incident resolved with `raise_budget_and_resume`
  // writes companies.budgetMonthlyCents and resumes a paused company: the same
  // owner/admin decision. A soft incident has no linked approval, and a hard
  // one in a default-profile company admits any member through the approval
  // rule, so the route checks it directly.
  async function companyIncident(companyId: string, thresholdType: "soft" | "hard") {
    const [policy] = await db
      .insert(budgetPolicies)
      .values({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents", windowKind: "calendar_month_utc", amount: 10_000 })
      .returning();
    let approvalId: string | null = null;
    if (thresholdType === "hard") {
      await db.update(companies).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() }).where(eq(companies.id, companyId));
      const [approval] = await db
        .insert(approvals)
        .values({ companyId, type: "budget_override_required", status: "pending", payload: { scopeType: "company", scopeId: companyId } })
        .returning();
      approvalId = approval!.id;
    }
    const now = new Date();
    const [incident] = await db
      .insert(budgetIncidents)
      .values({
        companyId,
        policyId: policy!.id,
        scopeType: "company",
        scopeId: companyId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: new Date(now.getFullYear(), now.getMonth(), 1),
        windowEnd: new Date(now.getFullYear(), now.getMonth() + 1, 1),
        thresholdType,
        amountLimit: 10_000,
        amountObserved: thresholdType === "hard" ? 10_000 : 8_000,
        approvalId,
      })
      .returning();
    return incident!;
  }

  for (const thresholdType of ["soft", "hard"] as const) {
    it(`refuses a member raising the budget on a ${thresholdType} company incident; an admin may`, async () => {
      const { company, member, admin } = await seed();
      const incident = await companyIncident(company.id, thresholdType);
      const body = { action: "raise_budget_and_resume", amount: 50_000 };

      const refused = await request(app(member)).post(`/api/companies/${company.id}/budget-incidents/${incident.id}/resolve`).send(body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toBe(REFUSAL);
      const [unchanged] = await db.select().from(companies).where(eq(companies.id, company.id));
      expect(unchanged!.budgetMonthlyCents).toBe(10_000);
      expect(unchanged!.status).toBe(thresholdType === "hard" ? "paused" : "active");

      const allowed = await request(app(admin)).post(`/api/companies/${company.id}/budget-incidents/${incident.id}/resolve`).send(body);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      const [raised] = await db.select().from(companies).where(eq(companies.id, company.id));
      expect(raised!.budgetMonthlyCents).toBe(50_000);
      expect(raised!.status).toBe("active");
    });
  }
});
