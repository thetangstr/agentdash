import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  principalPermissionGrants,
  projectAccess,
  projects,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const FROM = "2026-04-10T10:00:00.000Z";
const TO = "2026-04-10T11:00:00.000Z";
const INSIDE = "2026-04-10T10:30:00.000Z";
const BEFORE = "2026-04-10T09:00:00.000Z";
const AFTER = "2026-04-10T12:00:00.000Z";

async function createCompany(db: TestDb) {
  return db
    .insert(companies)
    .values({
      name: `Run window ${randomUUID()}`,
      issuePrefix: `RW${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: TestDb,
  companyId: string,
  name = "Travel Agent",
  extra: { visibility?: "company" | "owner" } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      ...(extra.visibility ? { visibility: extra.visibility } : {}),
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssue(db: TestDb, companyId: string, assigneeAgentId: string | null, title = "Window issue") {
  const company = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .then((rows) => rows[0]!);
  const issueNumber = Math.floor(Math.random() * 1_000_000);
  return db
    .insert(issues)
    .values({
      companyId,
      title,
      status: "todo",
      priority: "medium",
      assigneeAgentId,
      issueNumber,
      identifier: `${company.issuePrefix}-${issueNumber}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

function boardActor(companyId: string) {
  return {
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function otherCompanyBoardActor(companyId: string) {
  return {
    type: "board",
    userId: "board-user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function memberActor(companyId: string) {
  return {
    type: "board",
    userId: "plain-member",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "member", status: "active" }],
  };
}

function agentActor(agentId: string, companyId: string) {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    companyIds: [companyId],
  };
}

function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

function runWindowQuery(agentId: string) {
  return `/api/agents/${agentId}/run-window?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
}

describeEmbeddedPostgres("GET /agents/:id/run-window", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-window-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("returns the run, the comment-triggered wake, a timer wake, and the issue comment inside the window", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const issue = await createIssue(db, company.id, agent.id);

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        startedAt: new Date(INSIDE),
        finishedAt: new Date("2026-04-10T10:45:00.000Z"),
        createdAt: new Date(INSIDE),
        logSha256: "abc123",
        logBytes: 512,
        contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_commented" },
      })
      .returning();

    const [commentWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        status: "finished",
        runId: run.id,
        payload: { issueId: issue.id, commentId: "comment-1" },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
        requestedAt: new Date(INSIDE),
        finishedAt: new Date("2026-04-10T10:35:00.000Z"),
      })
      .returning();

    const [timerWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "timer",
        reason: "heartbeat_timer",
        status: "skipped",
        requestedAt: new Date("2026-04-10T10:40:00.000Z"),
      })
      .returning();

    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: issue.id,
        authorUserId: "user-1",
        body: "Did the pairing run?",
        createdAt: new Date(INSIDE),
      })
      .returning();

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agentId).toBe(agent.id);
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.from).toBe(FROM);
    expect(res.body.to).toBe(TO);

    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({
      id: run.id,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      error: null,
      errorCode: null,
      issueId: issue.id,
      taskId: issue.id,
      logSha256: "abc123",
      logBytes: 512,
    });

    expect(res.body.wakes).toHaveLength(2);
    const wakeById = new Map(res.body.wakes.map((w: { id: string }) => [w.id, w]));
    expect(wakeById.get(commentWake.id)).toMatchObject({
      source: "automation",
      reason: "issue_commented",
      status: "finished",
      runId: run.id,
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      payload: { issueId: issue.id, commentId: "comment-1" },
    });
    expect(wakeById.get(timerWake.id)).toMatchObject({
      source: "timer",
      reason: "heartbeat_timer",
      status: "skipped",
    });

    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0]).toMatchObject({
      id: comment.id,
      issueId: issue.id,
      authorUserId: "user-1",
      body: "Did the pairing run?",
    });
  });

  it("excludes rows outside the window, other agents' rows, and comments on unassigned issues", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, company.id, "Other Agent");
    const issue = await createIssue(db, company.id, agent.id);
    const otherIssue = await createIssue(db, company.id, otherAgent.id, "Other issue");

    // In-window row that must appear.
    const [inRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        createdAt: new Date(INSIDE),
      })
      .returning();

    // Outside the window / wrong agent — all must be excluded. The "before"
    // run needs finishedAt before `from`: under overlap semantics a run with
    // finishedAt null is still running and DOES intersect the window.
    await db.insert(heartbeatRuns).values([
      {
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        createdAt: new Date(BEFORE),
        finishedAt: new Date("2026-04-10T09:30:00.000Z"),
      },
      { companyId: company.id, agentId: agent.id, status: "succeeded", createdAt: new Date(AFTER) },
      { companyId: company.id, agentId: otherAgent.id, status: "succeeded", createdAt: new Date(INSIDE) },
    ]);

    const [inWake] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        reason: "issue_commented",
        requestedAt: new Date(INSIDE),
      })
      .returning();
    await db.insert(agentWakeupRequests).values([
      {
        // Same overlap semantics as runs: a wake requested before `from` with
        // finishedAt null is still pending and DOES intersect the window —
        // exclude it by finishing it before `from`.
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        requestedAt: new Date(BEFORE),
        finishedAt: new Date("2026-04-10T09:30:00.000Z"),
      },
      {
        companyId: company.id,
        agentId: otherAgent.id,
        source: "timer",
        requestedAt: new Date(INSIDE),
      },
    ]);

    const [inComment] = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: issue.id,
        authorUserId: "user-1",
        body: "inside",
        createdAt: new Date(INSIDE),
      })
      .returning();
    await db.insert(issueComments).values([
      // Before the window on the assigned issue.
      { companyId: company.id, issueId: issue.id, body: "outside", createdAt: new Date(BEFORE) },
      // Inside the window but on an issue assigned to a different agent.
      { companyId: company.id, issueId: otherIssue.id, body: "wrong issue", createdAt: new Date(INSIDE) },
    ]);

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([inRun.id]);
    expect(res.body.wakes.map((w: { id: string }) => w.id)).toEqual([inWake.id]);
    expect(res.body.comments.map((c: { id: string }) => c.id)).toEqual([inComment.id]);
  });

  it("returns empty arrays when nothing matches", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      agentId: agent.id,
      companyId: company.id,
      runs: [],
      wakes: [],
      comments: [],
    });
  });

  it("rejects missing or invalid from/to with 400", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const app = createApp(db, boardActor(company.id));

    for (const query of [
      `/api/agents/${agent.id}/run-window`,
      `/api/agents/${agent.id}/run-window?from=${encodeURIComponent(FROM)}`,
      `/api/agents/${agent.id}/run-window?to=${encodeURIComponent(TO)}`,
      `/api/agents/${agent.id}/run-window?from=nope&to=${encodeURIComponent(TO)}`,
      `/api/agents/${agent.id}/run-window?from=${encodeURIComponent(FROM)}&to=also-nope`,
      `/api/agents/${agent.id}/run-window?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`,
    ]) {
      const res = await request(app).get(query);
      expect(res.status, `${query} -> ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it("denies a board actor that lacks membership in the agent's company", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const res = await request(createApp(db, otherCompanyBoardActor(otherCompany.id))).get(
      runWindowQuery(agent.id),
    );

    expect(res.status).toBe(403);
  });

  it("returns runs in every status", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const statuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

    for (const [index, status] of statuses.entries()) {
      await db.insert(heartbeatRuns).values({
        companyId: company.id,
        agentId: agent.id,
        status,
        error: status === "failed" ? "boom" : null,
        createdAt: new Date(Date.parse(INSIDE) + index * 1000),
      });
    }

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runs).toHaveLength(statuses.length);
    expect(res.body.runs.map((r: { status: string }) => r.status).sort()).toEqual(
      [...statuses].sort(),
    );
  });

  it("includes runs whose lifetime overlaps the window even when created before it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    // Created before the window and still running — must appear.
    const [stillRunning] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        createdAt: new Date(BEFORE),
        startedAt: new Date(BEFORE),
      })
      .returning();

    // Created before the window, finishes inside it — must appear.
    const [finishesInside] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        createdAt: new Date(BEFORE),
        startedAt: new Date(BEFORE),
        finishedAt: new Date(INSIDE),
      })
      .returning();

    // Created before the window and finishes after it (spans it) — must appear.
    const [spansWindow] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "succeeded",
        createdAt: new Date(BEFORE),
        startedAt: new Date(BEFORE),
        finishedAt: new Date(AFTER),
      })
      .returning();

    // Finished before the window opened — must NOT appear.
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "succeeded",
      createdAt: new Date("2026-04-10T08:00:00.000Z"),
      finishedAt: new Date("2026-04-10T09:30:00.000Z"),
    });

    // Created after the window closed — must NOT appear.
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "queued",
      createdAt: new Date(AFTER),
    });

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id).sort()).toEqual(
      [stillRunning.id, finishesInside.id, spansWindow.id].sort(),
    );
  });

  // N11-7: wakes use the same lifetime overlap as runs — a deferred wake
  // requested before `from` but promoted/refused inside the window (or still
  // pending across the boundary) must appear.
  it("includes wakes whose lifetime overlaps the window even when requested before it", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const [pendingAcrossBoundary] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        reason: "issue_commented",
        status: "deferred",
        requestedAt: new Date(BEFORE),
        finishedAt: null,
      })
      .returning();
    const [refusedInside] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "on_demand",
        reason: "travel_pairing.wake_source",
        status: "skipped",
        requestedAt: new Date(BEFORE),
        finishedAt: new Date(INSIDE),
      })
      .returning();
    const [finishedBefore] = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: company.id,
        agentId: agent.id,
        source: "timer",
        reason: "heartbeat_timer",
        status: "finished",
        requestedAt: new Date(BEFORE),
        finishedAt: new Date(BEFORE),
      })
      .returning();

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.wakes.map((w: { id: string }) => w.id).sort();
    expect(ids).toEqual([pendingAcrossBoundary.id, refusedInside.id].sort());
    expect(ids).not.toContain(finishedBefore.id);
  });

  it("includes comments the agent authored and comments created by its runs, each only once", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, company.id, "Other Agent");
    const assignedIssue = await createIssue(db, company.id, agent.id);
    const otherIssue = await createIssue(db, company.id, otherAgent.id, "Not assigned to agent");

    // A run that started before the window and is still going — its comments
    // inside the window belong to this agent even though the run predates it.
    const [agentRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        createdAt: new Date(BEFORE),
        startedAt: new Date(BEFORE),
      })
      .returning();
    const [otherRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: otherAgent.id,
        status: "succeeded",
        createdAt: new Date(INSIDE),
        finishedAt: new Date(INSIDE),
      })
      .returning();

    // Lane (a): authored by the agent on an issue assigned to someone else.
    const [authored] = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: otherIssue.id,
        authorAgentId: agent.id,
        body: "authored by the agent",
        createdAt: new Date(INSIDE),
      })
      .returning();

    // Lane (b): created by one of the agent's runs, no author agent.
    const [runComment] = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: otherIssue.id,
        createdByRunId: agentRun.id,
        body: "written by the agent's run",
        createdAt: new Date(INSIDE),
      })
      .returning();

    // Qualifies under all three lanes — must appear exactly once.
    const [tripleLane] = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: assignedIssue.id,
        authorAgentId: agent.id,
        createdByRunId: agentRun.id,
        body: "assigned issue + authored + run",
        createdAt: new Date(INSIDE),
      })
      .returning();

    // Noise: another agent's run commented on the other issue inside the window.
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: otherIssue.id,
      authorAgentId: otherAgent.id,
      createdByRunId: otherRun.id,
      body: "nothing to do with our agent",
      createdAt: new Date(INSIDE),
    });

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.comments.map((c: { id: string }) => c.id) as string[];
    expect([...ids].sort()).toEqual([authored.id, runComment.id, tripleLane.id].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  // N11-6 MEDIUM-3: issues assigned to the agent at ANY point — the wake
  // history is append-only, so a reassigned issue's in-window comments are
  // still part of the agent's observable surface.
  it("includes in-window comments on issues the agent was previously woken for", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, company.id, "Other Agent");
    // The issue is now assigned to someone else — a current-assignee-only
    // query would miss its comments.
    const reassignedIssue = await createIssue(db, company.id, otherAgent.id, "Was ours once");
    const strangerIssue = await createIssue(db, company.id, null, "Never touched");

    // An old assignment wake — before the window — carrying the issue id.
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "assignment",
      reason: "issue_assigned",
      status: "finished",
      payload: { issueId: reassignedIssue.id },
      requestedAt: new Date(BEFORE),
      finishedAt: new Date(BEFORE),
    });
    // Another agent's wake on the stranger issue must NOT pull it in.
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: otherAgent.id,
      source: "assignment",
      reason: "issue_assigned",
      status: "finished",
      payload: { issueId: strangerIssue.id },
      requestedAt: new Date(BEFORE),
    });

    const [oldAssigneeComment] = await db
      .insert(issueComments)
      .values({
        companyId: company.id,
        issueId: reassignedIssue.id,
        authorUserId: "user-1",
        body: "progress on the reassigned issue?",
        createdAt: new Date(INSIDE),
      })
      .returning();
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: strangerIssue.id,
      authorUserId: "user-1",
      body: "unrelated issue comment",
      createdAt: new Date(INSIDE),
    });

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.comments.map((c: { id: string }) => c.id);
    expect(ids).toEqual([oldAssigneeComment.id]);
  });

  it("refuses agent-authenticated callers with 403", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const res = await request(createApp(db, agentActor(agent.id, company.id))).get(
      runWindowQuery(agent.id),
    );

    expect(res.status).toBe(403);
  });

  it("reports truncated: false when no list hits the cap", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.truncated).toBe(false);
  });

  it("caps each list at 2000 rows and reports truncated: true", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    await db.insert(agentWakeupRequests).values(
      Array.from({ length: 2001 }, (_, i) => ({
        companyId: company.id,
        agentId: agent.id,
        source: "timer",
        reason: "heartbeat_timer",
        requestedAt: new Date(Date.parse(FROM) + i * 1000),
      })),
    );

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.wakes).toHaveLength(2000);
    expect(res.body.truncated).toBe(true);
  });

  it("rejects a window wider than 7 days or of zero length with 400", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const app = createApp(db, boardActor(company.id));

    for (const [from, to] of [
      ["2026-04-01T00:00:00.000Z", "2026-04-08T00:00:01.000Z"],
      [FROM, FROM],
      ["2026-04-10", TO],
      ["1712743200000", TO],
    ]) {
      const res = await request(app).get(
        `/api/agents/${agent.id}/run-window?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      expect(res.status, `${from}..${to} -> ${JSON.stringify(res.body)}`).toBe(400);
    }

    const exactlySevenDays = await request(app).get(
      `/api/agents/${agent.id}/run-window?from=${encodeURIComponent("2026-04-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-04-08T00:00:00.000Z")}`,
    );
    expect(exactlySevenDays.status, JSON.stringify(exactlySevenDays.body)).toBe(200);
  });

  it("refuses a company member without agent-management permission with 403", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);

    const res = await request(createApp(db, memberActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status).toBe(403);
  });

  it("answers 404 to a member who cannot see an owner-only agent", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Private Agent", { visibility: "owner" });

    const res = await request(createApp(db, memberActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status).toBe(404);
  });

  it("never returns another company's rows for the same window", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const otherCompany = await createCompany(db);
    const otherAgent = await createAgent(db, otherCompany.id, "Other Agent");
    await db.insert(agentWakeupRequests).values({
      companyId: otherCompany.id,
      agentId: otherAgent.id,
      source: "timer",
      reason: "heartbeat_timer",
      requestedAt: new Date(INSIDE),
    });

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.wakes).toHaveLength(0);

    // A board user of the first company asking for the other company's agent.
    const crossCompany = await request(createApp(db, otherCompanyBoardActor(company.id))).get(
      runWindowQuery(otherAgent.id),
    );
    expect([403, 404]).toContain(crossCompany.status);
  });

  it("redacts secret-looking keys in wake payloads but keeps the refusal shape", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const retryOfRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      triggerDetail: "system",
      reason: "travel_pairing.wake_source",
      status: "skipped",
      payload: { refusedReason: "missing_issue_comment", retryOfRunId, apiKey: "sk-should-not-leak" },
      requestedAt: new Date(INSIDE),
      finishedAt: new Date(INSIDE),
    });

    const res = await request(createApp(db, boardActor(company.id))).get(runWindowQuery(agent.id));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.wakes).toHaveLength(1);
    expect(res.body.wakes[0]).toMatchObject({
      reason: "travel_pairing.wake_source",
      status: "skipped",
      runId: null,
      payload: { refusedReason: "missing_issue_comment", retryOfRunId },
    });
    expect(JSON.stringify(res.body)).not.toContain("sk-should-not-leak");
  });

  it("hides runs, wakes and comments on a restricted project from a granted member off its access list", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id);
    const [restricted] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Secret project", status: "in_progress", visibility: "restricted" })
      .returning();
    const openIssue = await createIssue(db, company.id, agent.id, "Open issue");
    const secretIssue = await createIssue(db, company.id, agent.id, "Secret issue");
    await db.update(issues).set({ projectId: restricted!.id }).where(sql`${issues.id} = ${secretIssue.id}`);

    for (const issue of [openIssue, secretIssue]) {
      await db.insert(heartbeatRuns).values({
        companyId: company.id,
        agentId: agent.id,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: new Date(INSIDE),
        finishedAt: new Date(INSIDE),
        error: `error for ${issue.title}`,
        contextSnapshot: { issueId: issue.id, taskId: issue.id },
      });
      await db.insert(agentWakeupRequests).values({
        companyId: company.id,
        agentId: agent.id,
        source: "assignment",
        reason: "issue_assigned",
        status: "finished",
        payload: { issueId: issue.id },
        requestedAt: new Date(INSIDE),
        finishedAt: new Date(INSIDE),
      });
      await db.insert(issueComments).values({
        companyId: company.id,
        issueId: issue.id,
        authorUserId: "someone",
        body: `body of ${issue.title}`,
        createdAt: new Date(INSIDE),
      });
    }

    // A plain member holding an explicit agents:create grant — not an admin,
    // so restricted-project rules apply to them.
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "plain-member",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: "plain-member",
      permissionKey: "agents:create",
    });

    const hidden = await request(createApp(db, memberActor(company.id))).get(runWindowQuery(agent.id));
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect(hidden.body.runs.map((r: { issueId: string }) => r.issueId)).toEqual([openIssue.id]);
    expect(hidden.body.wakes.map((w: { payload: { issueId: string } }) => w.payload.issueId)).toEqual([openIssue.id]);
    expect(hidden.body.comments.map((c: { issueId: string }) => c.issueId)).toEqual([openIssue.id]);
    expect(JSON.stringify(hidden.body)).not.toContain("Secret issue");

    // Once listed on the project, the member sees all of it.
    await db.insert(projectAccess).values({
      projectId: restricted!.id,
      principalType: "user",
      principalId: "plain-member",
      grantedByUserId: "local-board",
    });
    const listed = await request(createApp(db, memberActor(company.id))).get(runWindowQuery(agent.id));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.runs).toHaveLength(2);
    expect(listed.body.wakes).toHaveLength(2);
    expect(listed.body.comments).toHaveLength(2);
  });
});
