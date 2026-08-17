import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

  describe("A6: name collision", () => {
    it("refuses a near-miss of a VISIBLE name, overridable with confirmSimilarName", async () => {
      const app = appAs(asUser("megan", "member"));
      const res = await request(app)
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "OPEN   project!" }); // squashes to the same letters
      expect(res.status).toBe(409);
      expect(String(res.body.error)).toContain("Open project");

      const confirmed = await request(app)
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "Open project two", confirmSimilarName: true });
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.createdByUserId).toBe("megan");
    });

    it("does not leak a RESTRICTED project's name through the near-miss message", async () => {
      // Megan cannot see Sam's restricted project, so its name must not
      // appear in any refusal she receives. The deliberate consequence: her
      // near-duplicate of an invisible name is allowed. The hard unique
      // index still refuses an EXACT case-insensitive duplicate — as a
      // constraint violation, not a message carrying the hidden name.
      const res = await request(appAs(asUser("megan", "member")))
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "Sams restricted project" }); // near-miss, not exact
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain("Sam's restricted project");
    });

    it("a confirmed exact duplicate is auto-renamed, never stored verbatim", async () => {
      /**
       * Correction found while writing this test: the review claimed nothing
       * prevented duplicate names. In fact the creation path has ALWAYS
       * deduplicated — resolveProjectNameForUniqueShortname renames a
       * collision before insert. So the full A6 contract is: a near miss
       * warns first (new tonight); a CONFIRMED duplicate is renamed, not
       * refused (pre-existing); and the unique index backstops any write
       * path that skips the service.
       */
      const idx = (await db.execute(
        `select indexname from pg_indexes where tablename = 'projects'`,
      )) as unknown as Array<{ indexname: string }> & { rows?: Array<{ indexname: string }> };
      const names = (Array.isArray(idx) ? idx : (idx.rows ?? [])).map((r) => r.indexname);
      expect(names).toContain("projects_company_name_unique_idx");

      const res = await request(appAs(asUser("titus", "admin")))
        .post(`/api/companies/${COMPANY}/projects`)
        .send({ name: "OPEN PROJECT", confirmSimilarName: true });
      expect(res.status).toBe(201);
      expect(res.body.name.toLowerCase()).not.toBe("open project");

      const rows = await db.select().from(projects).where(eq(projects.companyId, COMPANY));
      expect(rows.filter((p) => p.name.toLowerCase() === "open project")).toHaveLength(1);

      // The index itself, exercised where the service dedupe cannot help:
      // a direct write of the exact lowercase-equal name must be refused.
      // drizzle wraps the violation, so assert on effect: the write rejects
      // and no second row exists.
      await expect(
        db.insert(projects).values({ companyId: COMPANY, name: "open PROJECT" }),
      ).rejects.toThrow();
      const after = await db.select().from(projects).where(eq(projects.companyId, COMPANY));
      expect(after.filter((p) => p.name.toLowerCase() === "open project")).toHaveLength(1);
    });
  });
});
