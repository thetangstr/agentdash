import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { and, desc, eq, or, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists. Current-authority witnesses are covered with the
// real middleware in issue-current-authority.test.ts.
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));

import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companySkills,
  companies,
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
import { runningProcesses } from "../adapters/index.ts";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
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
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
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
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { requestActorSourceMiddleware, runWithRequestActorSource } from "../lib/request-actor-source.ts";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
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
        error: "Cancelled by heartbeat-process-recovery test cleanup",
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
          error: "Cancelled by heartbeat-process-recovery test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    await cancelActiveRunsForCleanup(db, 5_000);
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({
          status: heartbeatRuns.status,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
        })
        .from(heartbeatRuns);
      const managedExecutionStillActive = runs.some(
        (run) =>
          (run.status === "queued" || run.status === "running") &&
          !run.processPid &&
          !run.processGroupId,
      );
      if (!managedExecutionStillActive) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitForHeartbeatIdle(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    logStore?: string | null;
    logRef?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false ? {} : { issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      logStore: input?.logStore ?? null,
      logRef: input?.logRef ?? null,
      startedAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedEnvironmentLeaseFixture(input: {
    companyId: string;
    runId: string;
    issueId: string;
    provider?: string;
  }) {
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(environments).values({
      id: environmentId,
      companyId: input.companyId,
      name: "Local test environment",
      driver: "local",
      status: "active",
      config: {},
      metadata: null,
    });

    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "local",
      },
      createdAt: now,
      updatedAt: now,
    });

    return { environmentId, leaseId };
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | null;
    runSource?: string | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:00:01.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
        ...(input.runSource ? { source: input.runSource } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:00:01.000Z"),
      updatedAt: new Date("2026-03-19T00:00:01.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
        // AgentDash (Lane F1): stranded work is old work; a just-created issue
        // is inside the escalation minimum age and would only be deferred.
        createdAt: now,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedExhaustedRecoveryBudgetFixture(
    dimension: "attempts" | "turns" | "tokens" | "cost" | "time",
  ) {
    const fixture = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      runErrorCode: "adapter_failed",
      runError: "provider run failed before persisting a comment",
    });
    // The source run is an ordinary, unlinked dispatch: it is not automatic
    // recovery, so it never counts against the recovery budget.
    await db
      .update(heartbeatRuns)
      .set({
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt: new Date("2026-03-19T00:00:01.000Z"),
        usageJson: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
        resultJson: { num_turns: 1, total_cost_usd: 0.01 },
      })
      .where(eq(heartbeatRuns.id, fixture.runId));

    // The automatic retry the source run bought. It carries the spend under
    // test; for the non-attempt dimensions the agent allows more retries, so
    // only that dimension can be what exhausts the budget.
    if (dimension !== "attempts") {
      await db
        .update(agents)
        .set({ runtimeConfig: { recoveryBudget: { automaticRetries: 3 } } })
        .where(eq(agents.id, fixture.agentId));
    }
    const retryRunId = randomUUID();
    const retryWakeupId = randomUUID();
    const retryStartedAt = new Date("2026-03-19T00:00:02.000Z");
    const retryFinishedAt = new Date(
      dimension === "time"
        ? "2026-03-19T00:05:02.000Z"
        : "2026-03-19T00:00:03.000Z",
    );
    await db.insert(agentWakeupRequests).values({
      id: retryWakeupId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "missing_issue_comment",
      payload: { issueId: fixture.issueId, retryOfRunId: fixture.runId },
      status: "failed",
      runId: retryRunId,
      claimedAt: retryStartedAt,
      finishedAt: retryFinishedAt,
      error: "retry failed",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId: retryWakeupId,
      contextSnapshot: {
        issueId: fixture.issueId,
        taskId: fixture.issueId,
        retryReason: "missing_issue_comment",
        retryOfRunId: fixture.runId,
      },
      retryOfRunId: fixture.runId,
      startedAt: retryStartedAt,
      finishedAt: retryFinishedAt,
      usageJson: {
        inputTokens: dimension === "tokens" ? 500_000 : 1,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      resultJson: {
        num_turns: dimension === "turns" ? 12 : 1,
        total_cost_usd: dimension === "cost" ? 0.25 : 0.01,
      },
      errorCode: "adapter_failed",
      error: "retry failed",
    });

    return { ...fixture, sourceRunId: fixture.runId, parentRunId: retryRunId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function expectStrandedRecoveryArtifacts(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    retryReason: "assignment_recovery" | "issue_continuation_needed";
  }) {
    const recovery = await waitForValue(async () =>
      db.select().from(issues).where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, input.issueId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!recovery) throw new Error("Expected stranded issue recovery issue to be created");

    expect(recovery).toMatchObject({
      companyId: input.companyId,
      parentId: input.issueId,
      assigneeAgentId: input.agentId,
      originKind: "stranded_issue_recovery",
      originId: input.issueId,
      originRunId: input.runId,
      priority: "medium",
    });
    expect(recovery.title).toContain("Recover stalled issue");
    expect(recovery.description).toContain(`Previous source status: \`${input.previousStatus}\``);
    expect(recovery.description).toContain(`Retry reason: \`${input.retryReason}\``);
    expect(recovery.description).toContain("Fix the runtime/adapter problem");

    const relation = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.issueId, recovery.id),
          eq(issueRelations.relatedIssueId, input.issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(relation).toBeTruthy();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, input.agentId));
    const recoveryWakeup = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.issueId === recovery.id &&
        payload?.sourceIssueId === input.issueId &&
        payload?.strandedRunId === input.runId;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "issue_assigned",
      source: "assignment",
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: recovery.id,
      taskId: recovery.id,
      source: "stranded_issue_recovery",
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
    });

    return recovery;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("does not reap a dead-pid run whose log file was written recently (live child)", async () => {
    // Same dead-pid setup as the process_lost test below, but hermes_local-style
    // runs stream to their log FILE and often record no live pid — a fresh log
    // mtime means the child is still producing output, so the reaper must skip it
    // rather than false-positive into process_lost (the 2026-06-11 crash-loop).
    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-log-"));
    const prevBase = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = tmpLogDir;
    try {
      const logRef = "live-run.log";
      const { runId } = await seedRunFixture({
        processPid: 999_999_999,
        logStore: "local_file",
        logRef,
      });
      await fs.writeFile(path.join(tmpLogDir, logRef), "streaming output");

      const heartbeat = heartbeatService(db);
      const result = await heartbeat.reapOrphanedRuns();

      expect(result.reaped).toBe(0);
      const run = (
        await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
      )[0];
      expect(run?.status).toBe("running");
      expect(run?.errorCode).toBeNull();
    } finally {
      if (prevBase === undefined) delete process.env.RUN_LOG_BASE_PATH;
      else process.env.RUN_LOG_BASE_PATH = prevBase;
      await fs.rm(tmpLogDir, { recursive: true, force: true });
    }
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it.each(["attempts", "turns", "tokens", "cost", "time"] as const)(
    "fails closed before adapter invocation when the aggregate recovery %s budget is exhausted",
    async (dimension) => {
      const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture(dimension);
      const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

      await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId, retryOfRunId: parentRunId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          retryReason: "issue_continuation_needed",
          retryOfRunId: parentRunId,
        },
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      });

      const latestRun = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      expect(latestRun?.status).toBe("cancelled");
      expect(latestRun?.errorCode).toBe("task_recovery_budget_exhausted");
      expect(mockAdapterExecute).not.toHaveBeenCalled();

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
      expect(issue?.status).toBe("blocked");
      const recordedBudget = (issue?.executionState as { recoveryBudget?: { exhaustedBy?: string[] } } | null)
        ?.recoveryBudget;
      expect(recordedBudget?.exhaustedBy).toEqual([dimension]);
      expect(issue?.executionState).toMatchObject({
        recoveryBudget: {
          status: "exhausted",
          exhaustedBy: expect.arrayContaining([dimension]),
          usage: {
            automaticRetries: expect.any(Number),
            providerTurns: expect.any(Number),
            providerTokens: expect.any(Number),
            providerCostUsd: expect.any(Number),
            runtimeMs: expect.any(Number),
          },
        },
      });

      const suppressedWake = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId, retryOfRunId: parentRunId },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          retryReason: "issue_continuation_needed",
          retryOfRunId: parentRunId,
        },
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      });
      const suppressedRun = suppressedWake
        ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, suppressedWake.id)).then((rows) => rows[0] ?? null)
        : null;
      expect(suppressedRun?.status).toBe("cancelled");
      expect(suppressedRun?.errorCode).toBe("task_recovery_budget_exhausted");
      expect(mockAdapterExecute).not.toHaveBeenCalled();

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Automatic recovery budget exhausted");
      expect(comments[0]?.body).toContain("attempts=");
      expect(comments[0]?.body).toContain("turns=");
      expect(comments[0]?.body).toContain("tokens=");
      expect(comments[0]?.body).toContain("costUsd=");
      expect(comments[0]?.body).toContain("runtimeMs=");
    },
  );

  it("repairs the visible exhaustion comment when the durable marker already exists", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("cost");
    await db
      .update(issues)
      .set({
        status: "blocked",
        executionState: {
          recoveryBudget: {
            status: "exhausted",
            exhaustedBy: ["cost"],
            usage: {
              automaticRetries: 0,
              providerTurns: 1,
              providerTokens: 1,
              providerCostUsd: 0.25,
              runtimeMs: 1_000,
            },
          },
        },
      })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId: parentRunId },
      contextSnapshot: { issueId, taskId: issueId, retryOfRunId: parentRunId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    const refusedRun = wake
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(refusedRun?.status).toBe("cancelled");
    expect(refusedRun?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Automatic recovery budget exhausted");
    expect(comments[0]?.body).toContain("costUsd=");
  });

  // AgentDash: this test previously claimed a manual wake "cleared" an
  // exhausted budget, but it never seeded the durable marker — it only proved
  // the unlinked-dispatch ancestry bypass. Once a persisted exhausted marker
  // exists, EVERY wake for the issue is refused, including an unlinked
  // human-source one; only the named-human task_recovery.remediate permit
  // path authorizes a single bound run.
  it("holds a persisted exhausted marker against an unlinked human-source wake", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("cost");
    await db
      .update(issues)
      .set({
        status: "blocked",
        executionState: {
          recoveryBudget: {
            status: "exhausted",
            exhaustedBy: ["cost"],
            usage: {
              automaticRetries: 0,
              providerTurns: 1,
              providerTokens: 1,
              providerCostUsd: 0.25,
              runtimeMs: 1_000,
            },
            exhaustedAt: new Date().toISOString(),
            sourceRunId: parentRunId,
            refusedRunId: parentRunId,
          },
        },
      })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const wake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "Human remediation after recovery exhaustion",
      contextSnapshot: { issueId, taskId: issueId },
      requestedByActorType: "user",
      requestedByActorId: "staging-operator",
    });

    const remediationRun = wake
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(remediationRun?.status).toBe("cancelled");
    expect(remediationRun?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.executionState).toMatchObject({
      recoveryBudget: { status: "exhausted" },
    });
  });

  it("keeps the unlinked-dispatch bypass only when no persisted marker exists", async () => {
    const { agentId, issueId } = await seedExhaustedRecoveryBudgetFixture("cost");
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const wake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "Human remediation after recovery exhaustion",
      contextSnapshot: { issueId, taskId: issueId },
      requestedByActorType: "user",
      requestedByActorId: "staging-operator",
    });

    const remediationRun = wake
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(remediationRun?.status).not.toBe("cancelled");
    expect(remediationRun?.errorCode).toBeNull();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.executionState).not.toMatchObject({
      recoveryBudget: { status: "exhausted" },
    });
  });

  it("counts retry ancestry that identifies the task through taskId only", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("tokens");
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { taskId: issueId } })
      .where(eq(heartbeatRuns.id, parentRunId));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { retryOfRunId: parentRunId },
      contextSnapshot: { taskId: issueId, retryOfRunId: parentRunId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    const refusedRun = wake
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(refusedRun?.status).toBe("cancelled");
    expect(refusedRun?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels taskId-only sibling retries when the aggregate budget is exhausted", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("cost");
    const siblingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: siblingRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      contextSnapshot: { taskId: issueId, retryOfRunId: parentRunId },
      retryOfRunId: parentRunId,
    });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId: parentRunId },
      contextSnapshot: { issueId, taskId: issueId, retryOfRunId: parentRunId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    const sibling = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, siblingRunId))
      .then((rows) => rows[0] ?? null);
    expect(sibling?.status).toBe("cancelled");
    expect(sibling?.errorCode).toBe("task_recovery_budget_exhausted");
  });

  it("publishes the exhaustion trip's run event and live events only after the claim transaction commits (GH #891)", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("cost");
    const { subscribeCompanyLiveEvents } = await import("../services/live-events.ts");
    // Each published event triggers a read on the main pool, which only sees
    // committed rows: an event sent from inside the claim transaction would
    // observe the issue without its marker / the run still queued.
    const observations: Promise<{ type: string; marker: unknown; runStatus: string | null }>[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const relevant =
        (event.type === "heartbeat.run.status" && payload.status === "cancelled") ||
        event.type === "heartbeat.run.event" ||
        (event.type === "activity.logged" && payload.action === "issue.recovery_budget_exhausted");
      if (!relevant) return;
      const runId = typeof payload.runId === "string" ? payload.runId : null;
      observations.push((async () => {
        const [issue] = await db.select({ executionState: issues.executionState }).from(issues).where(eq(issues.id, issueId));
        const [run] = runId
          ? await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
          : [];
        return {
          type: event.type,
          marker: (issue?.executionState as Record<string, unknown> | null)?.recoveryBudget ?? null,
          runStatus: run?.status ?? null,
        };
      })());
    });
    try {
      const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
      await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId, retryOfRunId: parentRunId },
        contextSnapshot: { issueId, taskId: issueId, retryOfRunId: parentRunId },
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      });
    } finally {
      unsubscribe();
    }
    const seen = await Promise.all(observations);
    expect(seen.map((value) => value.type)).toEqual(expect.arrayContaining([
      "heartbeat.run.status",
      "heartbeat.run.event",
      "activity.logged",
    ]));
    for (const value of seen) {
      expect(value.marker, value.type).toMatchObject({ status: "exhausted" });
      if (value.runStatus !== null) expect(value.runStatus, value.type).toBe("cancelled");
    }
  });

  it("serializes concurrent exhaustion comment repair across agent start locks", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("cost");
    const secondAgentId = randomUUID();
    await db.insert(agents).values({
      id: secondAgentId,
      companyId,
      name: "ConcurrentRecoveryAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db
      .update(issues)
      .set({
        status: "blocked",
        executionState: {
          recoveryBudget: {
            status: "exhausted",
            exhaustedBy: ["cost"],
            usage: {
              automaticRetries: 0,
              providerTurns: 1,
              providerTokens: 1,
              providerCostUsd: 0.25,
              runtimeMs: 1_000,
            },
          },
        },
      })
      .where(eq(issues.id, issueId));

    const firstHeartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const secondHeartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    await Promise.all([
      firstHeartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        contextSnapshot: { taskId: issueId, retryOfRunId: parentRunId },
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      }),
      secondHeartbeat.wakeup(secondAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        contextSnapshot: { taskId: issueId, retryOfRunId: parentRunId },
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      }),
    ]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Automatic recovery budget exhausted");
  });

  // AgentDash (recovery budget remediation): human remediation clears the
  // exhausted marker, only linked retries are gated, the ledger counts only
  // automatic retries, and the stranded reconciler leaves exhausted issues to
  // the human who has to clear them.
  function recoveryBudgetBoardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
      source: "session",
    };
  }

  function createRecoveryBudgetIssueApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(requestActorSourceMiddleware());
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function exhaustRecoveryBudgetThroughLinkedRetry(input: {
    agentId: string;
    issueId: string;
    parentRunId: string;
  }) {
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const refused = await heartbeat.wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId: input.issueId, retryOfRunId: input.parentRunId },
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: input.parentRunId,
      },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    const refusedRun = refused
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, refused.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(refusedRun?.errorCode).toBe("task_recovery_budget_exhausted");
    const issue = await db.select().from(issues).where(eq(issues.id, input.issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.executionState).toMatchObject({ recoveryBudget: { status: "exhausted" } });
    mockAdapterExecute.mockClear();
    return refusedRun!;
  }

  async function waitForAdapterRunOnIssue(agentId: string, issueId: string, knownRunIds: Set<string>) {
    const run = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "succeeded")));
      return rows.find((row) =>
        !knownRunIds.has(row.id) &&
        (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId
      ) ?? null;
    }, 5_000);
    return run;
  }

  async function expectRecoveryBudgetCleared(issueId: string, trigger: string) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect((issue?.executionState as Record<string, unknown> | null)?.recoveryBudget).toBeUndefined();
    const cleared = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.recovery_budget_cleared")));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ actorType: "user", actorId: "board-user", origin: "server" });
    expect(cleared[0]?.details).toMatchObject({
      trigger,
      clearedRecoveryBudget: { exhaustedBy: expect.arrayContaining(["attempts"]) },
    });
    return issue!;
  }

  async function knownRunIdsForAgent(agentId: string) {
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return new Set(rows.map((row) => row.id));
  }

  // AgentDash (recovery budget, explicit clear — 2026-09-30 founder decision):
  // a board user's status change, reopen-by-comment or reassignment no longer
  // clears an exhausted marker. Interim until the one-run permit: the run that
  // action starts still goes ahead; automatic retries stay refused.
  async function expectRecoveryBudgetKept(issueId: string) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.executionState).toMatchObject({ recoveryBudget: { status: "exhausted" } });
    const cleared = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.recovery_budget_cleared")));
    expect(cleared).toHaveLength(0);
    return issue!;
  }

  function expectRecoveryBudgetNotice(body: Record<string, unknown>, issueId: string) {
    expect(body.recoveryBudgetNotice).toMatchObject({
      status: "exhausted",
      exhaustedBy: expect.arrayContaining(["attempts"]),
      clearPath: `/api/issues/${issueId}/recovery-budget/clear`,
    });
    expect((body.recoveryBudgetNotice as { message: string }).message).toContain("Clear recovery block & retry");
  }

  async function expectLinkedRetryRefused(agentId: string, issueId: string, retryOfRunId: string) {
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    const continuation = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId },
      contextSnapshot: { issueId, taskId: issueId, retryReason: "issue_continuation_needed", retryOfRunId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    const continuationRun = continuation
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, continuation.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(continuationRun?.status).toBe("cancelled");
    expect(continuationRun?.errorCode).toBe("task_recovery_budget_exhausted");
  }

  it("keeps the exhausted marker when a board user moves the issue out of blocked; the unlinked wake it starts is refused", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const knownRunIds = await knownRunIdsForAgent(agentId);
    const adapterCallsBefore = mockAdapterExecute.mock.calls.length;

    const res = await request(createRecoveryBudgetIssueApp(recoveryBudgetBoardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("todo");
    expect(res.body.executionState?.recoveryBudget).toMatchObject({ status: "exhausted" });
    expectRecoveryBudgetNotice(res.body, issueId);
    await expectRecoveryBudgetKept(issueId);

    // Founder decision (permit + explicit clear): the interim
    // isRunStartedByPerson exemption is retired — an ordinary wake a board
    // user's action starts is refused like any other unlinked wake. Only the
    // exact run a confirmed task_recovery.remediate permit names can pass.
    const humanRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) =>
        !knownRunIds.has(row.id) &&
        (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId &&
        row.status !== "queued" && row.status !== "running" && row.status !== "scheduled_retry"
      ) ?? null;
    }, 5_000);
    expect(humanRun?.status).toBe("cancelled");
    expect(humanRun?.errorCode).toBe("task_recovery_budget_exhausted");
    await waitForHeartbeatIdle(db, 5_000);
    expect(mockAdapterExecute.mock.calls.length).toBe(adapterCallsBefore);

    // No fresh window was opened: automatic recovery is still refused.
    await expectRecoveryBudgetKept(issueId);
    await expectLinkedRetryRefused(agentId, issueId, humanRun!.id);
  });

  it("keeps the exhausted marker when a board user reopens the issue by comment; the unlinked wake it starts is refused", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const knownRunIds = await knownRunIdsForAgent(agentId);
    const adapterCallsBefore = mockAdapterExecute.mock.calls.length;

    const res = await request(createRecoveryBudgetIssueApp(recoveryBudgetBoardActor(companyId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Here is the revenue target you asked for; please continue." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expectRecoveryBudgetNotice(res.body, issueId);

    // The comment reopens the issue to `todo`; the wake it starts is refused
    // at claim, and the refusal moves the issue straight back to `blocked`
    // (reblockExhaustedIssue), so either status may be visible here.
    const issue = await expectRecoveryBudgetKept(issueId);
    expect(["todo", "blocked"]).toContain(issue.status);

    const humanRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) =>
        !knownRunIds.has(row.id) &&
        (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId &&
        row.status !== "queued" && row.status !== "running" && row.status !== "scheduled_retry"
      ) ?? null;
    }, 5_000);
    expect(humanRun?.status).toBe("cancelled");
    expect(humanRun?.errorCode).toBe("task_recovery_budget_exhausted");
    await waitForHeartbeatIdle(db, 5_000);
    expect(mockAdapterExecute.mock.calls.length).toBe(adapterCallsBefore);
    const reblocked = await expectRecoveryBudgetKept(issueId);
    expect(reblocked.status).toBe("blocked");
    await expectLinkedRetryRefused(agentId, issueId, humanRun!.id);
  });

  it("keeps the exhausted marker when a board user reassigns the issue", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    const nextAgentId = randomUUID();
    await db.insert(agents).values({
      id: nextAgentId,
      companyId,
      name: "NextOwner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const res = await request(createRecoveryBudgetIssueApp(recoveryBudgetBoardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: nextAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBe(nextAgentId);
    expectRecoveryBudgetNotice(res.body, issueId);

    await expectRecoveryBudgetKept(issueId);
    await waitForHeartbeatIdle(db, 5_000);
    await expectRecoveryBudgetKept(issueId);
  });

  it("keeps the exhausted marker through a review-request write on a pending stage", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const current = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    const stageId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Reviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: reviewerId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }],
            },
          ],
        },
        executionState: {
          ...(current.executionState as Record<string, unknown>),
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, issueId));

    const res = await request(createRecoveryBudgetIssueApp(recoveryBudgetBoardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ reviewRequest: { instructions: "Check the numbers first." } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const issue = await expectRecoveryBudgetKept(issueId);
    expect(issue.executionState).toMatchObject({
      status: "pending",
      reviewRequest: { instructions: "Check the numbers first." },
    });
    await waitForHeartbeatIdle(db, 5_000);
  });

  it("refuses a wake an assistant grant queued on an exhausted issue, as it refuses automatic ones", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const wakeAs = (explicitSource?: string) => {
      const wake = () =>
        heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId },
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
          requestedByActorType: "user",
          requestedByActorId: "board-user",
          ...(explicitSource ? { requestedByActorSource: explicitSource } : {}),
        });
      // Without an explicit source the wake reads the request's credential.
      return explicitSource ? wake() : runWithRequestActorSource("assistant_grant", wake);
    };

    for (const queued of [await wakeAs(), await wakeAs("assistant_grant")]) {
      const run = queued
        ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)).then((rows) => rows[0] ?? null)
        : null;
      expect(run?.status).toBe("cancelled");
      expect(run?.errorCode).toBe("task_recovery_budget_exhausted");
      expect((run?.contextSnapshot as Record<string, unknown> | null)?.requestedByActorSource).toBe("assistant_grant");
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("refuses the run an assistant grant's comment starts on an exhausted issue, and keeps the marker", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const knownRunIds = await knownRunIdsForAgent(agentId);

    const res = await request(
      createRecoveryBudgetIssueApp({
        ...recoveryBudgetBoardActor(companyId),
        isInstanceAdmin: false,
        source: "assistant_grant",
        assistantGrantId: randomUUID(),
        assistantClientName: "Test assistant",
      } as Express.Request["actor"]),
    )
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Keep going on this, please." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    // The comment reopens the issue and wakes the assignee after responding.
    const readNewRuns = () =>
      db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .then((rows) => rows.filter((row) => !knownRunIds.has(row.id)));
    await waitForValue(async () => ((await readNewRuns()).length > 0 ? true : null), 5_000);
    await waitForHeartbeatIdle(db, 5_000);
    const newRuns = await readNewRuns();
    expect(newRuns.length).toBeGreaterThan(0);
    for (const run of newRuns) {
      expect(run.errorCode).toBe("task_recovery_budget_exhausted");
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.executionState).toMatchObject({ recoveryBudget: { status: "exhausted" } });
  });

  it("clears the recovery block, audits it and retries only through the explicit board action", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const knownRunIds = await knownRunIdsForAgent(agentId);

    const agentRes = await request(createRecoveryBudgetIssueApp({
      type: "agent",
      agentId,
      companyId,
      runId: parentRunId,
      source: "agent_jwt",
    }))
      .post(`/api/issues/${issueId}/recovery-budget/clear`)
      .send({});
    expect(agentRes.status).toBe(403);

    const app = createRecoveryBudgetIssueApp(recoveryBudgetBoardActor(companyId));
    const res = await request(app).post(`/api/issues/${issueId}/recovery-budget/clear`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ cleared: true, retryQueued: true, issue: { status: "todo" } });

    await expectRecoveryBudgetCleared(issueId, "explicit_action");
    const humanRun = await waitForAdapterRunOnIssue(agentId, issueId, knownRunIds);
    expect(humanRun?.status).toBe("succeeded");
    await waitForHeartbeatIdle(db, 5_000);
    expect(humanRun?.contextSnapshot).toMatchObject({ wakeReason: "issue_recovery_budget_cleared" });

    const again = await request(app).post(`/api/issues/${issueId}/recovery-budget/clear`).send({});
    expect(again.status).toBe(409);
  });

  it("still refuses a system linked retry on an exhausted issue while a human wake runs", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const linked = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assignment_recovery",
      payload: { issueId, retryOfRunId: parentRunId },
      contextSnapshot: { issueId, taskId: issueId, retryReason: "assignment_recovery", retryOfRunId: parentRunId },
      requestedByActorType: "system",
      requestedByActorId: "recovery",
    });
    const linkedRun = linked
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, linked.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(linkedRun?.status).toBe("cancelled");
    expect(linkedRun?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(linkedRun?.error).toContain("Clear recovery block & retry");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Founder decision (permit + explicit clear): an unlinked, human-originated
    // wake is refused by the exhausted marker too — the only run that passes
    // is the exact one a confirmed task_recovery.remediate permit names.
    const human = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, mutation: "comment" },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", source: "issue.comment" },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    const humanRun = human
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, human.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(humanRun?.status).toBe("cancelled");
    expect(humanRun?.errorCode).toBe("task_recovery_budget_exhausted");

    // A wake is not a clear: the marker stays until a board user clears it.
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.executionState).toMatchObject({ recoveryBudget: { status: "exhausted" } });
  });

  it("refuses the parent wake when an agent closes a child issue it filed for itself on an exhausted issue", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    // An agent allowed to assign work (CEO-like): it can file a child for itself.
    await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, agentId));
    const knownRunIds = await knownRunIdsForAgent(agentId);
    const agentApp = createRecoveryBudgetIssueApp({
      type: "agent",
      agentId,
      companyId,
      runId: parentRunId,
      source: "agent_jwt",
    });

    const child = await request(agentApp)
      .post(`/api/issues/${issueId}/children`)
      .send({ title: "Self-assigned child", status: "todo", assigneeAgentId: agentId });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    await waitForHeartbeatIdle(db, 5_000);
    const closed = await request(agentApp)
      .patch(`/api/issues/${child.body.id}`)
      .send({ status: "done" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const parentWake = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) =>
        !knownRunIds.has(row.id) &&
        (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId &&
        (row.contextSnapshot as Record<string, unknown> | null)?.wakeReason === "issue_children_completed" &&
        row.status !== "queued" && row.status !== "running"
      ) ?? null;
    }, 5_000);
    expect(parentWake?.status).toBe("cancelled");
    expect(parentWake?.errorCode).toBe("task_recovery_budget_exhausted");
    await waitForHeartbeatIdle(db, 5_000);
    const parentRuns = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter((row) =>
        !knownRunIds.has(row.id) &&
        (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId);
    expect(parentRuns.every((row) => row.status === "cancelled")).toBe(true);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.executionState).toMatchObject({ recoveryBudget: { status: "exhausted" } });
  });

  it("refuses unlinked system- and agent-started wakes on an exhausted issue", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    for (const wake of [
      { reason: "issue_blockers_resolved", requestedByActorType: "system" as const, requestedByActorId: "system" },
      { reason: "issue_comment_mentioned", requestedByActorType: "agent" as const, requestedByActorId: randomUUID() },
      { reason: "issue_assigned", requestedByActorType: "agent" as const, requestedByActorId: randomUUID() },
    ]) {
      const queued = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wake.reason,
        payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: wake.reason },
        requestedByActorType: wake.requestedByActorType,
        requestedByActorId: wake.requestedByActorId,
      });
      const run = queued
        ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)).then((rows) => rows[0] ?? null)
        : null;
      expect(run?.status, wake.reason).toBe("cancelled");
      expect(run?.errorCode, wake.reason).toBe("task_recovery_budget_exhausted");
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("moves an exhausted issue an agent pulled out of blocked back to blocked when its retry is refused", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    await exhaustRecoveryBudgetThroughLinkedRetry({ agentId, issueId, parentRunId });
    // No clear: the assignee agent moved it on (checkout or PATCH).
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const retry = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId: parentRunId },
      contextSnapshot: { issueId, taskId: issueId, retryReason: "issue_continuation_needed", retryOfRunId: parentRunId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    const retryRun = retry
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)).then((rows) => rows[0] ?? null)
      : null;
    expect(retryRun?.errorCode).toBe("task_recovery_budget_exhausted");
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.map((comment) => comment.body.split(":")[0]).sort()).toEqual([
      "Automatic recovery budget exhausted. attempts=1/1, turns=1/12, tokens=1/500000, costUsd=0.010000/0.25, runtimeMs=1000/300000. Exhausted dimensions",
      "Automatic recovery is still blocked",
    ].sort());
  });

  // Founder decision (permit + explicit clear): a queued wake a person started
  // no longer survives the trip. It would be refused at claim anyway (only a
  // task_recovery.remediate permit's bound run passes), so it is cancelled
  // with the automatic siblings and the comment stays on the issue.
  it("cancels a queued person-started wake when the budget first trips", async () => {
    const { companyId, agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("attempts");
    const humanWakeId = randomUUID();
    const humanRunId = randomUUID();
    const trippingRunId = randomUUID();
    const automaticSiblingId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: humanWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "queued",
      runId: humanRunId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: humanRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        wakeupRequestId: humanWakeId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
      },
      {
        id: automaticSiblingId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        contextSnapshot: { issueId, taskId: issueId, retryOfRunId: parentRunId },
        retryOfRunId: parentRunId,
      },
      {
        // The second automatic retry: claiming it trips the budget.
        id: trippingRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId, taskId: issueId, retryReason: "issue_continuation_needed", retryOfRunId: parentRunId },
        retryOfRunId: parentRunId,
      },
    ]);
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    await heartbeat.resumeQueuedRuns();
    const tripped = await waitForValue(async () =>
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, trippingRunId)).then((rows) => {
        const row = rows[0] ?? null;
        return row && row.status !== "queued" ? row : null;
      }), 5_000);
    expect(tripped?.errorCode).toBe("task_recovery_budget_exhausted");

    const [humanRun, automaticSibling] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, humanRunId)).then((rows) => rows[0] ?? null),
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, automaticSiblingId)).then((rows) => rows[0] ?? null),
    ]);
    expect(humanRun?.status).toBe("cancelled");
    expect(humanRun?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(automaticSibling?.status).toBe("cancelled");
    expect(automaticSibling?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does not exhaust the budget on the first continuation after a long first run", async () => {
    // A long ordinary first run: 7 minutes and 20 turns, reading 732k tokens,
    // 690k of them from cache. That run is not recovery.
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
    });
    await db
      .update(heartbeatRuns)
      .set({
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt: new Date("2026-03-19T00:07:00.000Z"),
        usageJson: { inputTokens: 30_000, cachedInputTokens: 690_000, outputTokens: 12_000 },
        resultJson: { num_turns: 20, total_cost_usd: 0 },
      })
      .where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db);

    const continuation = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId: runId },
      contextSnapshot: { issueId, taskId: issueId, retryReason: "issue_continuation_needed", retryOfRunId: runId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    expect(continuation).not.toBeNull();
    const settled = await waitForRunToSettle(heartbeat, continuation!.id, 5_000);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.errorCode).toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).not.toBe("blocked");
    expect((issue?.executionState as Record<string, unknown> | null)?.recoveryBudget).toBeUndefined();
    await waitForHeartbeatIdle(db, 5_000);
  });

  it("the stranded reconciler re-blocks an exhausted issue left in todo and creates no repeat recovery issue", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "cancelled",
      retryReason: "assignment_recovery",
      runErrorCode: "task_recovery_budget_exhausted",
      runError: "Automatic recovery remains blocked after task recovery budget exhaustion (attempts=1/1, turns=20/12, tokens=720000/500000, costUsd=0.000000/0.25, runtimeMs=480000/300000).",
    });
    await db
      .update(issues)
      .set({
        executionState: {
          recoveryBudget: {
            status: "exhausted",
            exhaustedBy: ["attempts"],
            usage: { automaticRetries: 1, providerTurns: 20, providerTokens: 72_000, providerCostUsd: 0, runtimeMs: 480_000 },
          },
        },
      })
      .where(eq(issues.id, issueId));
    // The recovery issue an earlier round already produced, now done.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Recover stalled issue (earlier round)",
      status: "done",
      priority: "medium",
      parentId: issueId,
      assigneeAgentId: agentId,
      originKind: "stranded_issue_recovery",
      originId: issueId,
      originRunId: runId,
      issueNumber: 50,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-50`,
    });
    const runsBefore = await knownRunIdsForAgent(agentId);
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.recoveryBudgetReblocked).toBe(1);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(recoveryIssues).toHaveLength(1);
    const runsAfter = await knownRunIdsForAgent(agentId);
    expect(runsAfter.size).toBe(runsBefore.size);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.executionState).toMatchObject({ recoveryBudget: { status: "exhausted" } });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Automatic recovery is still blocked");
    expect(comments[0]?.body).toContain("attempts=1");
    expect(comments[0]?.body).toContain("Clear recovery block & retry");

    // Moved out of blocked again without a clear (an agent, say): re-blocked,
    // but the explanatory comment is not repeated within the same window.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const again = await heartbeat.reconcileStrandedAssignedIssues();
    expect(again.recoveryBudgetReblocked).toBe(1);
    const reblocked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(reblocked?.status).toBe("blocked");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
    const reblockActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
    expect(reblockActivity.map((row) => (row.details as Record<string, unknown>)?.source))
      .toEqual(["recovery.reconcile_stranded_assigned_issue", "recovery.reconcile_stranded_assigned_issue"]);
  });

  // AgentDash (Lane F1): the immediate terminal-run path holds a young issue
  // back from escalation; the periodic sweep escalates it after the window.
  it("releases a young issue whose continuation retry was lost, then escalates it after the minimum age", async () => {
    const { companyId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.continuation_recovery",
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    // Started two minutes ago: inside STRANDED_ISSUE_ESCALATION_MIN_AGE_MS.
    const startedAt = new Date(Date.now() - 2 * 60_000);
    await db.update(issues).set({ startedAt, createdAt: startedAt }).where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const reaped = await heartbeat.reapOrphanedRuns();
    expect(reaped.runIds).toEqual([runId]);
    // Let the post-reap release settle, then check nothing escalated.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const released = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(released?.status).toBe("in_progress");
    expect(released?.executionRunId).toBeNull();
    const earlyRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(earlyRecoveries).toHaveLength(0);

    const early = await heartbeat.reconcileStrandedAssignedIssues();
    expect(early.escalated).toBe(0);
    expect(early.escalationDeferred).toBe(1);

    const late = await heartbeat.reconcileStrandedAssignedIssues({
      now: new Date(Date.now() + 11 * 60_000),
    });
    expect(late.escalated).toBe(1);
    expect(late.issueIds).toEqual([issueId]);
    const blocked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(blocked?.status).toBe("blocked");
    const recoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveries.map((issue) => issue.originId)).toEqual([issueId]);
  });

  // AgentDash (Lane F1): the minimum age only delays escalation. An issue whose
  // recovery budget is exhausted is re-blocked at once, however young.
  it("re-blocks a young issue with an exhausted recovery budget without waiting for the minimum age", async () => {
    const { issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "cancelled",
      retryReason: "assignment_recovery",
      runErrorCode: "task_recovery_budget_exhausted",
      runError: "Automatic recovery remains blocked after task recovery budget exhaustion.",
    });
    const startedAt = new Date(Date.now() - 60_000);
    await db
      .update(issues)
      .set({
        createdAt: startedAt,
        executionState: {
          recoveryBudget: {
            status: "exhausted",
            exhaustedBy: ["attempts"],
            usage: { automaticRetries: 1, providerTurns: 1, providerTokens: 1, providerCostUsd: 0, runtimeMs: 1 },
          },
        },
      })
      .where(eq(issues.id, issueId));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.recoveryBudgetReblocked).toBe(1);
    expect(result.escalationDeferred).toBe(0);
    expect(result.escalated).toBe(0);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
  });

  it("names the recovery budget, with usage, when a budget-refused retry is escalated", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "cancelled",
      retryReason: "assignment_recovery",
      runErrorCode: "task_recovery_budget_exhausted",
      runError: "Automatic recovery remains blocked after task recovery budget exhaustion (attempts=1/1, turns=20/12, tokens=720000/500000, costUsd=0.000000/0.25, runtimeMs=480000/300000).",
    });
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("automatic recovery budget for this issue is exhausted");
    expect(comments[0]?.body).toContain("attempts=1/1, turns=20/12, tokens=720000/500000");
    expect(comments[0]?.body).toContain("Clear recovery block & retry");
    expect(comments[0]?.body).not.toContain("lost wake/run");

    const recovery = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)))
      .then((rows) => rows[0] ?? null);
    expect(recovery?.description).toContain("Cause: the automatic recovery budget for this issue is exhausted");
  });

  it("does not spend an exhausted-only agent sweep on a generic provider wake", async () => {
    const { agentId, issueId, parentRunId } = await seedExhaustedRecoveryBudgetFixture("cost");
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId, retryOfRunId: parentRunId },
      contextSnapshot: { issueId, taskId: issueId, retryOfRunId: parentRunId },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });
    const baseline = new Date("2026-08-26T12:00:00.000Z");
    await db
      .update(agents)
      .set({
        status: "idle",
        lastHeartbeatAt: baseline,
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 300,
            sweepIntervalSec: 300,
            requireWork: true,
          },
        },
      })
      .where(eq(agents.id, agentId));
    mockAdapterExecute.mockClear();

    const tick = await heartbeat.tickTimers(new Date(baseline.getTime() + 300_000));

    expect(tick.enqueued).toBe(0);
    expect(tick.skippedNoWork).toBe(1);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("releases active environment leases when an orphaned run is reaped", async () => {
    const { runId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const { leaseId } = await seedEnvironmentLeaseFixture({
      companyId,
      runId,
      issueId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const lease = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    expect(lease?.status).toBe("failed");
    expect(lease?.releasedAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.status).toBe("queued");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("blocks before an immediate continuation when process-loss recovery exhausts the aggregate budget", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    // The lost run is itself the automatic process-loss retry of an earlier
    // source run, so it is on the automatic-recovery ledger.
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-03-18T23:59:00.000Z"),
      finishedAt: new Date("2026-03-18T23:59:01.000Z"),
      errorCode: "process_lost",
      error: "process lost",
    });
    await db
      .update(heartbeatRuns)
      .set({ retryOfRunId: sourceRunId, contextSnapshot: { issueId, retryOfRunId: sourceRunId } })
      .where(eq(heartbeatRuns.id, runId));
    const resolvedBlockerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(3);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId && row.id !== sourceRunId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });
    expect(continuationRun?.status).toBe("cancelled");
    expect(continuationRun?.errorCode).toBe("task_recovery_budget_exhausted");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const blockedIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(blockedIssue?.status).toBe("blocked");
    expect(blockedIssue?.executionRunId).toBeNull();
    expect(blockedIssue?.checkoutRunId).toBeNull();
    expect(blockedIssue?.executionState).toMatchObject({
      recoveryBudget: {
        status: "exhausted",
        exhaustedBy: expect.arrayContaining(["time"]),
      },
    });

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryIssues).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Automatic recovery budget exhausted");
    expect(comments[0]?.body).toContain("runtimeMs=");
  });

  it("blocks failed recovery work in place during immediate terminal-run cleanup", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const recoveryIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);
    expect(recoveryIssue?.executionRunId).toBeNull();

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("sk-test-recovery-secret");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the issue immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe("same_session");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("dispatches assigned todo work with no prior run as a normal assignment wake", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryOfRunId).toBeNull();
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
      source: "issue.assigned_todo_liveness_dispatch",
    });
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.retryReason).toBeUndefined();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    if (runs[0]?.id) {
      await waitForRunToSettle(heartbeat, runs[0].id);
    }
  });

  it("does not duplicate initial assigned todo dispatch when a queued wake already exists", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("skips budget-blocked assigned todo work with no prior run and continues the sweep", async () => {
    const blocked = await seedAssignedTodoNoRunFixture();
    const unblocked = await seedAssignedTodoNoRunFixture();
    await db.insert(budgetPolicies).values({
      companyId: blocked.companyId,
      scopeType: "agent",
      scopeId: blocked.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: blocked.companyId,
      agentId: blocked.agentId,
      issueId: blocked.issueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([unblocked.issueId]);

    const blockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blocked.agentId));
    expect(blockedWakeups).toHaveLength(0);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blocked.agentId));
    expect(blockedRuns).toHaveLength(0);

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blocked.issueId))
      .then((rows) => rows[0] ?? null);
    expect(blockedIssue?.status).toBe("todo");

    const unblockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unblocked.agentId));
    expect(unblockedWakeups).toHaveLength(1);
    expect(unblockedWakeups[0]).toMatchObject({
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: unblocked.issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    const unblockedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, unblocked.agentId));
    expect(unblockedRuns).toHaveLength(1);
    if (unblockedRuns[0]?.id) {
      await waitForRunToSettle(heartbeat, unblockedRuns[0].id);
    }
  });

  it("does not dispatch assigned todo work with no prior run when the agent is paused", async () => {
    const { agentId, issueId } = await seedAssignedTodoNoRunFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it.each([
    ["failed", "adapter_failed"],
    ["failed", "process_lost"],
    ["timed_out", "adapter_timed_out"],
  ] as const)(
    "re-enqueues stranded in-progress work after a %s/%s run before escalating",
    async (runStatus, runErrorCode) => {
      const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus,
        runErrorCode,
      });
      const heartbeat = heartbeatService(db);

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.dispatchRequeued).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(2);

      const retryRun = runs.find((row) => row.id !== runId);
      expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
        issueId,
        taskId: issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
        source: "issue.continuation_recovery",
      });

      const recoveries = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, issueId),
          ),
        );
      expect(recoveries).toHaveLength(0);

      if (retryRun?.id) {
        await waitForRunToSettle(heartbeat, retryRun.id);
      }
    },
  );

  it("still re-enqueues stranded assigned todo recovery when an old queued wake exists", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
    });
    expect(recovery.description ?? "").not.toContain("sk-test-recovery-secret");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery issue: [${recovery.identifier}]`);
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${issuePrefix}-2](/${issuePrefix}/issues/${issuePrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: blockerIssueId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
    });
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      issueId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
      };
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileStrandedAssignedIssues();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 5_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });
  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain(`Recovery issue: [${recovery.identifier}]`);
  });

  it("redacts error-code-only stranded recovery failures in issue copy", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(recovery.description).toContain("Latest retry failure details were withheld from the issue thread");
    expect(recovery.description).not.toContain("- Failure: none recorded");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).not.toContain("- Failure: none recorded");
  });

  it("reuses the raced stranded recovery issue when duplicate active recovery creation conflicts", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
    });
    const heartbeat = heartbeatService(db);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => heartbeat.reconcileStrandedAssignedIssues()),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const recoveries = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "stranded_issue_recovery"),
        eq(issues.originId, issueId),
      ));
    expect(recoveries).toHaveLength(1);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([recoveries[0]?.id]);
  });

  it("blocks stranded recovery issues in place instead of creating nested recovery issues", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(recoveryIssue?.status).toBe("blocked");
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments[0]?.body).toContain("Latest retry failure details were withheld from the issue thread");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("keeps repeated recovery failures on the same canonical recovery issue", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "stranded_issue_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "adapter_failed",
      error: "adapter failed while retrying recovery issue",
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: secondRunId,
        executionRunId: null,
      })
      .where(eq(issues.id, issueId));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.dispatchRequeued).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const recoveryIssuesForSource = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, sourceIssueId)));
    expect(recoveryIssuesForSource.map((issue) => issue.id)).toEqual([issueId]);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("Latest retry failure details were withheld from the issue thread");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      activePauseHold: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeTruthy();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("re-enqueues recovery when the latest in-progress continuation made progress but left no live path", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
  });

  it("blocks stranded in-progress work after a productive continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("automatically retried continuation");
    expect(comments[0]?.body).toContain("still has no live execution path");
    expect(comments[0]?.body).toContain(`Recovery issue: [${recovery.identifier}]`);
  });

  it("allows one productive-terminal recovery after regular continuation recovery made progress", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.continuation_recovery",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
  });

  it("does not treat a productive terminal run as healthy when in-progress work has no live path", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const heartbeat = heartbeatService(db);

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: null,
    });

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const liveWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    expect(liveWakeups).toHaveLength(0);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.continuationRequeued + result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(comments).toHaveLength(0);
    expect(recoveryIssues).toHaveLength(0);
    expect(followupRuns).toHaveLength(2);
    const retryRun = followupRuns.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });

  /**
   * Observed on the UAT instance, 2026-08-14. The server was restarted while two
   * hermes_local runs were in flight. The reaper could not see their children any
   * more and wrote `process_lost` -- but hermes runs in a detached process group,
   * so both children survived the restart, finished the work, and reported back
   * with exit code 0 and a complete result (one of them an entire board pack).
   *
   * The completion path saw a terminal status already on the row and adopted it,
   * then -- because the adapter had reported no error to copy -- filled the reason
   * in with the generic "Adapter failed" / `adapter_failed`. Net effect: finished
   * work filed as a failure, the honest `process_lost` diagnosis overwritten with
   * a misleading one, and the agent parked in `error` on the dashboard with no way
   * back. On a box that restarts for backups or updates this is not an edge case.
   *
   * `process_lost` is an inference; an adapter exit code is an observation. The
   * observation wins.
   */
  it("lets a clean adapter exit overturn a process_lost verdict written mid-run", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();

    // The reaper fires while the adapter is still working -- exactly the restart
    // race -- and only then does the surviving child report its success.
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          errorCode: "process_lost",
          error: "Process lost -- server may have restarted",
          finishedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Assembled the weekly board pack.",
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    // NOT waitForRunToSettle: `failed` is a settled status, and this test's
    // whole premise is that the reaper writes exactly that mid-run. The helper
    // would hand back the intermediate row before the completion path overturns
    // it, and the assertions below would race the behaviour they exist to pin.
    // Wait for the overturn itself; fall back to a plain read on timeout so a
    // real regression still reports the status it actually found.
    const readRun = async () =>
      db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
    const run = (await waitForValue(async () => {
      const row = await readRun();
      return row?.status === "succeeded" ? row : null;
    })) ?? (await readRun());
    expect(run?.status, "work that finished was filed as a failure").toBe("succeeded");
    expect(run?.error).toBeNull();
    expect(run?.errorCode).toBeNull();

    const agent = await waitForValue(async () =>
      db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => {
        const row = rows[0] ?? null;
        return row?.status === "error" ? null : row;
      }),
    );
    expect(agent?.status, "a recovered agent kept reporting broken").not.toBe("error");

    // Same race, one row over: the issue's execution lock is released by the
    // completion path, not by the reaper.
    const readIssue = async () =>
      db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
    const issue = (await waitForValue(async () => {
      const row = await readIssue();
      return row && row.executionRunId === null ? row : null;
    })) ?? (await readIssue());
    expect(issue?.executionRunId).toBeNull();
  });

  /**
   * The other half of the same fix: adopting a terminal status must not invent a
   * reason. Here the adapter genuinely fails and carries no error text of its
   * own, so the recorded `process_lost` is the only true account of what
   * happened -- overwriting it with `adapter_failed` sent operators looking at
   * the adapter instead of at the restart.
   */
  it("keeps the recorded process_lost reason when the adapter fails without one", async () => {
    const { runId } = await seedQueuedIssueRunFixture();

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          errorCode: "process_lost",
          error: "Process lost -- server may have restarted",
          finishedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: null,
        provider: "test",
        model: "test-model",
      };
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
    expect(run?.error).toContain("Process lost");
  });
});
