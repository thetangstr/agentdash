import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  issueComments,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
let errorHandler: typeof import("../middleware/index.js").errorHandler;
let userProfileRoutes: typeof import("../routes/user-profiles.js").userProfileRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres user profile route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /companies/:companyId/users/:userSlug/profile", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let userId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-profile-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/user-profiles.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/user-profiles.js")>("../routes/user-profiles.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    userProfileRoutes = routes.userProfileRoutes;
    errorHandler = middleware.errorHandler;
    companyId = randomUUID();
    userId = randomUUID();
    agentId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Dotta",
      email: "dotta@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    });
  });

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(projectAccess);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actorOverride?: Record<string, unknown>) {
    if (!userProfileRoutes || !errorHandler) {
      throw new Error("user profile route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actorOverride ?? {
        type: "board",
        source: "local_implicit",
        userId,
        companyIds: [companyId],
      };
      next();
    });
    app.use("/api", userProfileRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("resolves a user slug and returns issue, activity, and attributed cost stats", async () => {
    const doneIssueId = randomUUID();
    const openIssueId = randomUUID();
    const now = new Date();
    const older = new Date(now.getTime() - 60_000);

    await db.insert(issues).values([
      {
        id: doneIssueId,
        companyId,
        title: "Ship profile page",
        status: "done",
        priority: "high",
        createdByUserId: userId,
        identifier: "USR-1",
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: openIssueId,
        companyId,
        title: "Review profile copy",
        status: "in_progress",
        priority: "medium",
        assigneeUserId: userId,
        identifier: "USR-2",
        createdAt: older,
        updatedAt: older,
      },
    ]);
    await db.insert(issueComments).values({
      companyId,
      issueId: openIssueId,
      authorUserId: userId,
      body: "Looks good.",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.updated",
      entityType: "issue",
      entityId: doneIssueId,
      createdAt: now,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId: doneIssueId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-test",
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 40,
      costCents: 42,
      occurredAt: now,
    });

    const response = await request(createApp()).get(`/api/companies/${companyId}/users/dotta/profile`);

    expect(response.status).toBe(200);
    expect(response.body.user.slug).toBe("dotta");
    expect(response.body.user.membershipRole).toBe("owner");
    expect(response.body.stats).toHaveLength(3);

    const all = response.body.stats.find((entry: { key: string }) => entry.key === "all");
    expect(all).toMatchObject({
      touchedIssues: 2,
      createdIssues: 1,
      completedIssues: 1,
      assignedOpenIssues: 1,
      commentCount: 1,
      activityCount: 1,
      costCents: 42,
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 40,
      costEventCount: 1,
    });
    expect(response.body.recentIssues.map((issue: { identifier: string }) => issue.identifier)).toEqual(["USR-1", "USR-2"]);
    expect(response.body.recentActivity[0].action).toBe("issue.updated");
    expect(response.body.topAgents[0]).toMatchObject({ agentId, agentName: "Coder", costCents: 42 });
    expect(response.body.topProviders[0]).toMatchObject({ provider: "openai", model: "gpt-test", costCents: 42 });
    expect(response.body.measured, "a company with a cost event has been measured").toBe(true);
  });

  // AgentDash (GH #505): a profile is readable by anything with company access,
  // but the address is not -- agents get the person, never the email.
  it("keeps the email for the local board but never returns it to an agent", async () => {
    const board = await request(createApp()).get(`/api/companies/${companyId}/users/dotta/profile`);
    expect(board.status).toBe(200);
    expect(board.body.user.email).toBe("dotta@example.com");

    const agent = await request(
      createApp({ type: "agent", agentId, companyId, source: "agent_key" }),
    ).get(`/api/companies/${companyId}/users/dotta/profile`);
    expect(agent.status).toBe(200);
    expect(agent.body.user.name).toBe("Dotta");
    expect(agent.body.user.email).toBeNull();
  });

  /**
   * The distinction the page cannot draw for itself.
   *
   * On the live uat instance this user has five completed issues and zero
   * tokens, because nothing on that instance meters anything. The profile said
   * "0 tokens, $0.00 spent" — a confident claim about a colleague's work made
   * out of a gap in our own instrumentation.
   */
  describe("measured", () => {
    async function fetchProfile() {
      const response = await request(createApp()).get(`/api/companies/${companyId}/users/dotta/profile`);
      expect(response.status).toBe(200);
      return response.body;
    }

    it("is false when the company has never recorded a cost event", async () => {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: "Real work, unmetered",
        status: "done",
        priority: "high",
        createdByUserId: userId,
        identifier: "USR-9",
        completedAt: new Date(),
      });

      const body = await fetchProfile();
      expect(body.measured).toBe(false);
      // The work itself is still reported. "Not measured" is a statement about
      // cost, not about the person.
      expect(body.stats.find((e: { key: string }) => e.key === "all").completedIssues).toBe(1);
    });

    it("is true once the company measures anything, even work this person never touched", async () => {
      // This is what `costEventCount` cannot tell you. Here the user's own
      // attributed total is still zero — but it is now a REAL zero, because the
      // instance demonstrably meters. Reporting it as "not measured" would be
      // the opposite lie.
      const otherUserId = randomUUID();
      const otherIssueId = randomUUID();
      await db.insert(authUsers).values({
        id: otherUserId,
        name: "Someone Else",
        email: "else@example.com",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(issues).values({
        id: otherIssueId,
        companyId,
        title: "Not this user's issue",
        status: "done",
        priority: "low",
        createdByUserId: otherUserId,
        assigneeUserId: otherUserId,
        identifier: "USR-10",
        completedAt: new Date(),
      });
      await db.insert(costEvents).values({
        companyId,
        agentId,
        issueId: otherIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-test",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        costCents: 7,
        occurredAt: new Date(),
      });

      const body = await fetchProfile();
      expect(body.measured, "the COMPANY has measured, so this user's zero is real").toBe(true);
      const all = body.stats.find((e: { key: string }) => e.key === "all");
      expect(all.costEventCount, "none of it is attributed to this user").toBe(0);
      expect(all.costCents).toBe(0);
    });

    it("stays true for an event older than every reporting window", async () => {
      // Deliberately unbounded by date, matching CostSummary.measured. A
      // 30-day window going quiet does not mean metering stopped existing.
      const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      const oldIssueId = randomUUID();
      await db.insert(issues).values({
        id: oldIssueId,
        companyId,
        title: "Ancient",
        status: "done",
        priority: "low",
        createdByUserId: userId,
        identifier: "USR-11",
        completedAt: longAgo,
        createdAt: longAgo,
        updatedAt: longAgo,
      });
      await db.insert(costEvents).values({
        companyId,
        agentId,
        issueId: oldIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-test",
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        costCents: 1,
        occurredAt: longAgo,
      });

      expect((await fetchProfile()).measured).toBe(true);
    });
  });

  /**
   * AgentDash (GH #933): a profile's activity reads are the same shape as the
   * company feed — `activity_log` rows about a restricted project must follow
   * the project rule here too. A member viewing a colleague's profile must
   * not learn the restricted project's name, budget amounts or approval ids.
   */
  describe("restricted-project visibility (GH #933)", () => {
    const memberId = "member-viewer";
    const listedMemberId = "listed-viewer";
    const memberActor = (id: string) => ({
      type: "board",
      source: "session",
      userId: id,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });

    it("hides restricted-project budget rows and approval rows from a member's profile view", async () => {
      const secretProjectId = randomUUID();
      const secretName = "Quiet acquisition project";
      const secretPolicyId = randomUUID();
      const companyPolicyId = randomUUID();
      const secretApprovalId = randomUUID();
      const openApprovalId = randomUUID();
      const now = new Date();

      await db.insert(companyMemberships).values([
        {
          companyId,
          principalType: "user",
          principalId: memberId,
          status: "active",
          membershipRole: "member",
        },
        {
          companyId,
          principalType: "user",
          principalId: listedMemberId,
          status: "active",
          membershipRole: "member",
        },
      ]);
      await db.insert(projects).values({
        id: secretProjectId,
        companyId,
        name: secretName,
        createdByUserId: "someone-else",
        visibility: "restricted",
      });
      await db.insert(projectAccess).values({
        projectId: secretProjectId,
        principalType: "user",
        principalId: listedMemberId,
        grantedByUserId: "someone-else",
      });
      // A soft-deleted issue's activity row is dropped by the feed for every
      // viewer; the profile must drop it too rather than outliving the row.
      const hiddenIssueId = randomUUID();
      await db.insert(issues).values({
        id: hiddenIssueId,
        companyId,
        title: "Deleted draft",
        status: "done",
        priority: "medium",
        createdByUserId: userId,
        identifier: "USR-DEL",
        hiddenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(approvals).values([
        {
          id: secretApprovalId,
          companyId,
          type: "budget_override_required",
          status: "approved",
          payload: {
            scopeType: "project",
            scopeId: secretProjectId,
            scopeName: secretName,
            budgetAmount: 1_000,
            observedAmount: 1_500,
          },
        },
        {
          id: openApprovalId,
          companyId,
          type: "budget_override_required",
          status: "pending",
          payload: {
            scopeType: "company",
            scopeId: companyId,
            budgetAmount: 10_000,
          },
        },
      ]);
      await db.insert(activityLog).values([
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "budget.policy_upserted",
          entityType: "budget_policy",
          entityId: secretPolicyId,
          details: { scopeType: "project", scopeId: secretProjectId, scopeName: secretName, amount: 1_000 },
          createdAt: now,
        },
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "budget.policy_upserted",
          entityType: "budget_policy",
          entityId: companyPolicyId,
          details: { scopeType: "company", scopeId: companyId, amount: 10_000 },
          createdAt: now,
        },
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "approval.approved",
          entityType: "approval",
          entityId: secretApprovalId,
          details: { type: "budget_override_required" },
          createdAt: now,
        },
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "approval.created",
          entityType: "approval",
          entityId: openApprovalId,
          details: { type: "budget_override_required" },
          createdAt: now,
        },
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "issue.updated",
          entityType: "issue",
          entityId: hiddenIssueId,
          details: { title: "Deleted draft" },
          createdAt: now,
        },
      ]);

      // An off-list member sees none of it — not the name, the ids, the
      // amounts, and not the counts derived from the hidden rows.
      const memberRes = await request(createApp(memberActor(memberId))).get(
        `/api/companies/${companyId}/users/dotta/profile`,
      );
      expect(memberRes.status).toBe(200);
      const memberBody = JSON.stringify(memberRes.body);
      for (const leaked of [secretName, secretProjectId, secretPolicyId, secretApprovalId, hiddenIssueId, "Deleted draft"]) {
        expect(memberBody).not.toContain(leaked);
      }
      expect(
        memberRes.body.recentActivity.map((row: { entityId: string }) => row.entityId).sort(),
      ).toEqual([companyPolicyId, openApprovalId].sort());
      expect(
        memberRes.body.stats.find((entry: { key: string }) => entry.key === "all").activityCount,
      ).toBe(2);

      // A member on the project's access list sees the restricted rows.
      const listedRes = await request(createApp(memberActor(listedMemberId))).get(
        `/api/companies/${companyId}/users/dotta/profile`,
      );
      expect(listedRes.status).toBe(200);
      expect(listedRes.body.recentActivity.map((row: { entityId: string }) => row.entityId)).toEqual(
        expect.arrayContaining([secretPolicyId, secretApprovalId, companyPolicyId, openApprovalId]),
      );

      // The subject (an owner) sees everything on their own profile.
      const ownerRes = await request(createApp()).get(
        `/api/companies/${companyId}/users/dotta/profile`,
      );
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.recentActivity).toHaveLength(4);
    });
  });
});
