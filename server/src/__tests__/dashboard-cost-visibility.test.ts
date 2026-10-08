import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyRoutes } from "../routes/companies.js";
import { agentRoutes } from "../routes/agents.js";
import { costRoutes } from "../routes/costs.js";
import { activityRoutes } from "../routes/activity.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: Home's month spend and token totals follow TWO rules.
 *
 * GH #918: they are spend — members without `agents:create` cannot read the
 * /costs routes, so the dashboard answers `costs: null` and nulls the
 * taskQuality spend fields. Zeros would lie ("$0.00" is not "unknown").
 *
 * #930: for actors who may read spend, the totals still cover only what that
 * person can see — a restricted project's events (direct or via its issue)
 * stay out, proven below by an off-list AGENT (agents keep spend access).
 */
describeEmbeddedPostgres("dashboard month spend and tokens follow project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const AGENT = randomUUID();
  const LISTED_AGENT = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-cost-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Cost Visibility Co" });
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
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open project", createdByUserId: "admin-user" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: "Sam's restricted project",
        createdByUserId: "sam",
        visibility: "restricted",
      },
    ]);
    await db.insert(projectAccess).values([
      {
        projectId: SECRET_PROJECT,
        principalType: "user",
        principalId: "listed-user",
        grantedByUserId: "sam",
      },
      {
        projectId: SECRET_PROJECT,
        principalType: "agent",
        principalId: LISTED_AGENT,
        grantedByUserId: "sam",
      },
    ]);
    await db.insert(agents).values([
      {
        id: AGENT,
        companyId: COMPANY,
        name: "Researcher",
        role: "general",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: LISTED_AGENT,
        companyId: COMPANY,
        name: "Listed agent",
        role: "general",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: SECRET_ISSUE,
      companyId: COMPANY,
      projectId: SECRET_PROJECT,
      title: "Secret research",
      status: "in_progress",
    });
    const now = new Date();
    const event = (overrides: Record<string, unknown>) => ({
      companyId: COMPANY,
      agentId: AGENT,
      provider: "openrouter",
      biller: "openrouter",
      billingType: "unknown",
      model: "glm-5.3",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      occurredAt: now,
      ...overrides,
    });
    await db.insert(costEvents).values([
      // Visible to everyone: the open project, and an event with no project.
      event({ projectId: OPEN_PROJECT, inputTokens: 1_000, costCents: 100 }),
      event({ inputTokens: 500, costCents: 50 }),
      // Hidden from an off-list member: directly on the restricted project…
      event({ projectId: SECRET_PROJECT, inputTokens: 20_000, costCents: 2_000 }),
      // …and only through the restricted project's issue.
      event({ issueId: SECRET_ISSUE, outputTokens: 300_000, costCents: 30_000 }),
    ]);
  }, 30_000);

  it("hides company and agent financial fields, stats usage, overview and cost activity from members", async () => {
    const app = appAs(asUser("member-user", "member"));
    await db.insert(activityLog).values({ companyId: COMPANY, actorType: "agent", actorId: AGENT, agentId: AGENT, action: "cost.created", entityType: "cost_event", entityId: randomUUID(), details: { costCents: 987654 } });
    await db.insert(activityLog).values({ companyId: COMPANY, actorType: "user", actorId: "admin-user", action: "company.updated", entityType: "company", entityId: COMPANY, details: { name: "Renamed", budgetMonthlyCents: 876543, spentMonthlyCents: 765432 } });
    for (const path of [`/api/companies/${COMPANY}`, "/api/companies"]) {
      const res = await request(app).get(path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = Array.isArray(res.body) ? res.body.find((row: { id: string }) => row.id === COMPANY) : res.body;
      expect(row.spentMonthlyCents == null, path).toBe(true);
      expect(row.budgetMonthlyCents == null, path).toBe(true);
    }
    const stats = await request(app).get("/api/companies/stats");
    expect(stats.body[COMPANY].monthTokens).toBeNull();
    expect(stats.body[COMPANY].agentCount).toBe(2);
    for (const path of [`/api/agents/${AGENT}`, `/api/companies/${COMPANY}/agents`]) {
      const res = await request(app).get(path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = Array.isArray(res.body) ? res.body.find((row: { id: string }) => row.id === AGENT) : res.body;
      expect(row.spentMonthlyCents == null, path).toBe(true);
      expect(row.budgetMonthlyCents == null, path).toBe(true);
    }
    expect((await request(app).get(`/api/companies/${COMPANY}/budgets/overview`)).status).toBe(403);
    const feed = await request(app).get(`/api/companies/${COMPANY}/activity`);
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.body)).not.toMatch(/987654|876543|765432/);
    expect(JSON.stringify(feed.body)).toContain("Renamed");
  });

  it("preserves financial values and overview for administrators and agents", async () => {
    for (const actor of [asUser("admin-user", "admin"), { type: "agent", agentId: AGENT, companyId: COMPANY, source: "agent_key" }]) {
      const app = appAs(actor);
      const company = await request(app).get(`/api/companies/${COMPANY}`);
      expect(company.body.spentMonthlyCents).toBe(32150);
      const agent = await request(app).get(`/api/agents/${AGENT}`);
      expect(agent.body.spentMonthlyCents).toBe(32150);
      expect((await request(app).get(`/api/companies/${COMPANY}/budgets/overview`)).status).toBe(200);
    }
  });

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
    app.use("/api", dashboardRoutes(db));
    app.use("/api/companies", companyRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use("/api", costRoutes(db));
    app.use("/api", activityRoutes(db));
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
    agentId,
    companyId: COMPANY,
    source: "agent_key",
    companyIds: [COMPANY],
  });

  it("GH #918: members get costs:null and null taskQuality spend fields — never zeros", async () => {
    for (const actor of [asUser("member-user", "member"), asUser("listed-user", "member")]) {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/dashboard`);
      expect(res.status).toBe(200);
      expect(res.body.costs).toBeNull();
      // Everything else a member is entitled to still answers.
      expect(res.body.agents).toBeTruthy();
      expect(res.body.tasks).toBeTruthy();
      expect(res.body.budgets).toBeTruthy();
      expect(res.body.taskQuality.issueLinkedSpendCents).toBeNull();
      expect(res.body.taskQuality.issueLinkedTokens).toBeNull();
      expect(res.body.taskQuality.issueLinkedCachedTokens).toBeNull();
      expect(res.body.taskQuality.spendPerAcceptedIssueCents).toBeNull();
      // The task counts that are NOT spend stay.
      expect(typeof res.body.taskQuality.acceptanceRatePercent).toBe("number");
    }
  });

  it("the restricted project's spend stays out of an off-list agent's totals", async () => {
    const res = await request(appAs(asAgent(AGENT))).get(`/api/companies/${COMPANY}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.costs.monthTokens).toBe(1_500);
    expect(res.body.costs.monthSpendCents).toBe(150);
  });

  it("counts the whole month for the listed agent and an admin", async () => {
    for (const actor of [asAgent(LISTED_AGENT), asUser("admin-user", "admin")]) {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/dashboard`);
      expect(res.status).toBe(200);
      expect(res.body.costs.monthTokens).toBe(321_500);
      expect(res.body.costs.monthSpendCents).toBe(32_150);
    }
  });
});
