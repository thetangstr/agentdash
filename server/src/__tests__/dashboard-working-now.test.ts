import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
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

/** AgentDash: UX-3 (#784) — Home's "Working now": issue titles, not run hashes. */
describeEmbeddedPostgres("GET /companies/:companyId/dashboard/working-now", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const MAYA = randomUUID();
  const PRIYA = randomUUID();
  const STRANGER = randomUUID();
  const ISSUE = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const OTHER_ISSUE = randomUUID();
  const HIDDEN_ISSUE = randomUUID();
  const RUN_HIDDEN = randomUUID();
  const MANY = Array.from({ length: 8 }, () => ({ issue: randomUUID(), run: randomUUID() }));
  const RUN_OLD = randomUUID();
  const RUN_NEW = randomUUID();
  const RUN_NO_ISSUE = randomUUID();
  const RUN_SECRET = randomUUID();
  const RUN_FOREIGN_ISSUE = randomUUID();
  const RUN_DONE = randomUUID();
  const RUN_OTHER_COMPANY = randomUUID();
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-working-now-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: COMPANY, name: "Working Co", issuePrefix: "WRK" },
      { id: OTHER_COMPANY, name: "Other", issuePrefix: "OTR" },
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
      { id: STRANGER, companyId: OTHER_COMPANY, name: "Stranger", role: "engineer" },
    ]);
    await db.insert(projects).values({
      id: SECRET_PROJECT,
      companyId: COMPANY,
      name: "Secret",
      createdByUserId: "owner",
      visibility: "restricted",
    });
    await db.insert(issues).values([
      { id: ISSUE, companyId: COMPANY, title: "Add rate limiting", identifier: "WRK-1", status: "in_progress" },
      { id: SECRET_ISSUE, companyId: COMPANY, projectId: SECRET_PROJECT, title: "Secret work", identifier: "WRK-2", status: "in_progress" },
      { id: OTHER_ISSUE, companyId: OTHER_COMPANY, title: "Not yours", identifier: "OTR-1", status: "in_progress" },
      { id: HIDDEN_ISSUE, companyId: COMPANY, title: "Hidden work", identifier: "WRK-3", status: "in_progress", hiddenAt: new Date() },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: RUN_OLD, companyId: COMPANY, agentId: MAYA, status: "running", startedAt: minutesAgo(30), createdAt: minutesAgo(30), contextSnapshot: { issueId: ISSUE } },
      { id: RUN_NEW, companyId: COMPANY, agentId: MAYA, status: "running", startedAt: minutesAgo(12), createdAt: minutesAgo(12), contextSnapshot: { issueId: ISSUE } },
      { id: RUN_NO_ISSUE, companyId: COMPANY, agentId: PRIYA, status: "queued", createdAt: minutesAgo(1), contextSnapshot: {} },
      { id: RUN_SECRET, companyId: COMPANY, agentId: PRIYA, status: "running", startedAt: minutesAgo(5), createdAt: minutesAgo(5), contextSnapshot: { issueId: SECRET_ISSUE }, nextAction: "Rewriting the secret module" },
      { id: RUN_FOREIGN_ISSUE, companyId: COMPANY, agentId: PRIYA, status: "running", startedAt: minutesAgo(4), createdAt: minutesAgo(4), contextSnapshot: { issueId: OTHER_ISSUE } },
      { id: RUN_DONE, companyId: COMPANY, agentId: MAYA, status: "succeeded", createdAt: minutesAgo(2), contextSnapshot: { issueId: ISSUE } },
      { id: RUN_HIDDEN, companyId: COMPANY, agentId: MAYA, status: "running", startedAt: minutesAgo(3), createdAt: minutesAgo(3), contextSnapshot: { issueId: HIDDEN_ISSUE } },
      { id: RUN_OTHER_COMPANY, companyId: OTHER_COMPANY, agentId: STRANGER, status: "running", createdAt: minutesAgo(3), contextSnapshot: { issueId: OTHER_ISSUE } },
    ]);
    await db.insert(heartbeatRunEvents).values([
      { companyId: COMPANY, runId: RUN_NEW, agentId: MAYA, seq: 1, eventType: "lifecycle", message: "run started" },
      { companyId: COMPANY, runId: RUN_NEW, agentId: MAYA, seq: 2, eventType: "log", message: "Running   the API\ntest suite" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appAs(userId: string, role: string) {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [COMPANY],
        memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
      };
      next();
    });
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("lists one row per live issue with its title, agent, last step and start, plus issue-less runs", async () => {
    const res = await request(appAs("owner", "owner")).get(`/api/companies/${COMPANY}/dashboard/working-now`);
    expect(res.status).toBe(200);
    const byRun = new Map(res.body.items.map((i: { runId: string }) => [i.runId, i]));
    // Two live runs on one issue show once, as the newest.
    expect(byRun.has(RUN_OLD)).toBe(false);
    expect(byRun.get(RUN_NEW)).toMatchObject({
      agent: { id: MAYA, name: "Maya" },
      issue: { id: ISSUE, identifier: "WRK-1", title: "Add rate limiting" },
      lastStep: "Running the API test suite",
    });
    expect(byRun.get(RUN_SECRET)).toMatchObject({ lastStep: "Rewriting the secret module" });
    expect(byRun.get(RUN_NO_ISSUE)).toMatchObject({ issue: null, agent: { name: "Priya" } });
    // Finished runs, other companies' runs, and a run naming another company's issue never show.
    expect(byRun.has(RUN_DONE)).toBe(false);
    expect(byRun.has(RUN_OTHER_COMPANY)).toBe(false);
    expect(byRun.has(RUN_FOREIGN_ISSUE)).toBe(false);
    // A run on a hidden issue is gone, not shown as "outside an issue".
    expect(byRun.has(RUN_HIDDEN)).toBe(false);
    expect(res.body.total).toBe(res.body.items.length);
    expect(res.body.total).toBe(3);
  });

  it("drops a run on a restricted-project issue for a member off its access list", async () => {
    const res = await request(appAs("megan", "member")).get(`/api/companies/${COMPANY}/dashboard/working-now`);
    expect(res.status).toBe(200);
    const runIds = res.body.items.map((i: { runId: string }) => i.runId);
    expect(runIds).not.toContain(RUN_SECRET);
    expect(runIds).toContain(RUN_NEW);
    expect(res.body.total).toBe(2);
  });

  it("returns at most six rows but counts every live issue", async () => {
    const LATER = randomUUID();
    await db.insert(companies).values({ id: LATER, name: "Busy Co", issuePrefix: "BSY" });
    const agent = randomUUID();
    await db.insert(agents).values({ id: agent, companyId: LATER, name: "Busy", role: "engineer" });
    await db.insert(issues).values(
      MANY.map((m, i) => ({ id: m.issue, companyId: LATER, title: `Busy ${i}`, identifier: `BSY-${i}`, status: "in_progress" })),
    );
    await db.insert(heartbeatRuns).values(
      MANY.map((m, i) => ({
        id: m.run,
        companyId: LATER,
        agentId: agent,
        status: "running",
        createdAt: minutesAgo(i + 1),
        contextSnapshot: { issueId: m.issue },
      })),
    );
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "owner", companyIds: [LATER], memberships: [{ companyId: LATER, membershipRole: "owner", status: "active" }] };
      next();
    });
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    const res = await request(app).get(`/api/companies/${LATER}/dashboard/working-now`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.items).toHaveLength(6);
    // Newest first.
    expect(res.body.items.map((i: { issue: { title: string } }) => i.issue.title)).toEqual(
      ["Busy 0", "Busy 1", "Busy 2", "Busy 3", "Busy 4", "Busy 5"],
    );
  });

  it("refuses another company's caller", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "x", companyIds: [OTHER_COMPANY], memberships: [] };
      next();
    });
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    const res = await request(app).get(`/api/companies/${COMPANY}/dashboard/working-now`);
    expect(res.status).toBe(403);
  });
});
