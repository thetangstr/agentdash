import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentCorrections,
  agentRuns,
  agents,
  authUsers,
  bridgeEndpoints,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueReviewQueueState,
  issues,
  issueThreadInteractions,
  principalPermissionGrants,
  projectAccess,
  projects,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { isDeliveredToRequester } from "../services/steward-request-scope.js";
import {
  CHANGE_REQUEST_COMMENT_PREFIX,
  HIDDEN_AGENT_LABEL,
  composeRequestDescription,
  parseDeadline,
  waitedInWords,
} from "../services/steward-requests.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * AgentDash-MK: the person's own Claude asks someone else for work, and closes
 * it out when the result comes back (co-worker slice 4).
 *
 * Properties defended, each against a real Postgres:
 *
 * - intake creates nothing until the handle is spent, then creates the issue
 *   as the requester, assigned to the person, routed to that person's agent,
 *   which is woken; the handle is single-use and authority is re-checked;
 * - the requester reads their request (issue, comments, documents) and not
 *   the counterpart's other work, run logs, parent or children;
 * - "your requests" says where each one is stuck and for how long, computed
 *   on the server;
 * - accept marks it done as the requester; a change request comments as the
 *   requester, reopens it, hands it to the deliverable owner's agent, wakes
 *   that agent with the comment, and records the correction signal.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

/**
 * An adapter that renders the wake payload and succeeds without spawning
 * anything, so a test can run an agent and read the context it was given.
 * Corrections are handed only to an adapter that renders them.
 */
const RENDERING_ADAPTER = "requests_rendering_test";
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describe("request helpers", () => {
  it("says how long in words a person uses", () => {
    expect(waitedInWords(10_000)).toBe("less than a minute");
    expect(waitedInWords(60_000)).toBe("1 minute");
    expect(waitedInWords(15 * 60_000)).toBe("15 minutes");
    expect(waitedInWords(3 * 3_600_000)).toBe("3 hours");
    expect(waitedInWords(47 * 3_600_000)).toBe("47 hours");
    expect(waitedInWords(2 * 86_400_000 + 5_000)).toBe("2 days");
  });

  it("takes a deadline as a real calendar date only", () => {
    expect(parseDeadline(undefined)).toEqual({ ok: true, date: null });
    expect(parseDeadline("2026-10-20")).toEqual({ ok: true, date: "2026-10-20" });
    expect(parseDeadline("2026-02-30")).toEqual({ ok: false });
    expect(parseDeadline("next Friday")).toEqual({ ok: false });
  });

  it("writes the brief as a description the agent reads first", () => {
    const text = composeRequestDescription({
      requesterName: "Person A",
      wanted: "A one-page note.",
      doneMeans: "Reviewed by Person B.",
      forWhom: "the ops lead",
      deadline: "2026-10-20",
    });
    expect(text).toContain("Requested by Person A, for the ops lead.");
    expect(text).toContain("Deadline: 2026-10-20");
    expect(text).toContain("## What is wanted\n\nA one-page note.");
    expect(text).toContain("## What done means\n\nReviewed by Person B.");
  });

  it("counts a result in review as delivered only when the requester is the reviewer", () => {
    const requester = { userId: "user-a", agentIds: ["agent-a"] };
    const inReview = { status: "in_review", assigneeUserId: null, assigneeAgentId: "agent-b" };
    // Agent B's draft in its own person's review: not the requester's yet.
    expect(isDeliveredToRequester(inReview, requester)).toBe(false);
    // Handed to the requester, or held by an agent the requester answers for.
    expect(isDeliveredToRequester({ ...inReview, assigneeAgentId: null, assigneeUserId: "user-a" }, requester)).toBe(true);
    expect(isDeliveredToRequester({ ...inReview, assigneeAgentId: "agent-a" }, requester)).toBe(true);
    // The execution policy names the requester as the review's participant.
    expect(
      isDeliveredToRequester(
        { ...inReview, executionState: { currentStageId: "s1", currentParticipant: { type: "user", userId: "user-a" } } },
        requester,
      ),
    ).toBe(true);
    expect(
      isDeliveredToRequester(
        {
          ...inReview,
          executionPolicy: { stages: [{ id: "s1", participants: [{ id: "p1", type: "user", userId: "user-a" }] }] },
          executionState: { currentStageId: "s1", currentParticipant: { type: "user", userId: "user-b" } },
        },
        requester,
      ),
    ).toBe(true);
    expect(
      isDeliveredToRequester(
        { ...inReview, executionState: { currentStageId: "s1", currentParticipant: { type: "user", userId: "user-b" } } },
        requester,
      ),
    ).toBe(false);
    // Done is delivered whoever holds it; cancelled never is.
    expect(isDeliveredToRequester({ ...inReview, status: "done" }, requester)).toBe(true);
    expect(isDeliveredToRequester({ ...inReview, status: "cancelled", assigneeUserId: "user-a" }, requester)).toBe(false);
  });
});

