import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectRoutes } from "../routes/projects.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * A5 (2026-08-16), the leak test: one restricted project, walked from every
 * angle by every kind of actor, against the REAL routers and a REAL database.
 *
 * The property: to an actor off the access list, a restricted project and
 * everything inside it is NONEXISTENT — absent from lists, 404 on detail
 * (never 403: confirming existence is itself the leak). Falsification for
 * each case is removing the one visibility condition from the query it
 * covers; the named case must fail.
 */
describeEmbeddedPostgres("restricted project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const OPEN_ISSUE = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const LEAD_AGENT = randomUUID();
  const OUTSIDE_AGENT = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Visibility Co" });
    for (const [userId, role] of [
      ["titus", "admin"],
      ["sam", "member"],
      ["megan", "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: LEAD_AGENT, companyId: COMPANY, name: "Lead", role: "general" },
      { id: OUTSIDE_AGENT, companyId: COMPANY, name: "Outside", role: "general" },
    ]);
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open project", createdByUserId: "titus" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: "Sam's restricted project",
        createdByUserId: "sam",
        visibility: "restricted",
        leadAgentId: LEAD_AGENT,
      },
    ]);
    await db.insert(projectAccess).values({
      projectId: SECRET_PROJECT,
      principalType: "agent",
      principalId: LEAD_AGENT,
      grantedByUserId: "sam",
    });
    await db.insert(issues).values([
      { id: OPEN_ISSUE, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Open issue", status: "todo" },
      { id: SECRET_ISSUE, companyId: COMPANY, projectId: SECRET_PROJECT, title: "Secret issue", status: "todo" },
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
    app.use("/api", projectRoutes(db));
    app.use("/api", issueRoutes(db));
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

  it("project list: creator and admin see it; another member does not", async () => {
    const names = async (actor: Record<string, unknown>) =>
      (await request(appAs(actor)).get(`/api/companies/${COMPANY}/projects`)).body.map(
        (p: { name: string }) => p.name,
      );

    expect(await names(asUser("sam", "member"))).toContain("Sam's restricted project");
    expect(await names(asUser("titus", "admin"))).toContain("Sam's restricted project");
    const meganSees = await names(asUser("megan", "member"));
    expect(meganSees).toContain("Open project");
    expect(meganSees).not.toContain("Sam's restricted project");
  });

  it("project detail: 404 for an off-list member — never 403", async () => {
    const res = await request(appAs(asUser("megan", "member"))).get(`/api/projects/${SECRET_PROJECT}`);
    expect(res.status).toBe(404);

    expect(
      (await request(appAs(asUser("sam", "member"))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(200);
    expect(
      (await request(appAs(asUser("titus", "admin"))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(200);
  });

  it("issue list: the restricted project's issues vanish for an off-list member", async () => {
    const titles = async (actor: Record<string, unknown>) => {
      const res = await request(appAs(actor)).get(`/api/companies/${COMPANY}/issues`);
      const list = Array.isArray(res.body) ? res.body : res.body.issues;
      return (list ?? []).map((i: { title: string }) => i.title);
    };

    const megan = await titles(asUser("megan", "member"));
    expect(megan).toContain("Open issue");
    expect(megan).not.toContain("Secret issue");
    expect(await titles(asUser("sam", "member"))).toContain("Secret issue");
    expect(await titles(asUser("titus", "admin"))).toContain("Secret issue");
  });

  it("issue detail: 404 for an off-list member", async () => {
    expect(
      (await request(appAs(asUser("megan", "member"))).get(`/api/issues/${SECRET_ISSUE}`)).status,
    ).toBe(404);
    expect(
      (await request(appAs(asUser("sam", "member"))).get(`/api/issues/${SECRET_ISSUE}`)).status,
    ).toBe(200);
  });

  it("agents: the lead agent (on the access list) sees it; another agent does not", async () => {
    expect(
      (await request(appAs(asAgent(LEAD_AGENT))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(200);
    expect(
      (await request(appAs(asAgent(OUTSIDE_AGENT))).get(`/api/projects/${SECRET_PROJECT}`)).status,
    ).toBe(404);
    const res = await request(appAs(asAgent(OUTSIDE_AGENT))).get(
      `/api/companies/${COMPANY}/issues`,
    );
    const list = Array.isArray(res.body) ? res.body : res.body.issues;
    expect((list ?? []).map((i: { title: string }) => i.title)).not.toContain("Secret issue");
  });

  it("a legacy operator row is a member here too — no residual privilege", async () => {
    const res = await request(appAs(asUser("megan", "operator"))).get(
      `/api/projects/${SECRET_PROJECT}`,
    );
    expect(res.status).toBe(404);
  });
});
