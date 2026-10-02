import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import { dashboardRoutes } from "../routes/dashboard.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: Home's month spend and token totals follow the same visibility
 * rule as the counts beside them (#930). A member who is neither an admin nor
 * on a restricted project's access list must not see that project's spend or
 * token volume, whether the cost event names the project directly or only
 * through its issue. A listed member and an admin see the whole month.
 */
describeEmbeddedPostgres("dashboard month spend and tokens follow project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const AGENT = randomUUID();

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
    await db.insert(projectAccess).values({
      projectId: SECRET_PROJECT,
      principalType: "user",
      principalId: "listed-user",
      grantedByUserId: "sam",
    });
    await db.insert(agents).values({
      id: AGENT,
      companyId: COMPANY,
      name: "Researcher",
      role: "general",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
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

  it("leaves the restricted project's spend and tokens out for an off-list member", async () => {
    const res = await request(appAs(asUser("member-user", "member"))).get(`/api/companies/${COMPANY}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.costs.monthTokens).toBe(1_500);
    expect(res.body.costs.monthSpendCents).toBe(150);
  });

  it("counts the whole month for a listed member and an admin", async () => {
    for (const actor of [asUser("listed-user", "member"), asUser("admin-user", "admin")]) {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/dashboard`);
      expect(res.status).toBe(200);
      expect(res.body.costs.monthTokens).toBe(321_500);
      expect(res.body.costs.monthSpendCents).toBe(32_150);
    }
  });
});
