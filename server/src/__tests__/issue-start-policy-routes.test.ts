import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { needsTriageOwner } from "../services/issue-start-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: the status contract — `backlog` parks work, `todo` starts it.
 * A `todo` with nobody assigned has nobody to start it (MK, 2026-09: a
 * board-created issue waited six days), so it is handed to the Chief of Staff.
 * These tests pin both halves: unowned todo is routed, and nothing else is
 * touched.
 */
describe("needsTriageOwner", () => {
  it("is true only for unowned todo", () => {
    expect(needsTriageOwner({ status: "todo" })).toBe(true);
    expect(needsTriageOwner({ status: "backlog" })).toBe(false);
    expect(needsTriageOwner({ status: "in_progress" })).toBe(false);
    expect(needsTriageOwner({ status: "todo", assigneeAgentId: "a" })).toBe(false);
    expect(needsTriageOwner({ status: "todo", assigneeUserId: "u" })).toBe(false);
  });
});

describeEmbeddedPostgres("unowned todo is routed to the Chief of Staff", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const NO_COS_COMPANY = randomUUID();
  const START_NOW_COMPANY = randomUUID();
  // Paused, so the assignment wake is recorded but no run is started: these
  // tests are about who owns the issue, not about executing it.
  const COS = randomUUID();
  const RETIRED_COS = randomUUID();
  const WORKER = randomUUID();
  const START_NOW_COS = randomUUID();
  const START_NOW_WORKER = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unowned-todo-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: COMPANY, name: "Routing Co", issuePrefix: "RTE" },
      { id: NO_COS_COMPANY, name: "No CoS Co", issuePrefix: "NCS" },
      { id: START_NOW_COMPANY, name: "Start Now Co", issuePrefix: "SNW", newIssuesStartAsTodo: true },
    ]);
    for (const companyId of [COMPANY, NO_COS_COMPANY, START_NOW_COMPANY]) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "owner",
        status: "active",
        membershipRole: "owner",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "user",
        principalId: "owner",
        permissionKey: "tasks:assign",
      });
    }
    await db.insert(agents).values([
      // canCreateAgents grants legacy assign authority, so the CoS itself
      // would pass the routing permission check.
      {
        id: COS,
        companyId: COMPANY,
        name: "Casper",
        role: "chief_of_staff",
        status: "paused",
        permissions: { canCreateAgents: true },
      },
      { id: WORKER, companyId: COMPANY, name: "Hal", role: "general", status: "paused" },
      // A retired CoS in the other company must not be picked.
      { id: RETIRED_COS, companyId: NO_COS_COMPANY, name: "Old CoS", role: "chief_of_staff", status: "terminated" },
      { id: START_NOW_COS, companyId: START_NOW_COMPANY, name: "Cass", role: "chief_of_staff", status: "paused" },
      { id: START_NOW_WORKER, companyId: START_NOW_COMPANY, name: "Wes", role: "general", status: "paused" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardActor(companyId: string, userId = "owner", membershipRole = "owner"): Record<string, unknown> {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
    };
  }

  function app(companyId = COMPANY, actor: Record<string, unknown> = boardActor(companyId)) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    server.use("/api", issueRoutes(db, {} as never));
    server.use(errorHandler);
    return server;
  }

  it("assigns an unowned todo to the Chief of Staff and records why", async () => {
    const res = await request(app()).post(`/api/companies/${COMPANY}/issues`).send({ title: "Weekly status", status: "todo" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(COS);

    const [created] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.created")));
    expect(created!.details).toMatchObject({ routedToChiefOfStaff: COS });
  });

  it("leaves backlog unowned: parked work is not routed", async () => {
    const res = await request(app()).post(`/api/companies/${COMPANY}/issues`).send({ title: "Someday", status: "backlog" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("leaves the default (backlog) unowned when no status is sent", async () => {
    const res = await request(app()).post(`/api/companies/${COMPANY}/issues`).send({ title: "No status given" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("backlog");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("never overrides an explicit agent or human assignee", async () => {
    const toAgent = await request(app())
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "For Hal", status: "todo", assigneeAgentId: WORKER });
    expect(toAgent.body.assigneeAgentId).toBe(WORKER);

    const toHuman = await request(app())
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "For me", status: "todo", assigneeUserId: "owner" });
    expect(toHuman.status).toBe(201);
    expect(toHuman.body.assigneeAgentId).toBeNull();
    expect(toHuman.body.assigneeUserId).toBe("owner");
  });

  it("routes an unowned todo child issue the same way", async () => {
    const parent = await request(app()).post(`/api/companies/${COMPANY}/issues`).send({ title: "Parent", status: "backlog" });
    const child = await request(app()).post(`/api/issues/${parent.body.id}/children`).send({ title: "Child", status: "todo" });
    expect(child.status).toBe(201);
    expect(child.body.assigneeAgentId).toBe(COS);
  });

  it("creates the issue unowned when the only Chief of Staff is retired", async () => {
    const res = await request(app(NO_COS_COMPANY))
      .post(`/api/companies/${NO_COS_COMPANY}/issues`)
      .send({ title: "Nobody to route to", status: "todo" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBeNull();
    const [row] = await db.select().from(issues).where(eq(issues.id, res.body.id));
    expect(row!.assigneeAgentId).toBeNull();
  });

  describe("with the company setting 'start new issues right away' on", () => {
    it("starts an issue with no status as todo", async () => {
      const res = await request(app(START_NOW_COMPANY))
        .post(`/api/companies/${START_NOW_COMPANY}/issues`)
        .send({ title: "Just do it", assigneeAgentId: START_NOW_WORKER });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("todo");
      expect(res.body.assigneeAgentId).toBe(START_NOW_WORKER);
    });

    it("routes an unowned, status-less issue to the Chief of Staff", async () => {
      const res = await request(app(START_NOW_COMPANY))
        .post(`/api/companies/${START_NOW_COMPANY}/issues`)
        .send({ title: "Whoever" });
      expect(res.body.status).toBe("todo");
      expect(res.body.assigneeAgentId).toBe(START_NOW_COS);
    });

    it("still honours an explicit backlog", async () => {
      const res = await request(app(START_NOW_COMPANY))
        .post(`/api/companies/${START_NOW_COMPANY}/issues`)
        .send({ title: "Park this", status: "backlog", assigneeAgentId: START_NOW_WORKER });
      expect(res.body.status).toBe("backlog");
    });

    it("applies to child issues too", async () => {
      const parent = await request(app(START_NOW_COMPANY))
        .post(`/api/companies/${START_NOW_COMPANY}/issues`)
        .send({ title: "Parent", status: "backlog" });
      const child = await request(app(START_NOW_COMPANY))
        .post(`/api/issues/${parent.body.id}/children`)
        .send({ title: "Child", assigneeAgentId: START_NOW_WORKER });
      expect(child.status).toBe(201);
      expect(child.body.status).toBe("todo");
    });
  });

  /**
   * Routing assigns the CoS and wakes it with text the creator wrote, so it
   * takes the same authority as naming an assignee yourself.
   */
  it("does not route for a creator without tasks:assign", async () => {
    // Human members hold tasks:assign through their role; a worker agent
    // without a grant does not, so it cannot wake the CoS this way.
    const res = await request(app(COMPANY, { type: "agent", agentId: WORKER, companyId: COMPANY, source: "agent_key" }))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "From someone who cannot assign", status: "todo" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("never routes a Chief of Staff's own unassigned todo back to it", async () => {
    const res = await request(
      app(COMPANY, { type: "agent", agentId: COS, companyId: COMPANY, source: "agent_key" }),
    )
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Filed by the CoS, to delegate later", status: "todo" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBeNull();
  });
});