describeEmbeddedPostgres("bridge requests: asking another person for work, and closing it out", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridge-requests-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: RENDERING_ADAPTER,
      rendersAgentCorrections: true,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({ adapterType: RENDERING_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    unregisterServerAdapter(RENDERING_ADAPTER);
    await tempDb?.cleanup();
  });

  /** Run the agent once on the rendering adapter and return the context its adapter was invoked with. */
  async function runAgent(agentId: string) {
    await db.update(agents).set({ adapterType: RENDERING_ADAPTER, adapterConfig: {}, runtimeConfig: {} }).where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const deadline = Date.now() + 20_000;
    let finished = await heartbeat.getRun(queued!.id);
    while (Date.now() < deadline && finished && ["queued", "running"].includes(finished.status)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      finished = await heartbeat.getRun(queued!.id);
    }
    // Let the run's metering land before the table is truncated.
    const meterDeadline = Date.now() + 10_000;
    while (Date.now() < meterDeadline) {
      const metered = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.heartbeatRunId, queued!.id));
      if (metered.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { run: finished, context: (finished?.contextSnapshot ?? {}) as Record<string, any> };
  }

  /** A member; every member role carries tasks:assign, a membership with no role carries nothing. */
  async function person(companyId: string, role: string | null, name: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    return userId;
  }

  async function stewardedAgent(companyId: string, name: string, stewardUserId: string, ownerUserId: string) {
    const agent = await db
      .insert(agents)
      .values({ companyId, name, role: "general", status: "idle", adapterType: "process" })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(companyId, { agentId: agent.id, userId: stewardUserId, assignedByUserId: ownerUserId });
    return agent;
  }

  /** Person A (the requester) stewards Agent A; Person B stewards Agent B; Person C stewards Agent C. */
  async function seed(opts: { flag?: boolean; requesterCanAssign?: boolean } = {}) {
    const prefix = `RQ${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z]/g, "X")}`;
    const company = await db
      .insert(companies)
      .values({ name: `Requests ${randomUUID()}`, issuePrefix: prefix, productProfile: "agentdash_mk" })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await person(company.id, "owner", "Owner O");
    const personA = await person(company.id, opts.requesterCanAssign === false ? null : "operator", "Person A");
    const personB = await person(company.id, "operator", "Person B");
    const personC = await person(company.id, "operator", "Person C");
    const agentA = await stewardedAgent(company.id, "Agent A", personA, owner);
    const agentB = await stewardedAgent(company.id, "Agent B", personB, owner);
    const agentC = await stewardedAgent(company.id, "Agent C", personC, owner);
    if (opts.flag !== false) await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, true);
    return { company, prefix, owner, personA, personB, personC, agentA, agentB, agentC };
  }

  async function endpointFor(companyId: string, userId: string, capabilities = ["bridge:read", "bridge:inbox", "bridge:work"]) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId,
        label: `laptop-${randomUUID().slice(0, 8)}`,
        tokenHash: `hash-${randomUUID()}`,
        capabilities,
        enrolledAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  // Above the numbers the issue service gives the requests it creates.
  let issueCounter = 9_000;
  async function makeIssue(companyId: string, prefix: string, values: Partial<typeof issues.$inferInsert>) {
    issueCounter += 1;
    return db
      .insert(issues)
      .values({ companyId, title: "Draft the quarterly note", status: "todo", identifier: `${prefix}-${issueCounter}`, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  function runtime() {
    return {
      wakeup: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
      reportRunActivity: vi.fn(async () => undefined),
    };
  }

  function app(endpoint: { id: string; companyId: string }, rt = runtime()) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "none",
        source: "bridge_endpoint",
        companyId: endpoint.companyId,
        bridgeEndpointId: endpoint.id,
      };
      next();
    });
    server.use("/api", bridgeRoutes(db, { autoDispatchQueuedRuns: false, issueRuntime: rt as never }));
    server.use(errorHandler);
    return { server, rt };
  }

  const brief = {
    title: "Draft the vendor summary",
    wanted: "A one-page summary of the three vendor proposals.",
    doneMeans: "A document on the issue with a recommendation, reviewed by Person B.",
    deadline: "2026-10-20",
    forWhom: "the ops lead",
    person: "Person B",
  };

  /** Propose and confirm a request from Person A for Person B; returns the created issue. */
  async function requestOfPersonB(server: express.Express) {
    const proposed = await request(server).post("/api/bridge/work/request").send(brief);
    expect(proposed.body.ok).toBe(true);
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body.ok).toBe(true);
    const issue = await db.select().from(issues).where(eq(issues.id, confirmed.body.issue.issueId)).then((rows) => rows[0]!);
    return { proposed, confirmed, issue };
  }

  // -----------------------------------------------------------------------
  // Gates
  // -----------------------------------------------------------------------

  it("refuses an endpoint without bridge:work with 403 on every request route", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA, ["bridge:read", "bridge:inbox"]);
    const { server } = app(endpoint);
    for (const [route, body] of [
      ["request", brief],
      ["request/respond", { issueId: "RQ-1", action: "accept" }],
      ["request/confirm", { token: "x" }],
    ] as const) {
      const res = await request(server).post(`/api/bridge/work/${route}`).send(body);
      expect(res.status, route).toBe(403);
      expect(res.body.error, route).toContain("bridge:work");
    }
  });

  it("refuses with the reason while the company flag is off, and creates nothing", async () => {
    const { company, personA } = await seed({ flag: false });
    const endpoint = await endpointFor(company.id, personA);
    const res = await request(app(endpoint).server).post("/api/bridge/work/request").send(brief);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, code: "coworker_bridge_disabled" });
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Intake
  // -----------------------------------------------------------------------

  it("reads the brief back without creating anything, then creates it as the requester routed to the person's agent", async () => {
    const { company, personA, personB, agentB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server, rt } = app(endpoint);

    const proposed = await request(server).post("/api/bridge/work/request").send(brief);
    expect(proposed.body).toMatchObject({
      ok: true,
      brief: {
        title: brief.title,
        wanted: brief.wanted,
        doneMeans: brief.doneMeans,
        deadline: "2026-10-20",
        forWhom: "the ops lead",
        person: "Person B",
        project: null,
      },
    });
    expect(proposed.body.goesTo).toContain("Agent B, Person B's agent");
    expect(proposed.body.visibility).toMatch(/Everyone in the company/);
    expect(proposed.body.readback.join("\n")).toContain("Sent as you.");
    expect(typeof proposed.body.handle).toBe("string");
    // Nothing yet.
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
    expect(rt.wakeup).not.toHaveBeenCalled();

    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({
      ok: true,
      kind: "request_work",
      assignedTo: { kind: "agent", name: "Agent B", forPerson: "Person B" },
    });
    const issue = await db.select().from(issues).where(eq(issues.id, confirmed.body.issue.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject({
      title: brief.title,
      status: "todo",
      createdByUserId: personA,
      createdByAgentId: null,
      assigneeAgentId: agentB.id,
      assigneeUserId: null,
    });
    expect(issue.description).toContain("Requested by Person A, for the ops lead.");
    expect(issue.description).toContain("## What done means");

    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    const created = rows.find((row) => row.action === "issue.created")!;
    expect(created).toMatchObject({ actorType: "user", actorId: personA });
    expect(created.details).toMatchObject({
      routedToStewardedAgent: { fromUserId: personB, toAgentId: agentB.id },
      channel: "bridge_work",
      bridgeEndpointId: endpoint.id,
      endpointLabel: endpoint.label,
    });
    expect(rows.find((row) => row.action === "bridge.work_requested")?.details).toMatchObject({
      requestedForUserId: personB,
      deadline: "2026-10-20",
    });

    // The person's agent is woken, with the steward context the routing gives.
    expect(rt.wakeup).toHaveBeenCalledTimes(1);
    expect(rt.wakeup).toHaveBeenCalledWith(
      agentB.id,
      expect.objectContaining({
        reason: "issue_assigned",
        contextSnapshot: expect.objectContaining({ issueId: issue.id, routedFromStewardUserId: personB }),
      }),
    );

    // Single use.
    const again = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(again.body).toMatchObject({ ok: false, code: "handle_invalid" });
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
  });

  it("keeps the request with the person when their agent cannot take work", async () => {
    const { company, personA, personB, agentB } = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentB.id));
    const endpoint = await endpointFor(company.id, personA);
    const { server, rt } = app(endpoint);
    const { proposed, issue } = await requestOfPersonB(server);
    expect(proposed.body.goesTo).toContain("stays with them");
    expect(issue).toMatchObject({ assigneeUserId: personB, assigneeAgentId: null });
    expect(rt.wakeup).not.toHaveBeenCalled();
  });

  it("asks rather than guesses, and refuses an incomplete brief, a bad date, files, or the requester themself", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const post = (body: Record<string, unknown>) => request(server).post("/api/bridge/work/request").send(body);

    const unknown = await post({ ...brief, person: "Persn B" });
    expect(unknown.body).toMatchObject({ ok: false, code: "unknown_person" });
    expect(unknown.body.didYouMean).toContain("Person B");
    expect(unknown.body.handle).toBeUndefined();

    expect((await post({ ...brief, doneMeans: "" })).body).toMatchObject({ ok: false, code: "incomplete_brief" });
    expect((await post({ ...brief, deadline: "next Friday" })).body).toMatchObject({ ok: false, code: "bad_deadline" });
    expect((await post({ ...brief, files: [{ name: "a.csv" }] })).body).toMatchObject({ ok: false, code: "files_not_supported_yet" });
    expect((await post({ ...brief, person: "Person A" })).body).toMatchObject({ ok: false, code: "that_is_you" });
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
  });

  it("needs the page's authority to assign: refused at propose, and re-checked when the handle is spent", async () => {
    const { company, personA } = await seed({ requesterCanAssign: false });
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const refused = await request(server).post("/api/bridge/work/request").send(brief);
    expect(refused.body).toMatchObject({ ok: false, code: "not_permitted" });

    const grant = await db
      .insert(principalPermissionGrants)
      .values({ companyId: company.id, principalType: "user", principalId: personA, permissionKey: "tasks:assign" })
      .returning()
      .then((rows) => rows[0]!);
    const proposed = await request(server).post("/api/bridge/work/request").send(brief);
    expect(proposed.body.ok).toBe(true);
    // Authority withdrawn between the read-back and the go.
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: false, code: "not_permitted" });
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
  });

  it("refuses a restricted project the person is not on", async () => {
    const { company, personA, agentA } = await seed();
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Restricted work", visibility: "restricted", createdByUserId: personA })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(projectAccess).values({
      companyId: company.id,
      projectId: project.id,
      principalType: "user",
      principalId: personA,
      grantedByUserId: personA,
    });
    await db.insert(projectAccess).values({
      companyId: company.id,
      projectId: project.id,
      principalType: "agent",
      principalId: agentA.id,
      grantedByUserId: personA,
    });
    const endpoint = await endpointFor(company.id, personA);
    const res = await request(app(endpoint).server).post("/api/bridge/work/request").send({ ...brief, project: "Restricted work" });
    expect(res.body).toMatchObject({ ok: false, code: "project_hidden_from_person" });
  });

  // -----------------------------------------------------------------------
  // Reading a request: the issue itself, not the counterpart's other work
  // -----------------------------------------------------------------------

  it("lets the requester read their request, narrowed, and nothing else of the person's", async () => {
    const { company, prefix, personA, personB, agentB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorAgentId: agentB.id, body: "First draft attached." });
    const child = await makeIssue(company.id, prefix, { parentId: issue.id, assigneeAgentId: agentB.id, title: "Agent B's sub-task" });
    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agentB.id,
      status: "succeeded",
      contextSnapshot: { issueId: issue.id },
    });

    const read = await request(server).post("/api/bridge/work/read").send({ issueId: issue.identifier });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, scope: "request", parent: null, request: null, children: null });
    expect(read.body.yourRequest).toMatchObject({ delivered: false });
    expect(read.body.comments.items[0].body.text).toContain("First draft attached.");

    // Not the counterpart's run logs, nor their other work.
    expect((await request(server).post("/api/bridge/work/run-log").send({ issueId: issue.id })).status).toBe(404);
    expect((await request(server).post("/api/bridge/work/read").send({ issueId: child.id })).status).toBe(404);
    const unrelated = await makeIssue(company.id, prefix, { assigneeAgentId: agentB.id, createdByUserId: personB, title: "Person B's own work" });
    expect((await request(server).post("/api/bridge/work/read").send({ issueId: unrelated.id })).status).toBe(404);
    const unrelatedPerson = await makeIssue(company.id, prefix, { assigneeUserId: personB, title: "Assigned to Person B by someone else" });
    expect((await request(server).post("/api/bridge/work/read").send({ issueId: unrelatedPerson.id })).status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Your requests: where each one is stuck, for how long
  // -----------------------------------------------------------------------

  it("lists your requests with who it waits on and for how long, computed on the server", async () => {
    const { company, prefix, personA, agentB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    // Agent B asked Person B a question two days ago.
    const question = await issueThreadInteractionService(db).create(
      issue,
      {
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, questions: [{ id: "q", prompt: "Which vendors?", selectionMode: "text", options: [] }] },
      } as never,
      { agentId: agentB.id },
    );
    await db
      .update(issueThreadInteractions)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000 - 60_000) })
      .where(eq(issueThreadInteractions.id, (question as { id: string }).id));
    // Not a request: Person A's own agent's work.
    await makeIssue(company.id, prefix, { createdByUserId: personA, title: "Own work" });

    const res = await request(server).post("/api/bridge/work/list").send({});
    expect(res.body.ok).toBe(true);
    expect(res.body.requests).toMatchObject({ total: 1, delivered: { total: 0 }, waiting: { total: 1 } });
    expect(res.body.requests.waiting.items[0]).toMatchObject({
      issueId: issue.id,
      requestedOf: "Person B",
      delivered: false,
      waitingOn: { kind: "person", name: "Person B", why: "agent_question" },
      summary: "waiting on Person B for 2 days (Agent B asked them a question)",
    });
    expect(res.body.requests.waiting.items[0].waitedSeconds).toBeGreaterThanOrEqual(2 * 86_400);
  });

  it("adds a pointer-only Your requests section to the session-start digest", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));

    const res = await request(server).post("/api/bridge/inbox/sync").send({ includeDigest: true });
    expect(res.body.digest.requests).toMatchObject({ total: 1, delivered: 1, waiting: 0, shown: 1 });
    const pointer = res.body.digest.requests.items[0];
    expect(pointer).toMatchObject({ issueId: issue.id, identifier: issue.identifier, delivered: true });
    expect(pointer.summary).toMatch(/^done .* ago; accept it or ask for changes$/);
    // Pointers only: never the brief.
    expect(JSON.stringify(res.body.digest.requests)).not.toContain(brief.wanted);

    // No section for an inbox-only machine.
    const inboxOnly = await endpointFor(company.id, personA, ["bridge:read", "bridge:inbox"]);
    const plain = await request(app(inboxOnly).server).post("/api/bridge/inbox/sync").send({ includeDigest: true });
    expect(plain.body.digest.requests).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Close-out
  // -----------------------------------------------------------------------

  it("refuses to close out a result that has not been delivered", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    const res = await request(server).post("/api/bridge/work/request/respond").send({ issueId: issue.id, action: "accept" });
    expect(res.body).toMatchObject({ ok: false, code: "not_delivered" });
    expect(res.body.handle).toBeUndefined();
  });

  it("accepts a result in review with the requester as done, as the requester, and takes it off the list and the review queue", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    // Person B finished it and handed it to the requester for review; the
    // page's in_review hook put it in the review queue.
    await db
      .update(issues)
      .set({ status: "in_review", assigneeAgentId: null, assigneeUserId: personA })
      .where(eq(issues.id, issue.id));
    await db.insert(issueReviewQueueState).values({
      issueId: issue.id,
      companyId: company.id,
      escalateAfter: new Date(Date.now() + 60_000),
    });

    const proposed = await request(server).post("/api/bridge/work/request/respond").send({ issueId: issue.id, action: "accept" });
    expect(proposed.body.ok).toBe(true);
    expect(proposed.body.readback.join(" ")).toContain("moves from in_review to done");
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe("in_review");

    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, kind: "request_accept", issue: { status: "done" } });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe("done");
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(rows.find((row) => row.action === "bridge.work_request_accepted")).toMatchObject({ actorType: "user", actorId: personA });
    expect(rows.find((row) => row.action === "issue.updated" && (row.details as any)?.status === "done")?.details).toMatchObject({
      channel: "bridge_work",
    });

    const list = await request(server).post("/api/bridge/work/list").send({});
    expect(list.body.requests.total).toBe(0);

    // The page's status hook ran: a finished issue leaves the review queue,
    // so the review cycle never escalates it.
    expect(await db.select().from(issueReviewQueueState).where(eq(issueReviewQueueState.issueId, issue.id))).toHaveLength(0);
  });

  it("does not count an agent's draft in its own person's review as delivered: refused, and listed as waiting on that person", async () => {
    const { company, personA, agentB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    // Agent B handed its draft to Person B, its steward, for review.
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issue.id));
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.assigneeAgentId).toBe(agentB.id);

    const respond = await request(server).post("/api/bridge/work/request/respond").send({ issueId: issue.id, action: "accept" });
    expect(respond.body).toMatchObject({ ok: false, code: "not_delivered" });
    expect(respond.body.reason).toContain("in review with Person B");
    expect(respond.body.handle).toBeUndefined();
    const changes = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.id, action: "changes", note: "Shorter, please." });
    expect(changes.body).toMatchObject({ ok: false, code: "not_delivered" });

    const list = await request(server).post("/api/bridge/work/list").send({});
    expect(list.body.requests).toMatchObject({ delivered: { total: 0 }, waiting: { total: 1 } });
    expect(list.body.requests.waiting.items[0]).toMatchObject({
      issueId: issue.id,
      delivered: false,
      waitingOn: { kind: "person", name: "Person B", why: "steward_review" },
    });
    expect(list.body.requests.waiting.items[0].summary).toMatch(/^waiting on Person B for .+ \(Agent B's draft is in their review\)$/);

    const read = await request(server).post("/api/bridge/work/read").send({ issueId: issue.id });
    expect(read.body.yourRequest).toMatchObject({ delivered: false });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe("in_review");
  });

  it("refuses a change request on an issue whose isolated workspace is closed, as the page does", async () => {
    const { company, personA, personB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Open work", createdByUserId: personB })
      .returning()
      .then((rows) => rows[0]!);
    const workspace = await db
      .insert(executionWorkspaces)
      .values({
        companyId: company.id,
        projectId: project.id,
        sourceIssueId: issue.id,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Closed workspace",
        status: "archived",
        closedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), executionWorkspaceId: workspace.id })
      .where(eq(issues.id, issue.id));

    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.id, action: "changes", note: "Add the third vendor's pricing." });
    expect(proposed.body.ok).toBe(true);
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: false, code: "refused" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!.status).toBe("done");
  });

  it("never names an agent the requester cannot see as the one taking the changes", async () => {
    const { company, prefix, personA, agentC } = await seed();
    await db.update(companies).set({ agentVisibilityDefault: "owner" }).where(eq(companies.id, company.id));
    // Person A's request, now with Agent C, whom Person A cannot see; no record of whom it was asked of.
    const issue = await makeIssue(company.id, prefix, {
      createdByUserId: personA,
      assigneeAgentId: agentC.id,
      status: "done",
      completedAt: new Date(),
    });
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);

    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.id, action: "changes", note: "Add the totals." });
    expect(proposed.body).toMatchObject({ ok: true, handTo: HIDDEN_AGENT_LABEL });
    expect(JSON.stringify(proposed.body)).not.toContain("Agent C");
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, kind: "request_changes", handedTo: { kind: "agent", name: null } });
    expect(JSON.stringify(confirmed.body)).not.toContain("Agent C");
  });

  it("sends changes on work assigned to a person on the page back to that person, not to their agent", async () => {
    const { company, prefix, personA, personB } = await seed();
    // Assigned to Person B on the page and kept with them: no routing was recorded.
    const issue = await makeIssue(company.id, prefix, {
      createdByUserId: personA,
      assigneeUserId: personB,
      status: "done",
      completedAt: new Date(),
    });
    const endpoint = await endpointFor(company.id, personA);
    const { server, rt } = app(endpoint);

    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.id, action: "changes", note: "Add the totals." });
    expect(proposed.body).toMatchObject({ ok: true, handTo: "Person B" });
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, kind: "request_changes", handedTo: { kind: "person", name: "Person B" } });
    const after = (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
    expect(after).toMatchObject({ status: "todo", assigneeUserId: personB, assigneeAgentId: null });
    expect(rt.wakeup).not.toHaveBeenCalled();
  });

  it("sends a change request to the deliverable owner's agent, wakes it with the comment, and records the correction", async () => {
    const { company, personA, agentB, agentC } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server, rt } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    // Agent B handed it to Agent C, who finished it.
    await db
      .update(issues)
      .set({ assigneeAgentId: agentC.id, status: "done", completedAt: new Date() })
      .where(eq(issues.id, issue.id));
    rt.wakeup.mockClear();

    const listed = await request(server).post("/api/bridge/work/list").send({});
    expect(listed.body.requests.delivered.items[0]).toMatchObject({ issueId: issue.id, delivered: true });

    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.identifier, action: "changes", note: "Add the third vendor's pricing." });
    expect(proposed.body).toMatchObject({ ok: true, handTo: "Agent B, Person B's agent" });
    expect(proposed.body.comment).toBe(`${CHANGE_REQUEST_COMMENT_PREFIX}\n\nAdd the third vendor's pricing.`);
    expect(proposed.body.readback.join("\n")).toContain("Reopen it to todo and hand it to Agent B");

    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, kind: "request_changes", handedTo: { kind: "agent", name: "Agent B" } });

    const after = (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
    expect(after).toMatchObject({ status: "todo", assigneeAgentId: agentB.id, assigneeUserId: null });
    const comment = (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)))[0]!;
    expect(comment).toMatchObject({ authorUserId: personA, authorAgentId: null, body: proposed.body.comment });

    // Agent B is woken once, with the requester's comment as the wake comment.
    const agentBWakes = rt.wakeup.mock.calls.filter((call) => (call as unknown[])[0] === agentB.id);
    expect(agentBWakes).toHaveLength(1);
    expect((agentBWakes[0] as unknown[])[1]).toMatchObject({ contextSnapshot: expect.objectContaining({ wakeCommentId: comment.id }) });
    expect(rt.wakeup.mock.calls.some((call) => (call as unknown[])[0] === agentC.id)).toBe(false);

    const correction = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.requester_changes_requested")))
      .then((rows) => rows[0]);
    expect(correction).toMatchObject({ actorType: "user", actorId: personA, agentId: agentB.id });
    expect(correction?.details).toMatchObject({
      correction: "requester_change_request",
      deliverableOwnerAgentId: agentB.id,
      commentId: comment.id,
      previousStatus: "done",
      previousAssigneeAgentId: agentC.id,
      channel: "bridge_work",
    });
  });

  it("carries the requester's change request to the owning agent's next wake as a what-changed summary", async () => {
    const { company, personA, agentB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));

    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.identifier, action: "changes", note: "Add the third vendor's pricing." });
    expect(proposed.body.ok).toBe(true);
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: true, kind: "request_changes" });

    const recorded = await db
      .select()
      .from(agentCorrections)
      .where(and(eq(agentCorrections.agentId, agentB.id), eq(agentCorrections.kind, "requester_change_request")));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ issueId: issue.id, sourceActorType: "user", sourceActorId: personA });

    const { run, context } = await runAgent(agentB.id);
    expect(run?.status).toBe("succeeded");
    const delivered = (context.paperclipWake?.corrections ?? []) as Array<{ kind: string; summary: string }>;
    // One summary for one change request: the reopen it implies is not a second correction.
    expect(delivered.map((entry) => entry.kind)).toEqual(["requester_change_request"]);
    const change = delivered.find((entry) => entry.kind === "requester_change_request");
    expect(change?.summary).toBe(
      `Person A, who requested this work, asked for changes to the result on ${issue.identifier}.\nWhat they asked for: "Add the third vendor's pricing."`,
    );
  }, 60_000);

  it("records no correction for a change request while the co-worker loop is off for the agent's company", async () => {
    const { company, personA, agentB } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));
    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.identifier, action: "changes", note: "Shorter, please." });
    expect(proposed.body.ok).toBe(true);
    // Switched off between the read-back and the yes: the confirm refuses, and nothing is recorded.
    await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, false);
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body.ok).toBe(false);
    expect(await db.select().from(agentCorrections).where(eq(agentCorrections.agentId, agentB.id))).toHaveLength(0);
  });

  it("refuses a close-out whose request moved on after the read-back", async () => {
    const { company, personA } = await seed();
    const endpoint = await endpointFor(company.id, personA);
    const { server } = app(endpoint);
    const { issue } = await requestOfPersonB(server);
    await db
      .update(issues)
      .set({ status: "in_review", assigneeAgentId: null, assigneeUserId: personA })
      .where(eq(issues.id, issue.id));
    const proposed = await request(server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.id, action: "changes", note: "Shorter, please." });
    expect(proposed.body.ok).toBe(true);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id));
    const confirmed = await request(server).post("/api/bridge/work/request/confirm").send({ token: proposed.body.handle });
    expect(confirmed.body).toMatchObject({ ok: false, code: "moved_on" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
  });

  it("will not close out someone else's request", async () => {
    const { company, personA, personC } = await seed();
    const endpointA = await endpointFor(company.id, personA);
    const { issue } = await requestOfPersonB(app(endpointA).server);
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue.id));
    const endpointC = await endpointFor(company.id, personC);
    const res = await request(app(endpointC).server)
      .post("/api/bridge/work/request/respond")
      .send({ issueId: issue.id, action: "accept" });
    expect(res.status).toBe(404);
  });
});
