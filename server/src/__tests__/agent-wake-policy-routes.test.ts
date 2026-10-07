// AgentDash (wake policy): the HTTP lanes the policy depends on.
//
//  - The credential is read from the real request (requestActorSourceMiddleware
//    → currentRequestActorSource), not threaded by hand: a board-key issue
//    create with status todo + assigneeAgentId — exactly what an external
//    harness sends — must reach the policy agent; the same create from a
//    browser session must be refused with travel_pairing.not_board_key.
//  - Only a board actor may set, change or clear runtimeConfig.wakePolicy, and
//    the validator only accepts the known values.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { requestActorSourceMiddleware } from "../lib/request-actor-source.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

function boardActor(companyId: string, source: "board_key" | "session") {
  return {
    type: "board",
    userId: "board-owner",
    source,
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  };
}

function agentActor(agentId: string, companyId: string) {
  return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
}

describeEmbeddedPostgres("wake policy over HTTP", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-policy-routes-");
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

  async function seed(opts: { policy: boolean }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Wake Policy Co",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const environmentId = randomUUID();
    // An SSH environment with no config: acquisition fails deterministically
    // before any network I/O, so an accepted run ends quickly.
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: "pairing-host",
      driver: "ssh",
      status: "active",
      config: {},
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PolicyAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: {
        heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 },
        ...(opts.policy ? { wakePolicy: "board_assignment_only" } : {}),
      },
      permissions: {},
      defaultEnvironmentId: environmentId,
    });
    return { companyId, agentId, environmentId };
  }

  async function wakesFor(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
  }

  it("a board-key issue create (todo + assignee) starts the policy agent's run", async () => {
    const { companyId, agentId } = await seed({ policy: true });

    const res = await request(createApp(boardActor(companyId, "board_key")))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Reviewed brief", status: "todo", assigneeAgentId: agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await waitFor(async () => (await wakesFor(agentId)).length > 0);
    const [first] = await wakesFor(agentId);
    expect(first?.source).toBe("assignment");
    expect(first?.reason).toBe("issue_assigned");
    expect(first?.status).not.toBe("skipped");
    expect(first?.runId).not.toBeNull();
    expect((first?.payload as Record<string, unknown>)?.requestedVia).toBe("board_key");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("the same issue create from a browser session is refused with not_board_key", async () => {
    const { companyId, agentId } = await seed({ policy: true });

    const res = await request(createApp(boardActor(companyId, "session")))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Reviewed brief", status: "todo", assigneeAgentId: agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await waitFor(async () => (await wakesFor(agentId)).length > 0);
    const wakes = await wakesFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("skipped");
    expect(wakes[0]?.reason).toBe("travel_pairing.not_board_key");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("a non-policy agent is woken by a session issue create as before", async () => {
    const { companyId, agentId } = await seed({ policy: false });

    const res = await request(createApp(boardActor(companyId, "session")))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Ordinary work", status: "todo", assigneeAgentId: agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await waitFor(async () => (await wakesFor(agentId)).length > 0);
    const [first] = await wakesFor(agentId);
    expect(first?.status).not.toBe("skipped");
    expect(first?.reason).toBe("issue_assigned");
    expect(Object.prototype.hasOwnProperty.call(first?.payload ?? {}, "requestedVia")).toBe(false);
  });

  it("a board user can set and clear runtimeConfig.wakePolicy; unknown values are rejected", async () => {
    const { companyId, agentId } = await seed({ policy: false });
    const app = createApp(boardActor(companyId, "session"));

    const set = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { wakePolicy: "board_assignment_only" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    let row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect((row.runtimeConfig as Record<string, unknown>).wakePolicy).toBe("board_assignment_only");

    const bogus = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { wakePolicy: "sometimes" } });
    expect(bogus.status).toBeGreaterThanOrEqual(400);
    expect(bogus.status).toBeLessThan(500);

    const cleared = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { wakePolicy: "default" } });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect((row.runtimeConfig as Record<string, unknown>).wakePolicy).toBe("default");
  });

  it("switching the policy on via PATCH refuses the agent's already-queued timer run", async () => {
    const { companyId, agentId } = await seed({ policy: false });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);

    const res = await request(createApp(boardActor(companyId, "session")))
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { ...(row.runtimeConfig as Record<string, unknown>), wakePolicy: "board_assignment_only" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    expect(run.status).toBe("cancelled");
    expect(run.errorCode).toBe("travel_pairing.wake_source");
    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0]!);
    expect(wake).toMatchObject({ status: "skipped", reason: "travel_pairing.wake_source", runId: null });
  });

  it("an agent key cannot change another agent's wake policy", async () => {
    const { companyId, agentId } = await seed({ policy: true });
    const ceoId = randomUUID();
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath },
      runtimeConfig: {},
      permissions: { canCreateAgents: true },
    });
    const app = createApp(agentActor(ceoId, companyId));

    // Dropping runtimeConfig.wakePolicy by omission is refused…
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect((row.runtimeConfig as Record<string, unknown>).wakePolicy).toBe("board_assignment_only");

    // …and so is switching the legacy alias off through metadata.
    await db
      .update(agents)
      .set({ runtimeConfig: {}, metadata: { travelPairing: true } })
      .where(eq(agents.id, agentId));
    const viaMetadata = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ metadata: { travelPairing: false } });
    expect(viaMetadata.status, JSON.stringify(viaMetadata.body)).toBe(403);
    const after = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect((after.metadata as Record<string, unknown>).travelPairing).toBe(true);
  });
});
