// AgentDash (OBS-2): an agent that wakes itself through POST
// /agents/:id/wakeup or /heartbeat/invoke is unattended spend. Over its daily
// token ceiling the wake is skipped, and the route tells the agent so — with
// the reason and when the pause lifts, never the ceiling's figures — instead
// of a bare "skipped" it would retry at the end of every run. A person's wake
// through the same routes still runs.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import {
  agentApiKeys,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_DAILY_TOKENS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { requestActorSourceMiddleware } from "../lib/request-actor-source.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

function boardActor(companyId: string) {
  return {
    type: "board",
    userId: "board-owner",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  };
}

/** The issue routes' owner: the local implicit board owner, a company member. */
function ownerActor(companyId: string) {
  return { type: "board", source: "local_implicit", userId: "owner", companyIds: [companyId] };
}

function agentActor(agentId: string, companyId: string) {
  // keyId: the issue routes check the agent's API key row is live.
  return { type: "agent", agentId, companyId, source: "agent_key", keyId: agentKeyIds.get(agentId), companyIds: [companyId] };
}

const agentKeyIds = new Map<string, string>();

describeEmbeddedPostgres("agent wakeup routes over the daily token ceiling", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-ceiling-routes-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    // Let any dispatched run settle before the teardown truncates under it.
    await waitFor(async () => {
      const live = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      return live.length === 0;
    }, 10_000).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use(requestActorSourceMiddleware());
    app.use("/api", issueRoutes(db, {} as any));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ceiling Route Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "owner",
      status: "active",
      membershipRole: "owner",
    });
    const agentId = await seedAgentIn(companyId, "Looper");
    return { companyId, agentId };
  }

  async function seedAgentIn(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      // canCreateAgents carries the legacy tasks:assign authority.
      permissions: { canCreateAgents: true },
    });
    const keyId = randomUUID();
    await db.insert(agentApiKeys).values({ id: keyId, agentId, companyId, name: "test", keyHash: `unused-${keyId}` });
    agentKeyIds.set(agentId, keyId);
    return agentId;
  }

  /** Today's metered spend at the default ceiling — OBS-1's finalized shape. */
  async function spendTheDay(companyId: string, agentId: string, tokens = AGENT_DEFAULT_MAX_DAILY_TOKENS) {
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      resultJson: {
        runFacts: {
          meteringStatus: "metered",
          inputTokens: tokens,
          cachedInputTokens: null,
          outputTokens: 0,
          outcome: "no_op",
          wakeReason: "agent_requested",
        },
      },
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    });
  }

  async function ceilingSkips(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "skipped"),
          eq(agentWakeupRequests.reason, "token_ceiling"),
        ),
      );
  }

  function expectCeilingRefusal(body: Record<string, unknown>) {
    expect(body.status).toBe("skipped");
    expect(body.reason).toBe("token_ceiling");
    expect(typeof body.liftsAt).toBe("string");
    expect(Date.parse(body.liftsAt as string)).toBeGreaterThan(Date.now());
    expect(String(body.message)).toContain("is paused by its daily token ceiling until");
    expect(String(body.message)).toContain(body.liftsAt as string);
    // Reason and liftsAt only: the ceiling's figures are configuration.
    expect(String(body.message)).not.toContain(String(AGENT_DEFAULT_MAX_DAILY_TOKENS));
    expect(body).not.toHaveProperty("ceiling");
    expect(body).not.toHaveProperty("tokensToday");
  }

  /** Wake requests for an agent, once the fire-and-forget wake has landed. */
  async function wakesLanded(agentId: string, count = 1) {
    let rows: Array<typeof agentWakeupRequests.$inferSelect> = [];
    await waitFor(async () => {
      rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.length >= count;
    });
    return rows;
  }

  async function seedIssue(companyId: string, values: { assigneeAgentId?: string | null; status?: string; title?: string }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: values.title ?? "Task",
      status: values.status ?? "todo",
      assigneeAgentId: values.assigneeAgentId ?? null,
    });
    return id;
  }

  describe("self-wakes through issue changes", () => {
    it("skips the wake when an over-ceiling agent moves its own blocked issue back to todo", async () => {
      const { companyId, agentId } = await seed();
      await spendTheDay(companyId, agentId);
      const issueId = await seedIssue(companyId, { assigneeAgentId: agentId, status: "blocked" });

      const res = await request(createApp(agentActor(agentId, companyId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const wakes = await wakesLanded(agentId);
      expect(wakes.map((wake) => [wake.status, wake.reason])).toEqual([["skipped", "token_ceiling"]]);
    });

    it("skips the wake when an over-ceiling agent creates an issue assigned to itself", async () => {
      const { companyId, agentId } = await seed();
      await spendTheDay(companyId, agentId);

      const res = await request(createApp(agentActor(agentId, companyId)))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "More work for me", status: "todo", assigneeAgentId: agentId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const wakes = await wakesLanded(agentId);
      expect(wakes.map((wake) => [wake.status, wake.reason])).toEqual([["skipped", "token_ceiling"]]);
    });

    it("skips the wake when an over-ceiling agent reassigns an issue to itself", async () => {
      const { companyId, agentId } = await seed();
      await spendTheDay(companyId, agentId);
      const issueId = await seedIssue(companyId, { assigneeAgentId: null, status: "todo" });

      const res = await request(createApp(agentActor(agentId, companyId)))
        .patch(`/api/issues/${issueId}`)
        .send({ assigneeAgentId: agentId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const wakes = await wakesLanded(agentId);
      expect(wakes.map((wake) => [wake.status, wake.reason])).toEqual([["skipped", "token_ceiling"]]);
    });
  });

  describe("wakes between agents", () => {
    it("still wakes agent B when agent A assigns it an issue over B's ceiling", async () => {
      const { companyId, agentId: assignerId } = await seed();
      const assigneeId = await seedAgentIn(companyId, "Assignee");
      await spendTheDay(companyId, assigneeId);

      const res = await request(createApp(agentActor(assignerId, companyId)))
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "For you", status: "todo", assigneeAgentId: assigneeId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const wakes = await wakesLanded(assigneeId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.status).not.toBe("skipped");
      expect(wakes[0]!.reason).toBe("issue_assigned");
      expect(wakes[0]!.requestedByActorId).toBe(assignerId);
    });

    it("skips the wake when an agent @-mentions another agent that is over its ceiling", async () => {
      const { companyId, agentId: authorId } = await seed();
      const mentionedId = await seedAgentIn(companyId, "Mentioned");
      await spendTheDay(companyId, mentionedId);
      const issueId = await seedIssue(companyId, { assigneeAgentId: authorId, status: "in_progress" });

      // Agent comments are written from a live run.
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: authorId, status: "running" });
      const res = await request(createApp({ ...agentActor(authorId, companyId), runId }))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "@Mentioned can you take a look?" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

      const wakes = await wakesLanded(mentionedId);
      expect(wakes.map((wake) => [wake.status, wake.reason])).toEqual([["skipped", "token_ceiling"]]);
    });

    it("still wakes an over-ceiling agent a person @-mentions", async () => {
      const { companyId, agentId: mentionedId } = await seed();
      await spendTheDay(companyId, mentionedId);
      const issueId = await seedIssue(companyId, { assigneeAgentId: null, status: "todo" });

      const res = await request(createApp(ownerActor(companyId)))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "@Looper can you take a look?" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const wakes = await wakesLanded(mentionedId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.status).not.toBe("skipped");
      expect(wakes[0]!.reason).toBe("issue_comment_mentioned");
    });
  });

  it("answers an agent's own wakeup over the ceiling with the pause and when it lifts", async () => {
    const { companyId, agentId } = await seed();
    await spendTheDay(companyId, agentId);
    const app = createApp(agentActor(agentId, companyId));

    const empty = await request(app).post(`/api/agents/${agentId}/wakeup`).send({});
    expect(empty.status, JSON.stringify(empty.body)).toBe(202);
    expectCeilingRefusal(empty.body);

    // Any reason or source the agent claims is still its own request.
    for (const body of [
      { reason: "keep_going" },
      { source: "assignment", reason: "issue_assigned" },
      { source: "automation", reason: "process_lost_retry" },
    ]) {
      const res = await request(app).post(`/api/agents/${agentId}/wakeup`).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expectCeilingRefusal(res.body);
    }

    const invoke = await request(app).post(`/api/agents/${agentId}/heartbeat/invoke`).send({});
    expect(invoke.status, JSON.stringify(invoke.body)).toBe(202);
    expectCeilingRefusal(invoke.body);

    expect(await ceilingSkips(agentId)).toHaveLength(5);
  });

  it("still runs a person's wakeup and invoke over the ceiling", async () => {
    const { companyId, agentId } = await seed();
    await spendTheDay(companyId, agentId);
    const app = createApp(boardActor(companyId));

    const res = await request(app).post(`/api/agents/${agentId}/wakeup`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.status).not.toBe("skipped");

    const invoke = await request(app).post(`/api/agents/${agentId}/heartbeat/invoke`).send({});
    expect(invoke.status, JSON.stringify(invoke.body)).toBe(202);
    expect(invoke.body.id).toEqual(expect.any(String));
    expect(await ceilingSkips(agentId)).toHaveLength(0);
  });

  it("runs an agent's own wakeup under the ceiling", async () => {
    const { companyId, agentId } = await seed();
    await spendTheDay(companyId, agentId, AGENT_DEFAULT_MAX_DAILY_TOKENS - 1);
    const app = createApp(agentActor(agentId, companyId));

    const res = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ reason: "keep_going" });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.id).toEqual(expect.any(String));
    expect(await ceilingSkips(agentId)).toHaveLength(0);
  });
});
