import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { costRoutes } from "../routes/costs.js";
import { approvalRoutes } from "../routes/approvals.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (GH #902): budget surfaces obey the A5 restricted-project rule,
 * against the REAL routers and a REAL database — same shape as
 * project-visibility.test.ts.
 *
 * A project-scoped budget policy, its incidents and its
 * `budget_override_required` approval all carry the project's name, id and
 * spend. To a board member who is neither an admin nor on the project, all
 * of them are nonexistent: absent from lists and counts, 404 on detail and on
 * writes. A member on the access list, the creator and an admin see them.
 */
describeEmbeddedPostgres("GH #902: budget surfaces follow the restricted-project rule", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const OPEN_POLICY = randomUUID();
  const SECRET_POLICY = randomUUID();
  const OPEN_APPROVAL = randomUUID();
  const SECRET_APPROVAL = randomUUID();
  const OPEN_INCIDENT = randomUUID();
  const SECRET_INCIDENT = randomUUID();
  const SECRET_NAME = "Sam's restricted project";

  const windowStart = new Date("2026-01-01T00:00:00.000Z");
  const windowEnd = new Date("2100-01-01T00:00:00.000Z");

  const overridePayload = (projectId: string, policyId: string, name: string) => ({
    scopeType: "project",
    scopeId: projectId,
    scopeName: name,
    metric: "billed_cents",
    windowKind: "lifetime",
    thresholdType: "hard",
    budgetAmount: 1_000,
    observedAmount: 1_500,
    warnPercent: 80,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    policyId,
    guidance: "Raise the budget and resume the scope, or keep the scope paused.",
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Budget Visibility Co" });
    for (const [userId, role] of [
      ["admin-user", "admin"],
      ["sam", "member"],
      ["listed-user", "member"],
      ["member-user", "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    // #1057: these fixtures isolate project visibility AFTER spend authority.
    // Plain members without this explicit grant are covered by dashboard-cost-visibility.
    await db.insert(principalPermissionGrants).values(["sam", "listed-user", "member-user"].map(principalId => ({
      companyId: COMPANY, principalType: "user", principalId, permissionKey: "agents:create",
    })));
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open project", createdByUserId: "admin-user" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: SECRET_NAME,
        createdByUserId: "sam",
        visibility: "restricted",
        // Paused by its budget, so pausedProjectCount has something to hide.
        pausedAt: new Date(),
        pauseReason: "budget",
      },
    ]);
    await db.insert(projectAccess).values({
      projectId: SECRET_PROJECT,
      principalType: "user",
      principalId: "listed-user",
      grantedByUserId: "sam",
    });
    await db.insert(budgetPolicies).values([
      { companyId: COMPANY, scopeType: "company", scopeId: COMPANY, windowKind: "calendar_month_utc", amount: 10_000 },
      { id: OPEN_POLICY, companyId: COMPANY, scopeType: "project", scopeId: OPEN_PROJECT, windowKind: "lifetime", amount: 1_000 },
      { id: SECRET_POLICY, companyId: COMPANY, scopeType: "project", scopeId: SECRET_PROJECT, windowKind: "lifetime", amount: 1_000 },
    ]);
    // Same shape budgets.ts writes: no requester, the scope in the payload.
    await db.insert(approvals).values([
      {
        id: OPEN_APPROVAL,
        companyId: COMPANY,
        type: "budget_override_required",
        requestedByUserId: null,
        requestedByAgentId: null,
        status: "pending",
        payload: overridePayload(OPEN_PROJECT, OPEN_POLICY, "Open project"),
      },
      {
        id: SECRET_APPROVAL,
        companyId: COMPANY,
        type: "budget_override_required",
        requestedByUserId: null,
        requestedByAgentId: null,
        status: "pending",
        payload: overridePayload(SECRET_PROJECT, SECRET_POLICY, SECRET_NAME),
      },
    ]);
    await db.insert(budgetIncidents).values([
      {
        id: OPEN_INCIDENT,
        companyId: COMPANY,
        policyId: OPEN_POLICY,
        scopeType: "project",
        scopeId: OPEN_PROJECT,
        metric: "billed_cents",
        windowKind: "lifetime",
        windowStart,
        windowEnd,
        thresholdType: "hard",
        amountLimit: 1_000,
        amountObserved: 1_500,
        status: "open",
        approvalId: OPEN_APPROVAL,
      },
      {
        id: SECRET_INCIDENT,
        companyId: COMPANY,
        policyId: SECRET_POLICY,
        scopeType: "project",
        scopeId: SECRET_PROJECT,
        metric: "billed_cents",
        windowKind: "lifetime",
        windowStart,
        windowEnd,
        thresholdType: "hard",
        amountLimit: 1_000,
        amountObserved: 1_500,
        status: "open",
        approvalId: SECRET_APPROVAL,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", costRoutes(db));
    app.use("/api", approvalRoutes(db));
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
  });
  const OUTSIDER = asUser("member-user", "member");
  const LISTED = asUser("listed-user", "member");
  const CREATOR = asUser("sam", "member");
  const ADMIN = asUser("admin-user", "admin");

  describe("GET /companies/:id/budgets/overview", () => {
    it("hides the restricted policy, its incident and its counts from a non-admin member off the list", async () => {
      const res = await request(appAs(OUTSIDER)).get(`/api/companies/${COMPANY}/budgets/overview`);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_NAME);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_PROJECT);
      expect(res.body.policies.map((p: { scopeId: string }) => p.scopeId).sort()).toEqual(
        [COMPANY, OPEN_PROJECT].sort(),
      );
      // The open project's incident stays visible.
      expect(res.body.activeIncidents.map((i: { id: string }) => i.id)).toEqual([OPEN_INCIDENT]);
      expect(res.body.pausedProjectCount).toBe(0);
      expect(res.body.pendingApprovalCount).toBe(1);
    });

    it.each([
      ["a non-admin member on the access list", LISTED],
      ["the creator", CREATOR],
      ["an admin", ADMIN],
    ])("shows everything to %s", async (_label, actor) => {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/budgets/overview`);
      expect(res.status).toBe(200);
      expect(res.body.policies.map((p: { scopeId: string }) => p.scopeId)).toContain(SECRET_PROJECT);
      expect(res.body.policies.find((p: { scopeId: string }) => p.scopeId === SECRET_PROJECT)?.scopeName).toBe(SECRET_NAME);
      expect(res.body.activeIncidents.map((i: { id: string }) => i.id).sort()).toEqual(
        [OPEN_INCIDENT, SECRET_INCIDENT].sort(),
      );
      expect(res.body.pausedProjectCount).toBe(1);
      expect(res.body.pendingApprovalCount).toBe(2);
    });
  });

  describe("budget_override_required approvals", () => {
    it("list: the restricted project's override vanishes for an off-list member; the open one stays", async () => {
      const ids = async (actor: Record<string, unknown>) =>
        (await request(appAs(actor)).get(`/api/companies/${COMPANY}/approvals`)).body.map((a: { id: string }) => a.id);

      const outsider = await ids(OUTSIDER);
      expect(outsider).toContain(OPEN_APPROVAL);
      expect(outsider).not.toContain(SECRET_APPROVAL);

      for (const actor of [LISTED, CREATOR, ADMIN]) {
        expect(await ids(actor)).toEqual(expect.arrayContaining([OPEN_APPROVAL, SECRET_APPROVAL]));
      }
    });

    it("detail and its sub-routes: 404 for an off-list member — never 403", async () => {
      const outsider = appAs(OUTSIDER);
      for (const path of [
        `/api/approvals/${SECRET_APPROVAL}`,
        `/api/approvals/${SECRET_APPROVAL}/comments`,
        `/api/approvals/${SECRET_APPROVAL}/issues`,
      ]) {
        const res = await request(outsider).get(path);
        expect(res.status, path).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(SECRET_NAME);
      }
      const comment = await request(outsider)
        .post(`/api/approvals/${SECRET_APPROVAL}/comments`)
        .send({ body: "probe" });
      expect(comment.status).toBe(404);
      const reject = await request(outsider)
        .post(`/api/approvals/${SECRET_APPROVAL}/reject`)
        .send({ decisionNote: "probe" });
      expect(reject.status).toBe(404);

      expect((await request(outsider).get(`/api/approvals/${OPEN_APPROVAL}`)).status).toBe(200);

      const listed = await request(appAs(LISTED)).get(`/api/approvals/${SECRET_APPROVAL}`);
      expect(listed.status).toBe(200);
      expect(listed.body.payload.scopeName).toBe(SECRET_NAME);
      expect((await request(appAs(ADMIN)).get(`/api/approvals/${SECRET_APPROVAL}`)).status).toBe(200);
    });
  });

  describe("GET /companies/:id/dashboard", () => {
    it("budget and approval counts leave out the hidden project for an off-list member only", async () => {
      const outsider = await request(appAs(OUTSIDER)).get(`/api/companies/${COMPANY}/dashboard`);
      expect(outsider.status).toBe(200);
      expect(outsider.body.pendingApprovals).toBe(1);
      expect(outsider.body.budgets).toEqual({
        activeIncidents: 1,
        pendingApprovals: 1,
        pausedAgents: 0,
        pausedProjects: 0,
      });

      for (const actor of [LISTED, ADMIN]) {
        const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/dashboard`);
        expect(res.status).toBe(200);
        expect(res.body.pendingApprovals).toBe(2);
        expect(res.body.budgets).toEqual({
          activeIncidents: 2,
          pendingApprovals: 2,
          pausedAgents: 0,
          pausedProjects: 1,
        });
      }
    });
  });

  describe("write routes", () => {
    // Runs last: an upsert at or under the observed spend resolves the open
    // incidents and resumes the project, which the read assertions above need.
    it("POST /budget-incidents/:id/resolve on a hidden project's incident is 404 for an off-list member", async () => {
      const res = await request(appAs(OUTSIDER))
        .post(`/api/companies/${COMPANY}/budget-incidents/${SECRET_INCIDENT}/resolve`)
        .send({ action: "keep_paused" });
      expect(res.status).toBe(404);
      const incident = await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, SECRET_INCIDENT));
      expect(incident[0]?.status).toBe("open");
    });

    it("POST /budgets/policies on a hidden project is 404 for an off-list member, allowed for a listed one", async () => {
      const denied = await request(appAs(OUTSIDER))
        .post(`/api/companies/${COMPANY}/budgets/policies`)
        .send({ scopeType: "project", scopeId: SECRET_PROJECT, windowKind: "lifetime", amount: 999_999 });
      expect(denied.status).toBe(404);
      const unchanged = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, SECRET_POLICY));
      expect(unchanged[0]?.amount).toBe(1_000);

      const allowed = await request(appAs(LISTED))
        .post(`/api/companies/${COMPANY}/budgets/policies`)
        .send({ scopeType: "project", scopeId: SECRET_PROJECT, windowKind: "lifetime", amount: 1_000 });
      expect(allowed.status).toBe(200);
      expect(allowed.body.scopeId).toBe(SECRET_PROJECT);
    });
  });
});
