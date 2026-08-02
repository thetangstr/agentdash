import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentDirectives,
  agentGovernancePolicies,
  agentStewardships,
  agents,
  approvals,
  bridgeEndpoints,
  bridgeTasks,
  companies,
  companyMemberships,
  createDb,
  workflowEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentDirectivesRoutes } from "../routes/agent-directives.js";
import { approvalRoutes } from "../routes/approvals.js";
import { workflowMetricsRoutes } from "../routes/workflow-metrics.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { approvalService } from "../services/approvals.js";
import { bridgeService } from "../services/bridge.js";
import { computeRunMetrics, workflowEventsService } from "../services/workflow-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * Anything that names one person, or that names an agent (which is bound 1:1 to
 * a steward and is therefore a person by another name).
 *
 * Used both to inspect the live table's columns and to attempt the violation
 * against the payload.
 */
const PERSON_SUBJECT_COLUMN_PATTERN =
  /(user|actor_id|assignee|principal|steward|member|approver|decided_by|requested_by|answered_by|approved_by|owner_id|email|agent)/i;

/**
 * AgentDash-MK Slice B — the measurement substrate.
 *
 * The instrument that makes the labour curve measurable, and the reason it is
 * safe to run it: **events attach to the pipeline, never to a person as
 * subject.** `actorKind` records what kind of actor, never which one.
 *
 * This is not squeamishness. An agent measuring "efficiency across human-agent
 * workflows" is, from an employee's chair, an agent watching how fast they
 * respond and how much help they needed — the documented task-mining backlash,
 * and the fastest way to lose adoption at the moment the system starts working.
 *
 * So the constraint is enforced the same way Rule B is: structurally. There is
 * no column and no index by which a person could be selected or grouped, and
 * the metrics API has no parameter that would name one. The authorization
 * analogue is exact — `resolveActingAs` does not decline to read directives,
 * there is nothing there to read.
 */
