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
  heartbeatRuns,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: UX-2 (#783) — GET /companies/:companyId/work-products, the
 * Shipped feed, against the real router and a real database.
 */
describeEmbeddedPostgres("GET /companies/:companyId/work-products (Shipped feed)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();
  const PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const MAYA = randomUUID();
  const PRIYA = randomUUID();
  const OTHER_AGENT = randomUUID();
  const METERED_ISSUE = randomUUID();
  const UNMETERED_ISSUE = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const OTHER_ISSUE = randomUUID();
  const RUN = randomUUID();
  const NOW = Date.now();
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shipped-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: COMPANY, name: "Shipped Co", issuePrefix: "SHP" },
      { id: OTHER_COMPANY, name: "Other Co", issuePrefix: "OTH" },
    ]);
    for (const [userId, role] of [["owner", "owner"], ["megan", "member"]] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: MAYA, companyId: COMPANY, name: "Maya", role: "engineer" },
      { id: PRIYA, companyId: COMPANY, name: "Priya", role: "engineer" },
      { id: OTHER_AGENT, companyId: OTHER_COMPANY, name: "Stranger", role: "engineer" },
    ]);
    await db.insert(projects).values([
      { id: PROJECT, companyId: COMPANY, name: "Web", createdByUserId: "owner" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: "Secret",
        createdByUserId: "owner",
        visibility: "restricted",
      },
    ]);
    await db.insert(issues).values([
      {
        id: METERED_ISSUE,
        companyId: COMPANY,
        projectId: PROJECT,
        title: "Add a health badge",
        identifier: "SHP-1",
        status: "done",
        assigneeAgentId: PRIYA,
      },
      {
        id: UNMETERED_ISSUE,
        companyId: COMPANY,
        title: "Write the changelog",
        identifier: "SHP-2",
        status: "in_review",
        assigneeAgentId: PRIYA,
      },
      {
        id: SECRET_ISSUE,
        companyId: COMPANY,
        projectId: SECRET_PROJECT,
        title: "Secret work",
        identifier: "SHP-3",
        status: "done",
      },
      { id: OTHER_ISSUE, companyId: OTHER_COMPANY, title: "Not yours", identifier: "OTH-1", status: "done" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: RUN,
      companyId: COMPANY,
      agentId: MAYA,
      status: "succeeded",
      invocationSource: "assignment",
    });
    await db.insert(issueWorkProducts).values([
      {
        companyId: COMPANY,
        issueId: METERED_ISSUE,
        projectId: PROJECT,
        type: "pull_request",
        provider: "github",
        title: "PR #12 health badge",
        url: "https://github.com/acme/web/pull/12",
        status: "merged",
        createdByRunId: RUN,
        createdAt: minutesAgo(10),
        updatedAt: minutesAgo(10),
      },
      {
        companyId: COMPANY,
        issueId: UNMETERED_ISSUE,
        type: "document",
        provider: "paperclip",
        title: "Changelog draft",
        status: "active",
        summary: "A draft of the September changelog",
        createdAt: minutesAgo(5),
        updatedAt: minutesAgo(5),
      },
      {
        companyId: COMPANY,
        issueId: SECRET_ISSUE,
        projectId: SECRET_PROJECT,
        type: "pull_request",
        provider: "github",
        title: "Secret PR",
        url: "https://github.com/acme/secret/pull/1",
        status: "ready_for_review",
        createdAt: minutesAgo(1),
        updatedAt: minutesAgo(1),
      },
      {
        companyId: OTHER_COMPANY,
        issueId: OTHER_ISSUE,
        type: "pull_request",
        provider: "github",
        title: "Other company PR",
        url: "https://github.com/other/x/pull/9",
        status: "merged",
        createdAt: minutesAgo(0),
        updatedAt: minutesAgo(0),
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId: COMPANY,
        agentId: MAYA,
        issueId: METERED_ISSUE,
        heartbeatRunId: RUN,
        provider: "zai",
        biller: "zai",
        billingType: "metered_api",
        model: "glm-5.3-flash",
        inputTokens: 1200,
        cachedInputTokens: 300,
        outputTokens: 80,
        costCents: 0,
        occurredAt: minutesAgo(11),
      },
      {
        companyId: COMPANY,
        agentId: MAYA,
        issueId: METERED_ISSUE,
        provider: "zai",
        biller: "zai",
        billingType: "metered_api",
        model: "glm-5.3-flash",
        inputTokens: 800,
        cachedInputTokens: 0,
        outputTokens: 20,
        costCents: 0,
        occurredAt: minutesAgo(12),
      },
    ]);
  }, 60_000);

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
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  const asUser = (userId: string, role: string, companyId = COMPANY) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  });

  it("lists the company's work products newest first with issue, agent and usage", async () => {
    const res = await request(appAs(asUser("owner", "owner"))).get(`/api/companies/${COMPANY}/work-products`);
    expect(res.status).toBe(200);
    const titles = res.body.items.map((item: { title: string }) => item.title);
    expect(titles).toEqual(["Secret PR", "Changelog draft", "PR #12 health badge"]);
    expect(titles).not.toContain("Other company PR");

    const pr = res.body.items[2];
    expect(pr.issue).toMatchObject({ id: METERED_ISSUE, identifier: "SHP-1", title: "Add a health badge" });
    // The producing run's agent wins over the issue's assignee.
    expect(pr.agent).toEqual({ id: MAYA, name: "Maya" });
    expect(pr.usage).toEqual({
      metered: true,
      inputTokens: 2000,
      cachedInputTokens: 300,
      outputTokens: 100,
      costCents: 0,
    });

    const doc = res.body.items[1];
    expect(doc.agent).toEqual({ id: PRIYA, name: "Priya" });
    expect(doc.usage.metered).toBe(false);

    expect(res.body.nextCursor).toBeNull();
    expect(res.body.total).toBe(3);
  });

  it("never returns another company's work products, and refuses a foreign company id", async () => {
    const other = await request(appAs(asUser("stranger", "owner", OTHER_COMPANY))).get(
      `/api/companies/${OTHER_COMPANY}/work-products`,
    );
    expect(other.status).toBe(200);
    expect(other.body.items.map((i: { title: string }) => i.title)).toEqual(["Other company PR"]);

    const foreign = await request(appAs(asUser("stranger", "owner", OTHER_COMPANY))).get(
      `/api/companies/${COMPANY}/work-products`,
    );
    expect(foreign.status).toBe(403);

    // A company-A caller filtering by a company-B issue id gets nothing.
    const crossIssue = await request(appAs(asUser("owner", "owner"))).get(
      `/api/companies/${COMPANY}/work-products?issueId=${OTHER_ISSUE}`,
    );
    expect(crossIssue.status).toBe(200);
    expect(crossIssue.body.items).toEqual([]);
  });

  it("hides work products in a restricted project from a member off its access list", async () => {
    const res = await request(appAs(asUser("megan", "member"))).get(`/api/companies/${COMPANY}/work-products`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual([
      "Changelog draft",
      "PR #12 health badge",
    ]);
  });

  it("paginates with a cursor without repeating or skipping rows", async () => {
    const app = appAs(asUser("owner", "owner"));
    const first = await request(app).get(`/api/companies/${COMPANY}/work-products?limit=2`);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.total).toBe(3);
    const second = await request(app).get(
      `/api/companies/${COMPANY}/work-products?limit=2&before=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.items.map((i: { title: string }) => i.title)).toEqual(["PR #12 health badge"]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("filters by project, agent and issue", async () => {
    const app = appAs(asUser("owner", "owner"));
    const byProject = await request(app).get(`/api/companies/${COMPANY}/work-products?projectId=${PROJECT}`);
    expect(byProject.body.items.map((i: { title: string }) => i.title)).toEqual(["PR #12 health badge"]);
    const byAgent = await request(app).get(`/api/companies/${COMPANY}/work-products?agentId=${PRIYA}`);
    expect(byAgent.body.items.map((i: { title: string }) => i.title)).toEqual(["Changelog draft"]);
    const byIssue = await request(app).get(`/api/companies/${COMPANY}/work-products?issueId=${METERED_ISSUE}`);
    expect(byIssue.body.items).toHaveLength(1);
  });

  it("filters by since and counts the full match in total", async () => {
    const since = minutesAgo(7).toISOString();
    const res = await request(appAs(asUser("owner", "owner"))).get(
      `/api/companies/${COMPANY}/work-products?since=${encodeURIComponent(since)}&limit=1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual(["Secret PR"]);
    expect(res.body.total).toBe(2);
  });

  it("totals this month's work products and metered usage", async () => {
    const res = await request(appAs(asUser("owner", "owner"))).get(`/api/companies/${COMPANY}/work-products`);
    const createdThisMonth = [minutesAgo(10), minutesAgo(5), minutesAgo(1)].filter(
      (d) => d.getUTCMonth() === new Date(NOW).getUTCMonth(),
    ).length;
    expect(res.body.monthTotal.count).toBe(createdThisMonth);
    if (createdThisMonth === 3) {
      expect(res.body.monthTotal.pullRequests).toBe(2);
      expect(res.body.monthTotal.usage).toMatchObject({ metered: true, inputTokens: 2000, outputTokens: 100 });
    }
  });

  it("rejects malformed filters and cursors with 400", async () => {
    const app = appAs(asUser("owner", "owner"));
    expect((await request(app).get(`/api/companies/${COMPANY}/work-products?projectId=nope`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${COMPANY}/work-products?limit=0`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${COMPANY}/work-products?before=garbage`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${COMPANY}/work-products?since=yesterday`)).status).toBe(400);
  });
});
