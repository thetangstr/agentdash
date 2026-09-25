import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockAdapterExecute = vi.hoisted(() =>
  // A promoted follow-up wake can execute once the per-test
  // mockImplementationOnce is consumed — a benign default keeps that run
  // ordinary instead of crashing it with an undefined result.
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Follow-up work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-facts tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * OBS-1 (#694): every finalized run carries a normalized `runFacts` record and
 * a `meteringStatus` — and an unmetered run is visibly unmetered, not a quiet
 * zero-token run.
 */
describeEmbeddedPostgres("heartbeat run facts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-facts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function cancelActiveRunsForCleanup(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activeRuns = await db
        .select({
          id: heartbeatRuns.id,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(
          or(
            eq(heartbeatRuns.status, "queued"),
            eq(heartbeatRuns.status, "running"),
          ),
        );

      if (activeRuns.length === 0) return;

      const now = new Date();
      const runIds = activeRuns.map((run) => run.id);
      const wakeupRequestIds = activeRuns
        .map((run) => run.wakeupRequestId)
        .filter((value): value is string => typeof value === "string" && value.length > 0);

      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
          errorCode: "test_cleanup",
          error: "Cancelled by heartbeat-run-facts test cleanup",
          processPid: null,
          processGroupId: null,
        })
        .where(inArray(heartbeatRuns.id, runIds));

      if (wakeupRequestIds.length > 0) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "cancelled",
            finishedAt: now,
            error: "Cancelled by heartbeat-run-facts test cleanup",
          })
          .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  afterEach(async () => {
    // mockReset, not just clear: an unconsumed mockImplementationOnce would
    // otherwise leak into the NEXT test's run and silently change its result.
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Follow-up work.",
      provider: "test",
      model: "test-model",
    }));
    vi.clearAllMocks();
    // Wait for heartbeat background writes to drain before deleting — a run
    // that is still finalizing inserts FK-referencing rows mid-cleanup.
    await cancelActiveRunsForCleanup();
    await waitForHeartbeatIdle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(costEvents);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(agentTaskSessions);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(budgetPolicies);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(companySkills);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRun(input?: {
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
    wakeReason?: string;
    invocationSource?: string;
    includeIssue?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FactsAgent",
      role: "engineer",
      status: "idle",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: input?.adapterConfig ?? {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: input?.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input?.wakeReason ?? "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: input?.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot:
        input?.includeIssue === false
          ? { wakeReason: input?.wakeReason ?? "issue_assigned" }
          : { issueId, taskId: issueId, wakeReason: input?.wakeReason ?? "issue_assigned" },
    });
    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Task for run-facts coverage",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }
    return { companyId, agentId, runId, issueId };
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Terminal status is written BEFORE runFacts (liveness classification needs
   * the persisted status first), so settling on status alone races the facts
   * write. Wait for the facts themselves.
   */
  async function settle(runId: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = await readRun(runId);
      if (
        run &&
        run.status !== "queued" &&
        run.status !== "running" &&
        runFactsOf(run) !== null
      ) {
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readRun(runId);
  }

  function runFactsOf(run: { resultJson: unknown } | null) {
    const rj =
      run?.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson)
        ? (run.resultJson as Record<string, unknown>)
        : {};
    return (rj.runFacts ?? null) as Record<string, unknown> | null;
  }

  it("records metered runFacts for an adapter that reports usage", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedRun({
      adapterConfig: { model: "configured-model" },
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      // Concrete evidence — the comment this run filed — so liveness classifies
      // `advanced` and the outcome reads `produced`.
      await db.insert(issueComments).values({
        id: randomUUID(),
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Shipped the change.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Did the work.",
        provider: "test-provider",
        model: "served-model",
        sessionId: "sess-run-facts-1",
        usage: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 90 },
        resultJson: { num_turns: 4 },
      };
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await settle(runId);

    expect(run?.status).toBe("succeeded");
    const facts = runFactsOf(run);
    expect(facts, "runFacts must be persisted on every finalized run").not.toBeNull();
    expect(facts).toMatchObject({
      meteringStatus: "adapter_reported",
      servedModel: "served-model",
      servedProvider: "test-provider",
      configuredModel: "configured-model",
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 90,
      turns: 4,
      outcome: "produced",
      wakeReason: "assignment",
    });
    expect(typeof facts?.wallMs).toBe("number");

    const usageJson = run?.usageJson as Record<string, unknown> | null;
    expect(usageJson?.meteringStatus).toBe("adapter_reported");
    expect(usageJson?.inputTokens).toBe(1200);
  });

  it("converts cumulative session totals into a per-run delta", async () => {
    const { agentId, runId } = await seedQueuedRun();
    const sessionId = "sess-cumulative-1";

    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "first",
      model: "m",
      provider: "p",
      sessionId,
      usage: { inputTokens: 1000, outputTokens: 100 },
    }));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const first = await settle(runId);
    expect(first?.status).toBe("succeeded");
    expect(runFactsOf(first)?.inputTokens).toBe(1000);

    // Second run of the SAME session reports the session's running total.
    const runId2 = randomUUID();
    const wakeupRequestId2 = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId2,
      companyId: first!.companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "timer",
      status: "queued",
      runId: runId2,
    });
    await db.insert(heartbeatRuns).values({
      id: runId2,
      companyId: first!.companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupRequestId2,
      contextSnapshot: {},
      // Resume the session so the adapter sees it as continuing.
      sessionIdBefore: sessionId,
    });

    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "second",
      model: "m",
      provider: "p",
      sessionId,
      usage: { inputTokens: 2500, outputTokens: 260 },
    }));

    await heartbeat.resumeQueuedRuns();
    const second = await settle(runId2);
    expect(second?.status).toBe("succeeded");
    const facts = runFactsOf(second);
    expect(facts?.meteringStatus).toBe("adapter_reported");
    // The run consumed 1500/160 — not the session's cumulative 2500/260.
    expect(facts?.inputTokens).toBe(1500);
    expect(facts?.outputTokens).toBe(160);
    expect(facts?.wakeReason).toBe("timer");
    expect((second?.usageJson as Record<string, unknown>)?.usageSource).toBe("session_delta");
  });

  it("skips metering-status-only rows when finding the session baseline", async () => {
    // OBS-1 writes `usageJson: { meteringStatus }` even for runs that recorded
    // no usage — failures included. A `isNotNull(usageJson)` baseline scan
    // would chew those rows before reaching the last real reading.
    const { agentId, runId } = await seedQueuedRun();
    const sessionId = "sess-failed-baseline";

    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "first",
      model: "m",
      provider: "p",
      sessionId,
      usage: { inputTokens: 1000, outputTokens: 100 },
    }));
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const first = await settle(runId);
    expect(first?.status).toBe("succeeded");

    // The failed run between them — exactly what finalize stamps today.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: first!.companyId,
      agentId,
      invocationSource: "timer",
      status: "failed",
      sessionIdAfter: sessionId,
      usageJson: { meteringStatus: "unmetered_no_session" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const runId2 = randomUUID();
    const wakeupRequestId2 = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId2,
      companyId: first!.companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "timer",
      status: "queued",
      runId: runId2,
    });
    await db.insert(heartbeatRuns).values({
      id: runId2,
      companyId: first!.companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeupRequestId2,
      contextSnapshot: {},
      sessionIdBefore: sessionId,
    });

    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "second",
      model: "m",
      provider: "p",
      sessionId,
      usage: { inputTokens: 2500, outputTokens: 260 },
    }));
    await heartbeat.resumeQueuedRuns();
    const second = await settle(runId2);
    expect(second?.status).toBe("succeeded");
    // Baseline is the first run's totals — the failed row is not even a
    // candidate — so the delta is 1500/160, not the cumulative 2500/260.
    expect(runFactsOf(second)).toMatchObject({
      meteringStatus: "adapter_reported",
      inputTokens: 1500,
      outputTokens: 160,
    });
  });

  it("marks an unmetered run honestly and emits exactly one warning event", async () => {
    const { runId } = await seedQueuedRun();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "ran, but nothing to meter",
      // What the hermes wrapper stamps when the ledger cannot be read.
      resultJson: { meteringStatus: "unmetered_no_ledger" },
    }));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await settle(runId);

    expect(run?.status).toBe("succeeded");
    const facts = runFactsOf(run);
    expect(facts?.meteringStatus).toBe("unmetered_no_ledger");
    // Unknown, not zero.
    expect(facts?.inputTokens).toBeNull();
    expect(facts?.outputTokens).toBeNull();

    const usageJson = run?.usageJson as Record<string, unknown> | null;
    expect(usageJson?.meteringStatus).toBe("unmetered_no_ledger");
    expect(usageJson?.inputTokens).toBeUndefined();

    // The warning is appended after runFacts is persisted (which is what
    // settle() waits for), so wait for the lifecycle event that precedes it
    // and the warning itself before counting.
    const readEvents = () =>
      db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    await vi.waitFor(async () => {
      const events = await readEvents();
      expect(events.some((e) => e.eventType === "metering" && e.level === "warn")).toBe(true);
    }, { timeout: 5_000 });
    const events = await readEvents();
    const warnings = events.filter(
      (e) => e.eventType === "metering" && e.level === "warn",
    );
    expect(warnings, "one metering warning per unmetered-ledger run").toHaveLength(1);
  });

  it("writes no zero-token cost event for an unmetered run", async () => {
    const { runId } = await seedQueuedRun();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "silent on usage",
    }));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await settle(runId);
    expect(run?.status).toBe("succeeded");
    expect(runFactsOf(run)?.meteringStatus).toBe("unmetered_no_session");

    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, runId));
    expect(events).toHaveLength(0);
  });

  it("rotates the session when cumulative raw input tokens cross the policy ceiling", async () => {
    // codex_local's default compaction policy caps a session at 250k raw input
    // tokens. Fed real-shaped ledger numbers (raw* cumulative totals), the next
    // wake must rotate instead of resuming — this is what keeps a hot session
    // from silently compounding.
    const { companyId, agentId, runId } = await seedQueuedRun({
      includeIssue: false,
      invocationSource: "timer",
      wakeReason: "timer",
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "sess-hot",
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "succeeded",
      livenessState: "advanced",
      sessionIdAfter: "sess-hot",
      usageJson: {
        rawInputTokens: 300_000,
        rawCachedInputTokens: 50_000,
        rawOutputTokens: 4_000,
      },
      resultJson: { num_turns: 12 },
      startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 120_000),
    });
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "fresh session",
      model: "m",
      provider: "p",
      sessionId: "sess-new",
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await settle(runId);

    expect(run?.status).toBe("succeeded");
    const ctx = run?.contextSnapshot as Record<string, unknown>;
    expect(ctx?.paperclipSessionRotationReason).toContain("raw input reached");
    expect(ctx?.paperclipPreviousSessionId).toBe("sess-hot");
    // The run started a fresh session — it did not resume the hot one.
    expect(run?.sessionIdBefore).toBeNull();
    expect(run?.sessionIdAfter).toBe("sess-new");
  });

  it("records runFacts for a failed run", async () => {
    const { runId } = await seedQueuedRun();
    mockAdapterExecute.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "adapter exploded",
    }));

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const run = await settle(runId);

    expect(run?.status).toBe("failed");
    const facts = runFactsOf(run);
    expect(facts).not.toBeNull();
    expect(facts?.outcome).toBe("failed");
    expect(facts?.meteringStatus).toBe("unmetered_no_session");
  });
});
