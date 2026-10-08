import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentStewardships,
  agents,
  approvals,
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
import { activityRoutes } from "../routes/activity.js";
import { assistantRoutes } from "../routes/assistant.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { logActivity } from "../services/activity-log.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (GH #933): `budget.*` activity rows carry the scope's id, name and
 * spend in details — for a project scope they follow the restricted-project
 * rule on every surface that reads them: the activity feed, the assistant
 * digest, the pending-decisions list and the sidebar badge count. The live
 * `activity.logged` event is covered in live-events-project-visibility.test.ts.
 *
 * A member off the project's access list sees none of it; a listed member,
 * the creator, an admin, and an agent on the list do. Company- and
 * agent-scoped budget rows stay company-visible. Real routers, real database.
 */
describeEmbeddedPostgres("GH #933: budget activity follows the restricted-project rule", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const COMPANY_POLICY = randomUUID();
  const OPEN_POLICY = randomUUID();
  const SECRET_POLICY = randomUUID();
  const AGENT_POLICY = randomUUID();
  const OPEN_APPROVAL = randomUUID();
  const SECRET_APPROVAL = randomUUID();
  const SECRET_INCIDENT = randomUUID();
  const MALFORMED_POLICY = randomUUID();
  const SECRET_NAME = "Sam's restricted project";
  const MALFORMED_SCOPE_NAME = "Unresolved project scope";

  // One stewarded agent per viewer: the digest and pending-decisions list
  // cover "the agents this person answers for", so each viewer needs one.
  const BOT_ADMIN = randomUUID();
  const BOT_SAM = randomUUID();
  const BOT_LISTED = randomUUID();
  const BOT_OUTSIDER = randomUUID();
  // Agent callers, for the feeds that are not board-only.
  const AGENT_ON_LIST = randomUUID();
  const AGENT_OFF_LIST = randomUUID();

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

  const budgetActivity = (
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ) =>
    logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action,
      entityType,
      entityId,
      details,
    });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-activity-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Budget Activity Co" });
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
      },
    ]);
    await db.insert(agents).values([
      { id: BOT_ADMIN, companyId: COMPANY, name: "Admin's bot", role: "general" },
      { id: BOT_SAM, companyId: COMPANY, name: "Sam's bot", role: "general" },
      { id: BOT_LISTED, companyId: COMPANY, name: "Listed bot", role: "general" },
      { id: BOT_OUTSIDER, companyId: COMPANY, name: "Outsider bot", role: "general" },
      { id: AGENT_ON_LIST, companyId: COMPANY, name: "Listed agent", role: "general" },
      { id: AGENT_OFF_LIST, companyId: COMPANY, name: "Outside agent", role: "general" },
    ]);
    await db.insert(agentStewardships).values([
      { companyId: COMPANY, agentId: BOT_ADMIN, userId: "admin-user" },
      { companyId: COMPANY, agentId: BOT_SAM, userId: "sam" },
      { companyId: COMPANY, agentId: BOT_LISTED, userId: "listed-user" },
      { companyId: COMPANY, agentId: BOT_OUTSIDER, userId: "member-user" },
    ]);
    await db.insert(projectAccess).values([
      { projectId: SECRET_PROJECT, principalType: "user", principalId: "listed-user", grantedByUserId: "sam" },
      { projectId: SECRET_PROJECT, principalType: "agent", principalId: AGENT_ON_LIST, grantedByUserId: "sam" },
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

    // The activity rows the budget service writes — project, company and
    // agent scopes for the open and the restricted project.
    await budgetActivity("budget.policy_upserted", "budget_policy", SECRET_POLICY, {
      scopeType: "project",
      scopeId: SECRET_PROJECT,
      scopeName: SECRET_NAME,
      amount: 1_000,
      windowKind: "lifetime",
    });
    await budgetActivity("budget.hard_threshold_crossed", "budget_incident", SECRET_INCIDENT, {
      scopeType: "project",
      scopeId: SECRET_PROJECT,
      scopeName: SECRET_NAME,
      amountObserved: 1_500,
      amountLimit: 1_000,
      approvalId: SECRET_APPROVAL,
    });
    await budgetActivity("budget.policy_upserted", "budget_policy", OPEN_POLICY, {
      scopeType: "project",
      scopeId: OPEN_PROJECT,
      scopeName: "Open project",
      amount: 500,
      windowKind: "lifetime",
    });
    await budgetActivity("budget.policy_upserted", "budget_policy", COMPANY_POLICY, {
      scopeType: "company",
      scopeId: COMPANY,
      amount: 10_000,
      windowKind: "calendar_month_utc",
    });
    await budgetActivity("budget.policy_upserted", "budget_policy", AGENT_POLICY, {
      scopeType: "agent",
      scopeId: AGENT_ON_LIST,
      amount: 200,
      windowKind: "calendar_month_utc",
    });

    // The approval.* rows approvals.ts writes — the override type sits in
    // details, the project in the approval's payload. The restricted one's
    // row must follow the project rule, not read as company-level.
    await budgetActivity("approval.created", "approval", SECRET_APPROVAL, {
      type: "budget_override_required",
      issueIds: [],
    });
    await budgetActivity("approval.created", "approval", OPEN_APPROVAL, {
      type: "budget_override_required",
      issueIds: [],
    });
    // A project scope whose id is not a uuid cannot resolve — the live
    // filter fails closed on it, and the feed now matches.
    await budgetActivity("budget.policy_upserted", "budget_policy", MALFORMED_POLICY, {
      scopeType: "project",
      scopeId: "not-a-uuid",
      scopeName: MALFORMED_SCOPE_NAME,
      amount: 1,
      windowKind: "lifetime",
    });
  }, 120_000);

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
    app.use("/api", activityRoutes(db));
    app.use("/api", assistantRoutes(db));
    app.use("/api", sidebarBadgeRoutes(db));
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
  const asAgent = (agentId: string) => ({
    type: "agent",
    source: "agent_key",
    agentId,
    companyId: COMPANY,
    companyIds: [COMPANY],
  });
  const OUTSIDER = asUser("member-user", "member");
  const LISTED = asUser("listed-user", "member");
  const CREATOR = asUser("sam", "member");
  const ADMIN = asUser("admin-user", "admin");

  describe("GET /companies/:id/activity", () => {
    it("hides restricted-project budget rows — policy, incident, name, spend — from an off-list member", async () => {
      const res = await request(appAs(OUTSIDER)).get(`/api/companies/${COMPANY}/activity`);
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      for (const leaked of [SECRET_NAME, SECRET_PROJECT, SECRET_POLICY, SECRET_INCIDENT, SECRET_APPROVAL]) {
        expect(body).not.toContain(leaked);
      }
      // Company-, open-project- and agent-scoped budget rows stay.
      const entityIds = res.body.map((row: { entityId: string }) => row.entityId);
      expect(entityIds).toEqual(
        expect.arrayContaining([COMPANY_POLICY, OPEN_POLICY, AGENT_POLICY]),
      );
    });

    it.each([
      ["a member on the access list", LISTED],
      ["the project's creator", CREATOR],
      ["an admin", ADMIN],
    ])("shows the rows to %s", async (_label, actor) => {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/activity`);
      expect(res.status).toBe(200);
      const entityIds = res.body.map((row: { entityId: string }) => row.entityId);
      expect(entityIds).toEqual(expect.arrayContaining([SECRET_POLICY, SECRET_INCIDENT]));
      expect(JSON.stringify(res.body)).toContain(SECRET_NAME);
    });

    it("applies the same rule to agent callers by their project access", async () => {
      const offList = await request(appAs(asAgent(AGENT_OFF_LIST))).get(
        `/api/companies/${COMPANY}/activity`,
      );
      expect(offList.status).toBe(200);
      expect(JSON.stringify(offList.body)).not.toContain(SECRET_PROJECT);
      expect(JSON.stringify(offList.body)).not.toContain(SECRET_NAME);

      const onList = await request(appAs(asAgent(AGENT_ON_LIST))).get(
        `/api/companies/${COMPANY}/activity`,
      );
      expect(onList.status).toBe(200);
      expect(onList.body.map((row: { entityId: string }) => row.entityId)).toEqual(
        expect.arrayContaining([SECRET_POLICY, SECRET_INCIDENT]),
      );
    });

    it("keeps the rule under an entityType filter — a probe cannot read around it", async () => {
      const res = await request(appAs(OUTSIDER)).get(
        `/api/companies/${COMPANY}/activity?entityType=budget_policy`,
      );
      expect(res.status).toBe(200);
      expect(res.body.map((row: { entityId: string }) => row.entityId).sort()).toEqual(
        [COMPANY_POLICY, OPEN_POLICY, AGENT_POLICY].sort(),
      );
    });

    it("hides approval.* rows for the restricted project's override", async () => {
      const approvalIds = (body: Array<{ entityType: string; entityId: string }>) =>
        body.filter((row) => row.entityType === "approval").map((row) => row.entityId);

      const outsider = await request(appAs(OUTSIDER)).get(`/api/companies/${COMPANY}/activity`);
      expect(outsider.status).toBe(200);
      expect(approvalIds(outsider.body)).toEqual([OPEN_APPROVAL]);

      for (const actor of [LISTED, CREATOR, ADMIN]) {
        const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/activity`);
        expect(approvalIds(res.body)).toEqual(
          expect.arrayContaining([OPEN_APPROVAL, SECRET_APPROVAL]),
        );
      }

      const onList = await request(appAs(asAgent(AGENT_ON_LIST))).get(
        `/api/companies/${COMPANY}/activity`,
      );
      expect(approvalIds(onList.body)).toEqual(
        expect.arrayContaining([OPEN_APPROVAL, SECRET_APPROVAL]),
      );
      const offList = await request(appAs(asAgent(AGENT_OFF_LIST))).get(
        `/api/companies/${COMPANY}/activity`,
      );
      expect(approvalIds(offList.body)).toEqual([OPEN_APPROVAL]);
    });

    it("fails closed on a project scope id that cannot resolve, matching the live filter", async () => {
      for (const actor of [OUTSIDER, LISTED, CREATOR]) {
        const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/activity`);
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(MALFORMED_POLICY);
        expect(body).not.toContain(MALFORMED_SCOPE_NAME);
        expect(body).not.toContain("not-a-uuid");
      }
      // An admin still audits everything, including the malformed row.
      const admin = await request(appAs(ADMIN)).get(`/api/companies/${COMPANY}/activity`);
      expect(admin.body.map((row: { entityId: string }) => row.entityId)).toContain(MALFORMED_POLICY);
    });
  });

  describe("GET /companies/:id/sidebar-badges", () => {
    it("counts only the approvals the viewer may see", async () => {
      for (const [actor, expected] of [
        [OUTSIDER, 1],
        [LISTED, 2],
        [ADMIN, 2],
        [asAgent(AGENT_OFF_LIST), 1],
        [asAgent(AGENT_ON_LIST), 2],
      ] as const) {
        const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/sidebar-badges`);
        expect(res.status).toBe(200);
        expect(res.body.approvals).toBe(expected);
      }
    });
  });

  describe("GET /companies/:id/assistant/digest", () => {
    const digest = (actor: Record<string, unknown>, query = "") =>
      request(appAs(actor)).get(`/api/companies/${COMPANY}/assistant/digest?since=2020-01-01T00:00:00.000Z${query}`);

    it("drops the restricted project's override from an off-list member's decisions", async () => {
      const res = await digest(OUTSIDER);
      expect(res.status).toBe(200);
      expect(res.body.decisionsWaiting.total).toBe(1);
      expect(res.body.decisionsWaiting.items.map((d: { approvalId: string }) => d.approvalId)).toEqual([
        OPEN_APPROVAL,
      ]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_NAME);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_APPROVAL);
    });

    it.each([
      ["a listed member", LISTED],
      ["the creator", CREATOR],
      ["an admin", ADMIN],
    ])("keeps it for %s", async (_label, actor) => {
      const res = await digest(actor);
      expect(res.status).toBe(200);
      expect(res.body.decisionsWaiting.total).toBe(2);
      expect(res.body.decisionsWaiting.items.map((d: { approvalId: string }) => d.approvalId)).toEqual(
        expect.arrayContaining([OPEN_APPROVAL, SECRET_APPROVAL]),
      );
    });

    it("scopes a budget override to its project in the project digest, and 404s on a hidden one", async () => {
      const listed = await digest(LISTED, `&projectId=${SECRET_PROJECT}`);
      expect(listed.status).toBe(200);
      const linkedIds = listed.body.decisionsWaiting.linked.items.map(
        (d: { approvalId: string }) => d.approvalId,
      );
      expect(linkedIds).toEqual([SECRET_APPROVAL]);
      const companyIds = listed.body.decisionsWaiting.companyLevel.items.map(
        (d: { approvalId: string }) => d.approvalId,
      );
      // The open project's override is not company-level either.
      expect(companyIds).toEqual([]);

      const outsider = await digest(OUTSIDER, `&projectId=${SECRET_PROJECT}`);
      expect(outsider.status).toBe(404);
    });

    it("drops the restricted override's approval.* activity rows from changed[]", async () => {
      const approvalRefs = (items: Array<{ entityType: string; target: { ref: string } | null }>) =>
        items.filter((item) => item.entityType === "approval").map((item) => item.target?.ref);

      const res = await digest(OUTSIDER);
      expect(res.status).toBe(200);
      expect(approvalRefs(res.body.changed.items)).toEqual([OPEN_APPROVAL]);
      expect(JSON.stringify(res.body.changed)).not.toContain(SECRET_APPROVAL);

      // The listed member gets the row, labelled with its project.
      const listed = await digest(LISTED);
      expect(approvalRefs(listed.body.changed.items)).toEqual(
        expect.arrayContaining([OPEN_APPROVAL, SECRET_APPROVAL]),
      );
      const secretRow = listed.body.changed.items.find(
        (item: { target: { ref: string } | null }) => item.target?.ref === SECRET_APPROVAL,
      );
      expect(secretRow.project).toBe(SECRET_NAME);
    });
  });

  describe("GET /companies/:id/assistant/pending-decisions", () => {
    it("does not list an approval the viewer may not see", async () => {
      const outsider = await request(appAs(OUTSIDER)).get(
        `/api/companies/${COMPANY}/assistant/pending-decisions`,
      );
      expect(outsider.status).toBe(200);
      const ids = outsider.body.decisions.map((d: { approvalId: string }) => d.approvalId);
      expect(ids).toEqual([OPEN_APPROVAL]);
      expect(outsider.body.total).toBe(1);
      expect(JSON.stringify(outsider.body)).not.toContain(SECRET_NAME);

      const admin = await request(appAs(ADMIN)).get(
        `/api/companies/${COMPANY}/assistant/pending-decisions`,
      );
      expect(admin.status).toBe(200);
      expect(admin.body.decisions.map((d: { approvalId: string }) => d.approvalId)).toEqual(
        expect.arrayContaining([OPEN_APPROVAL, SECRET_APPROVAL]),
      );
    });
  });
});