describeEmbeddedPostgres("agentdash-mk workflow events", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-workflow-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(workflowEvents);
        await db.delete(activityLog);
        await db.delete(bridgeTasks);
        await db.delete(bridgeEndpoints);
        await db.delete(approvals);
        await db.delete(agentDirectives);
        await db.delete(agentGovernancePolicies);
        await db.delete(agentStewardships);
        await db.delete(companyMemberships);
        await db.delete(agents);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt >= 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `Measured ${randomUUID()}`,
        issuePrefix: `WE${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);
    const steward = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: {},
        permissions: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    return { company, owner, steward, agent };
  }

  async function seedEndpoint(companyId: string, userId: string, capabilities: string[]) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId,
        label: `Laptop ${randomUUID().slice(0, 6)}`,
        capabilities,
        enrolledAt: new Date(),
        tokenHash: randomUUID(),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function createApp(actor?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    if (actor) {
      app.use((req, _res, next) => {
        (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
        next();
      });
    }
    app.use("/api", agentDirectivesRoutes(db));
    app.use("/api", approvalRoutes(db));
    app.use("/api", workflowMetricsRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, userId: string, role = "owner") {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    };
  }

  async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
    const { createServer } = await import("node:http");
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }

  function eventsFor(companyId: string) {
    return db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.companyId, companyId))
      .orderBy(workflowEvents.occurredAt);
  }

  // -------------------------------------------------------------------------
  // B1 + B4 — every category emits, from the real execution path
  // -------------------------------------------------------------------------

  it("emits approval_requested and approval_decided from the real approvals path", async () => {
    const { company, owner, agent } = await seed();
    const approvals_ = approvalService(db);

    const created = await approvals_.create(company.id, {
      type: "hire_agent",
      requestedByAgentId: agent.id,
      status: "pending",
      payload: { name: "New Agent", role: "general" },
    });

    const requested = await eventsFor(company.id);
    expect(requested.map((row) => row.eventType)).toContain("approval_requested");
    const requestEvent = requested.find((row) => row.eventType === "approval_requested")!;
    expect(requestEvent.actorKind).toBe("agent");
    expect(requestEvent.runId).toBe(created!.id);
    expect(requestEvent.stepKey).toBe("approval");
    expect(requestEvent.pipelineId).toBe("approval:hire_agent");

    await approvals_.approve(created!.id, owner.principalId, "ok");

    const decided = (await eventsFor(company.id)).find(
      (row) => row.eventType === "approval_decided",
    )!;
    expect(decided).toBeDefined();
    // The decider is a named human. What is recorded is that a human decided —
    // never which human.
    expect(decided.actorKind).toBe("human");
    expect(decided.durationMs).not.toBeNull();
    expect(decided.durationMs!).toBeGreaterThanOrEqual(0);
    expect(decided.payload).toMatchObject({ approvalType: "hire_agent", decision: "approved" });
  }, 30_000);

  it("emits the bridge escalation lifecycle from the real bridge service", async () => {
    const { company, steward, agent } = await seed();
    const bridge = bridgeService(db);
    const endpoint = await seedEndpoint(company.id, steward.principalId, ["bridge:read"]);

    const task = await bridge.createTask(company.id, {
      endpointId: endpoint.id,
      requestedByAgentId: agent.id,
      taskClass: "read",
      instruction: "Read the quarterly sheet",
    });

    const opened = (await eventsFor(company.id)).find(
      (row) => row.eventType === "escalation_opened",
    )!;
    expect(opened).toBeDefined();
    expect(opened.actorKind).toBe("agent");
    expect(opened.runId).toBe(task.id);
    expect(opened.stepKey).toBe("escalation");
    expect(opened.pipelineId).toBe("bridge:read");

    const claim = await bridge.claimNextTask(endpoint.id);
    expect(claim).not.toBeNull();
    await bridge.submitResult(endpoint.id, task.id, claim!.resultToken, "42 units");

    const completed = (await eventsFor(company.id)).find(
      (row) => row.eventType === "step_completed",
    )!;
    expect(completed).toBeDefined();
    expect(completed.actorKind).toBe("agent");
    expect(completed.stepKey).toBe("execution");
    expect(completed.durationMs).not.toBeNull();
  }, 30_000);

  it("emits step_failed when an endpoint declines the real task", async () => {
    const { company, steward, agent } = await seed();
    const bridge = bridgeService(db);
    const endpoint = await seedEndpoint(company.id, steward.principalId, ["bridge:read"]);
    const task = await bridge.createTask(company.id, {
      endpointId: endpoint.id,
      requestedByAgentId: agent.id,
      taskClass: "read",
      instruction: "Read the quarterly sheet",
    });
    const claim = await bridge.claimNextTask(endpoint.id);
    await bridge.declineTask(endpoint.id, task.id, claim!.resultToken, "not my machine");

    const failed = (await eventsFor(company.id)).find((row) => row.eventType === "step_failed")!;
    expect(failed).toBeDefined();
    expect(failed.actorKind).toBe("agent");
    expect(failed.runId).toBe(task.id);
  }, 30_000);

  it("emits escalation_expired from the real lease sweep", async () => {
    const { company, steward, agent } = await seed();
    const bridge = bridgeService(db);
    const endpoint = await seedEndpoint(company.id, steward.principalId, ["bridge:read"]);
    const task = await bridge.createTask(company.id, {
      endpointId: endpoint.id,
      requestedByAgentId: agent.id,
      taskClass: "read",
      instruction: "Read the quarterly sheet",
    });
    await bridge.claimNextTask(endpoint.id);
    // Drive the lease into the past rather than waiting ten minutes; the sweep
    // itself is the real code path under test.
    await db
      .update(bridgeTasks)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000), requeueCount: "1" })
      .where(eq(bridgeTasks.id, task.id));

    await bridge.sweepLapsedLeases();

    const expired = (await eventsFor(company.id)).find(
      (row) => row.eventType === "escalation_expired",
    )!;
    expect(expired).toBeDefined();
    expect(expired.actorKind).toBe("system");
    expect(expired.runId).toBe(task.id);
    expect(expired.durationMs).not.toBeNull();
  }, 30_000);

  it("emits correction_recorded from the real directive push route", async () => {
    const { company, steward, agent } = await seed();
    const app = createApp(boardActor(company.id, steward.principalId, "operator"));

    const response = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agents/${agent.id}/directives`)
        .send({ directives: "Always cite the source sheet." }),
    );
    expect(response.status).toBe(201);

    const correction = (await eventsFor(company.id)).find(
      (row) => row.eventType === "correction_recorded",
    )!;
    expect(correction).toBeDefined();
    expect(correction.actorKind).toBe("human");
    expect(correction.stepKey).toBe("operating_directives");
    expect(correction.payload).toMatchObject({ version: 1 });
  }, 30_000);

  it("defines fact_asked and fact_answered so slice C plugs in without reshaping the schema", async () => {
    const { company } = await seed();
    const events = workflowEventsService(db);
    await events.emit({
      companyId: company.id,
      pipelineId: "deliverable:weekly-report",
      runId: randomUUID(),
      stepKey: "headcount",
      eventType: "fact_asked",
      actorKind: "agent",
      payload: { factKey: "headcount" },
    });
    const rows = await eventsFor(company.id);
    expect(rows.map((row) => row.eventType)).toEqual(["fact_asked"]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // B2 — the four metrics
  // -------------------------------------------------------------------------

  it("computes the four per-run metrics over a mixed run", () => {
    const occurredAt = (offsetMs: number) => new Date(Date.UTC(2026, 7, 2) + offsetMs);
    const metrics = computeRunMetrics([
      {
        stepKey: "escalation",
        eventType: "escalation_opened",
        actorKind: "agent",
        durationMs: null,
        payload: {},
        occurredAt: occurredAt(0),
      },
      {
        stepKey: "approval",
        eventType: "approval_requested",
        actorKind: "agent",
        durationMs: null,
        payload: {},
        occurredAt: occurredAt(1_000),
      },
      {
        stepKey: "approval",
        eventType: "approval_decided",
        actorKind: "human",
        durationMs: 12 * 60_000,
        payload: { decision: "approved" },
        occurredAt: occurredAt(12 * 60_000),
      },
      {
        stepKey: "headcount",
        eventType: "correction_recorded",
        actorKind: "human",
        durationMs: null,
        payload: {},
        occurredAt: occurredAt(13 * 60_000),
      },
      {
        stepKey: "headcount",
        eventType: "correction_recorded",
        actorKind: "human",
        durationMs: null,
        payload: {},
        occurredAt: occurredAt(14 * 60_000),
      },
      {
        stepKey: "execution",
        eventType: "step_completed",
        actorKind: "agent",
        durationMs: 3 * 60_000,
        payload: {},
        occurredAt: occurredAt(18 * 60_000),
      },
    ]);

    expect(metrics.humanReviewMinutes).toBeCloseTo(12, 5);
    expect(metrics.stepsCompleted).toBe(2);
    expect(metrics.stepsCompletedWithoutHumanTouch).toBe(1);
    expect(metrics.percentStepsCompletedWithoutHumanTouch).toBeCloseTo(50, 5);
    expect(metrics.correctionCountByStep).toEqual({ headcount: 2 });
    expect(metrics.escalationStall.openEscalations).toBe(0);
    expect(metrics.escalationStall.totalMs).toBe(3 * 60_000);
    expect(metrics.escalationStall.maxMs).toBe(3 * 60_000);
  });

  it("returns per-run metrics from the real HTTP route", async () => {
    const { company, owner, agent } = await seed();
    const approvals_ = approvalService(db);
    const created = await approvals_.create(company.id, {
      type: "hire_agent",
      requestedByAgentId: agent.id,
      status: "pending",
      payload: { name: "New Agent", role: "general" },
    });
    await approvals_.approve(created!.id, owner.principalId, "ok");

    const app = createApp(boardActor(company.id, owner.principalId));
    const response = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/workflow-runs/${created!.id}/metrics`),
    );

    expect(response.status).toBe(200);
    expect(response.body.runId).toBe(created!.id);
    expect(response.body.pipelineId).toBe("approval:hire_agent");
    expect(response.body.stepsCompleted).toBe(1);
    expect(response.body.stepsCompletedWithoutHumanTouch).toBe(0);
    expect(response.body.percentStepsCompletedWithoutHumanTouch).toBe(0);
    expect(typeof response.body.humanReviewMinutes).toBe("number");
  }, 30_000);

  /**
   * The whole point of the run correlation: a bridge `act` task is one run with
   * three steps and two kinds of actor, so the untouched-step ratio is a real
   * fraction rather than a constant. If the approval were filed as its own run,
   * every bridge run would read 100% untouched and every approval run 0%, and
   * the headline metric would be meaningless while still looking fine.
   */
  it("measures one bridge act task as a single mixed run across escalation, approval, and execution", async () => {
    const { company, owner, steward, agent } = await seed();
    const bridge = bridgeService(db);
    const approvals_ = approvalService(db);
    const endpoint = await seedEndpoint(company.id, steward.principalId, [
      "bridge:read",
      "bridge:act",
    ]);

    const task = await bridge.createTask(company.id, {
      endpointId: endpoint.id,
      requestedByAgentId: agent.id,
      taskClass: "act",
      instruction: "File the expense report",
    });

    const gating = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, company.id))
      .then((rows) => rows[0]!);
    await approvals_.approve(gating.id, owner.principalId, "go ahead");
    await bridge.releaseApprovedTask(gating.id);

    const claim = await bridge.claimNextTask(endpoint.id);
    expect(claim).not.toBeNull();
    await bridge.submitResult(endpoint.id, task.id, claim!.resultToken, "filed");

    const rows = await eventsFor(company.id);
    // Every event of this task's life carries the same runId.
    expect(new Set(rows.map((row) => row.runId))).toEqual(new Set([task.id]));
    expect(rows.map((row) => row.eventType).sort()).toEqual([
      "approval_decided",
      "approval_requested",
      "escalation_opened",
      "step_completed",
    ]);

    const app = createApp(boardActor(company.id, owner.principalId));
    const response = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/workflow-runs/${task.id}/metrics`),
    );
    expect(response.status).toBe(200);
    expect(response.body.pipelineId).toBe("bridge:act");
    // `approval` needed a human; `execution` did not.
    expect(response.body.stepsCompleted).toBe(2);
    expect(response.body.stepsCompletedWithoutHumanTouch).toBe(1);
    expect(response.body.percentStepsCompletedWithoutHumanTouch).toBe(50);
    expect(response.body.escalationStall.openEscalations).toBe(0);
    expect(response.body.escalationStall.totalMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("404s the metrics route outside the agentdash_mk profile", async () => {
    const { company, owner } = await seed("default");
    const app = createApp(boardActor(company.id, owner.principalId));
    const response = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/workflow-runs/${randomUUID()}/metrics`),
    );
    expect(response.status).toBe(404);
  }, 30_000);

  it("leaves default-profile companies unmeasured", async () => {
    const { company, owner, agent } = await seed("default");
    const approvals_ = approvalService(db);
    const created = await approvals_.create(company.id, {
      type: "hire_agent",
      requestedByAgentId: agent.id,
      status: "pending",
      payload: { name: "New Agent", role: "general" },
    });
    await approvals_.approve(created!.id, owner.principalId, "ok");
    expect(await eventsFor(company.id)).toEqual([]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // B3 — adversarial. These tests exist to FAIL when someone later makes the
  // table able to name a person. That is their whole purpose.
  // -------------------------------------------------------------------------

  it("has no column that identifies an individual as the measured subject", async () => {
    // Read the LIVE table, not the drizzle object: a column added by a
    // hand-authored migration must fail this too.
    const columns = await db.execute(sql`
      select column_name
      from information_schema.columns
      where table_name = 'workflow_events'
    `);
    const names = (columns as unknown as Array<{ column_name: string }>).map(
      (row) => row.column_name,
    );

    expect(names).toContain("actor_kind");
    expect(names.length).toBeGreaterThan(5);

    const offending = names.filter((name) => PERSON_SUBJECT_COLUMN_PATTERN.test(name));
    expect(
      offending,
      "a workflow_events column names an individual (or an agent, which is one steward by another name) as the measured subject",
    ).toEqual([]);
  }, 30_000);

  it("has no index by which events could be grouped per person", async () => {
    const indexes = await db.execute(sql`
      select indexdef from pg_indexes where tablename = 'workflow_events'
    `);
    const defs = (indexes as unknown as Array<{ indexdef: string }>).map((row) => row.indexdef);
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const indexedColumns = def.slice(def.lastIndexOf("(") + 1, def.lastIndexOf(")"));
      expect(
        PERSON_SUBJECT_COLUMN_PATTERN.test(indexedColumns),
        `index would make per-person grouping cheap: ${def}`,
      ).toBe(false);
    }
  }, 30_000);

  it("rejects a payload that smuggles a person through the service", async () => {
    const { company } = await seed();
    const events = workflowEventsService(db);
    // The rejection is reported, not thrown: measurement must never be able to
    // fail the operation it is measuring. It is still loud — the result says so
    // and the service logs at error level.
    const result = await events.emit({
      companyId: company.id,
      pipelineId: "deliverable:weekly-report",
      runId: randomUUID(),
      stepKey: "headcount",
      eventType: "fact_asked",
      actorKind: "agent",
      payload: { factKey: "headcount", userId: randomUUID() } as Record<string, unknown>,
    });
    expect(result).toEqual({ recorded: false, rejectedBecause: "payload_rejected" });
    expect(await eventsFor(company.id)).toEqual([]);
  }, 30_000);

  it("records nothing and reports the rejection when an emission is malformed", async () => {
    const { company } = await seed();
    const events = workflowEventsService(db);
    const result = await events.emit({
      companyId: company.id,
      pipelineId: "deliverable:weekly-report",
      runId: randomUUID(),
      stepKey: "headcount",
      // A duration derived from a missing timestamp used to arrive as NaN and
      // throw straight out through the approval decision that emitted it.
      durationMs: Number.NaN,
      eventType: "fact_asked",
      actorKind: "agent",
      payload: { factKey: "headcount" },
    });
    expect(result).toEqual({ recorded: false, rejectedBecause: "invalid_emission" });
    expect(await eventsFor(company.id)).toEqual([]);
  }, 30_000);

  it("rejects a person-bearing payload at the database, bypassing the service entirely", async () => {
    const { company } = await seed();
    // The service allowlist is the primary gate; this constraint is what holds
    // when a future slice, a migration, or a psql session writes directly.
    await expect(
      db.insert(workflowEvents).values({
        companyId: company.id,
        pipelineId: "deliverable:weekly-report",
        runId: randomUUID(),
        stepKey: "headcount",
        eventType: "fact_answered",
        actorKind: "human",
        payload: { answeredByUserId: randomUUID() },
      }),
    ).rejects.toThrow();

    // Nested, because a check that only looks at top-level keys is a check
    // someone routes around in one line.
    await expect(
      db.insert(workflowEvents).values({
        companyId: company.id,
        pipelineId: "deliverable:weekly-report",
        runId: randomUUID(),
        stepKey: "headcount",
        eventType: "fact_answered",
        actorKind: "human",
        payload: { source: { userId: randomUUID() } },
      }),
    ).rejects.toThrow();

    expect(await eventsFor(company.id)).toEqual([]);
  }, 30_000);

  it("rejects an agent identifier in the payload, because an agent is one steward by another name", async () => {
    const { company, agent } = await seed();
    await expect(
      db.insert(workflowEvents).values({
        companyId: company.id,
        pipelineId: "deliverable:weekly-report",
        runId: randomUUID(),
        stepKey: "headcount",
        eventType: "fact_answered",
        actorKind: "agent",
        payload: { agentId: agent.id },
      }),
    ).rejects.toThrow();
  }, 30_000);

  it("exposes no metrics surface that can return a per-person aggregate", async () => {
    const { company, owner, agent } = await seed();
    const approvals_ = approvalService(db);
    const created = await approvals_.create(company.id, {
      type: "hire_agent",
      requestedByAgentId: agent.id,
      status: "pending",
      payload: { name: "New Agent", role: "general" },
    });
    await approvals_.approve(created!.id, owner.principalId, "ok");

    const app = createApp(boardActor(company.id, owner.principalId));

    // 1. The route accepts no person parameter. A query string naming one is
    //    ignored, not honoured — the response is byte-identical.
    const plain = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/workflow-runs/${created!.id}/metrics`),
    );
    const withPerson = await call(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/companies/${company.id}/workflow-runs/${created!.id}/metrics`)
        .query({ userId: owner.principalId, decidedByUserId: owner.principalId }),
    );
    expect(withPerson.status).toBe(200);
    expect(withPerson.body).toEqual(plain.body);

    // 2. Nothing in the response names anyone.
    const serialized = JSON.stringify(plain.body);
    expect(serialized).not.toContain(owner.principalId);
    expect(serialized).not.toContain(agent.id);
    for (const key of Object.keys(plain.body)) {
      expect(
        PERSON_SUBJECT_COLUMN_PATTERN.test(key),
        `metrics response key "${key}" names an individual`,
      ).toBe(false);
    }

    // 3. The service exports no function whose name offers a per-person cut.
    const surface = Object.keys(workflowEventsService(db));
    for (const name of surface) {
      expect(
        /byUser|perUser|forUser|byPerson|byActor|byAgent/i.test(name),
        `workflow-events service exposes a per-person cut: ${name}`,
      ).toBe(false);
    }
  }, 30_000);

  it("cannot be asked for a per-person aggregate even in SQL, because there is nothing to group by", async () => {
    const { company, owner, agent } = await seed();
    const approvals_ = approvalService(db);
    const created = await approvals_.create(company.id, {
      type: "hire_agent",
      requestedByAgentId: agent.id,
      status: "pending",
      payload: { name: "New Agent", role: "general" },
    });
    await approvals_.approve(created!.id, owner.principalId, "ok");

    // The attempt an operator would actually make. It must fail as a schema
    // error, not return an empty result — an empty result would mean the column
    // exists and happens to be null.
    await expect(
      db.execute(sql`
        select decided_by_user_id, count(*)
        from workflow_events
        where company_id = ${company.id}
        group by decided_by_user_id
      `),
    ).rejects.toThrow();

    // And the rows that DO exist contain no person anywhere in them.
    const rows = await eventsFor(company.id);
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(owner.principalId);
    expect(dump).not.toContain(agent.id);
  }, 30_000);
});
