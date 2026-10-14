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

import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_DAILY_TOKENS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
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

function agentActor(agentId: string, companyId: string) {
  return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
}

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
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Looper",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
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
    expect(String(body.message)).toContain("daily token ceiling");
    expect(String(body.message)).toContain(body.liftsAt as string);
    // Reason and liftsAt only: the ceiling's figures are configuration.
    expect(String(body.message)).not.toContain(String(AGENT_DEFAULT_MAX_DAILY_TOKENS));
    expect(body).not.toHaveProperty("ceiling");
    expect(body).not.toHaveProperty("tokensToday");
  }

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
