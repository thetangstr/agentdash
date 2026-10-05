import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, asc, eq } from "drizzle-orm";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  RUN_CANCELLED_BY_OPERATOR_CODE,
  RUN_CANCELLED_BY_OPERATOR_MESSAGE,
} from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

async function createControlledGatewayServer() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const agentPayloads: Array<Record<string, unknown>> = [];
  let firstWaitRelease: (() => void) | null = null;
  let firstWaitGate = new Promise<void>((resolve) => {
    firstWaitRelease = resolve;
  });
  let waitCount = 0;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", async (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayloads.push((frame.params ?? {}) as Record<string, unknown>);
        const runId =
          typeof frame.params?.idempotencyKey === "string"
            ? frame.params.idempotencyKey
            : `run-${agentPayloads.length}`;

        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWaitGate;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId: frame.params?.runId,
              status: "ok",
              startedAt: 1,
              endedAt: 2,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayloads: () => agentPayloads,
    releaseFirstWait: () => {
      firstWaitRelease?.();
      firstWaitRelease = null;
      firstWaitGate = Promise.resolve();
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("heartbeat cancel truth (c3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-cancel-truth-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 600_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seedCompany(issueNumber = 1) {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, issuePrefix, issueNumber };
  }

  it("issue done -> cancel -> run cancelled, agent idle, no run failed event, no recovery wake", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue closed under the running agent",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "engineer",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // The issue patch flow commits the status change first, then cancels.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const reason = "Cancelled because the issue was marked done";
    const cancelled = await heartbeat.cancelRun(runId, reason);

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBe(reason);
    expect(cancelled?.errorCode).not.toBe(RUN_CANCELLED_BY_OPERATOR_CODE);

    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(agent?.status).toBe("idle");

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(asc(heartbeatRunEvents.id));
    expect(events.some((event) => event.message === "run stopped")).toBe(true);
    // AgentDash (c4-stops): a stop is not a warning — the lifecycle event is
    // neutral info even for a system cancel; the reason lives on the run.
    expect(events.filter((event) => event.message === "run stopped").every((event) => event.level === "info")).toBe(true);
    expect(events.some((event) => event.message === "run failed")).toBe(false);
    expect(events.every((event) => event.level !== "error")).toBe(true);

    // No continuation/recovery wake and no replacement run.
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);

    // The issue's execution lock is released.
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.executionRunId).toBeNull();
  });

  it("manual cancel leaves no wake behind; a new comment afterwards starts a run", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Manually stopped issue work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "engineer",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const cancelled = await heartbeat.cancelRun(
      runId,
      RUN_CANCELLED_BY_OPERATOR_MESSAGE,
      RUN_CANCELLED_BY_OPERATOR_CODE,
    );

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.errorCode).toBe(RUN_CANCELLED_BY_OPERATOR_CODE);

    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(agent?.status).toBe("idle");

    // The stop must not enqueue a continuation or a recovery wake.
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(0);
    const runsAfterCancel = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runsAfterCancel).toHaveLength(1);

    // A real new event afterwards is still allowed to start work again.
    const comment = await db
      .insert(issueComments)
      .values({ companyId, issueId, authorUserId: "user-1", body: "Please pick this back up" })
      .returning()
      .then((rows) => rows[0]);
    const nextRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: comment.id },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId: comment.id,
        wakeReason: "issue_commented",
      },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });

    expect(nextRun).not.toBeNull();
    expect(nextRun?.status === "queued" || nextRun?.status === "running").toBe(true);

    // The dispatched process run settles to failed (empty adapter config) —
    // park the issue so the failure cannot chain a recovery wake while we drain.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    await heartbeat.waitForExecutionDrain();
  });

  it("adapter resolving after the cancel commit keeps the run cancelled and the agent idle", async () => {
    const gateway = await createControlledGatewayServer();
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeat = heartbeatService(db);

    try {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Gateway Agent",
        role: "engineer",
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gateway.url,
          headers: { "x-openclaw-token": "gateway-token" },
          payloadTemplate: { message: "wake now" },
          waitTimeoutMs: 2_000,
        },
        runtimeConfig: {},
        permissions: {},
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Cancel while the adapter is mid-flight",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });

      const comment = await db
        .insert(issueComments)
        .values({ companyId, issueId, authorUserId: "user-1", body: "Start work" })
        .returning()
        .then((rows) => rows[0]);

      const firstRun = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId: comment.id },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          commentId: comment.id,
          wakeReason: "issue_commented",
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
      });

      expect(firstRun).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1);

      // Cancel while agent.wait is still gated: the adapter will resolve AFTER
      // the cancelled row commits — the exact race that stamped "failed".
      const cancelled = await heartbeat.cancelRun(
        firstRun!.id,
        RUN_CANCELLED_BY_OPERATOR_MESSAGE,
        RUN_CANCELLED_BY_OPERATOR_CODE,
      );
      expect(cancelled?.status).toBe("cancelled");

      gateway.releaseFirstWait();
      await heartbeat.waitForExecutionDrain();

      const settled = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, firstRun!.id))
        .then((rows) => rows[0]);
      expect(settled?.status).toBe("cancelled");
      expect(settled?.errorCode).toBe(RUN_CANCELLED_BY_OPERATOR_CODE);

      const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
      expect(agent?.status).toBe("idle");

      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, firstRun!.id))
        .orderBy(asc(heartbeatRunEvents.id));
      expect(events.some((event) => event.message === "run stopped")).toBe(true);
      expect(events.some((event) => event.message === "run failed")).toBe(false);
      expect(events.every((event) => event.eventType !== "error")).toBe(true);

      // The clean adapter exit must not resurrect the issue: still exactly one
      // run, and no continuation/recovery wake.
      const wakes = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.companyId, companyId),
          ),
        );
      expect(
        wakes.filter((wake) =>
          wake.reason === "issue_continuation_needed"
          || wake.reason === "assignment_recovery"
          || wake.reason === "missing_issue_comment"),
      ).toHaveLength(0);
      expect(
        wakes.filter((wake) => wake.status === "queued" || wake.status === "deferred_issue_execution"),
      ).toHaveLength(0);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  // AgentDash (c3 review): the whole race end-to-end with a real process —
  // SIGTERM exits 130 via the trap, the adapter resolves after the cancelled
  // commit, and nothing downstream may read it as a failure.
  it("a real process killed by cancel exits 130 and still settles cancelled with the agent idle", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeat = heartbeatService(db);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Process Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: "sh",
        args: ["-c", "echo c3-stderr-marker >&2; trap 'exit 130' TERM; sleep 60 & wait"],
        graceSec: 1,
      },
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Real process stopped by the operator",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });
    expect(run).not.toBeNull();

    // Wait for the real sh process to be spawned — the process adapter does
    // not persist a pid on the run row; the shared runningProcesses map is
    // the same signal cancelRunInternal consults before it kills.
    try {
      await waitFor(async () => {
        const row = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run!.id))
          .then((rows) => rows[0]);
        return row?.status === "running" && runningProcesses.has(run!.id);
      }, 60_000);
    } catch (err) {
      const row = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0]);
      console.log("run row at timeout:", JSON.stringify({ status: row?.status, errorCode: row?.errorCode, error: row?.error, processPid: row?.processPid }));
      const evts = await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run!.id))
        .orderBy(asc(heartbeatRunEvents.id));
      console.log("run events:", JSON.stringify(evts.map((e) => ({ t: e.eventType, m: e.message, lvl: e.level }))));
      throw err;
    }

    const cancelled = await heartbeat.cancelRun(
      run!.id,
      RUN_CANCELLED_BY_OPERATOR_MESSAGE,
      RUN_CANCELLED_BY_OPERATOR_CODE,
    );
    expect(cancelled?.status).toBe("cancelled");
    await heartbeat.waitForExecutionDrain();

    const settled = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0]);
    expect(settled?.status).toBe("cancelled");
    expect(settled?.errorCode).toBe(RUN_CANCELLED_BY_OPERATOR_CODE);

    // AgentDash (c3 review): the adopted outcome keeps the adapter's evidence —
    // the kill's exit code, the stderr it wrote before dying, the log bytes,
    // and the usage record its cost events still charge against.
    expect(settled?.exitCode).toBe(130);
    expect(settled?.stderrExcerpt).toContain("c3-stderr-marker");
    expect(settled?.logBytes).toBeGreaterThan(0);
    expect(settled?.usageJson).not.toBeNull();

    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);
    expect(agent?.status).toBe("idle");

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run!.id))
      .orderBy(asc(heartbeatRunEvents.id));
    // The cancel path and the adopted executor path must not double-report.
    expect(events.filter((event) => event.message === "run stopped")).toHaveLength(1);
    // AgentDash (c4-stops): an operator stop renders neutral — info, not warn.
    expect(events.filter((event) => event.message === "run stopped").every((event) => event.level === "info")).toBe(true);
    expect(events.some((event) => event.message === "run failed")).toBe(false);
    expect(events.every((event) => event.level !== "error")).toBe(true);
  }, 90_000);
});
