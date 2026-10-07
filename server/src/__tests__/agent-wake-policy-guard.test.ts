import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentFactRequests,
  agentRuns,
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
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-policy guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("board_assignment_only wake policy guard", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-policy-guard-");
    db = createDb(tempDb.connectionString);
    // autoDispatchQueuedRuns: false — tests assert the enqueue/claim seam only;
    // no background adapter execution may outlive a test.
    heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });
  }, 120_000);

  afterEach(async () => {
    // Dispatched runs keep writing after the terminal status lands (runFacts,
    // the agent_runs ledger, wakeup status, release bookkeeping). Cancel any
    // still-queued/-running leftovers (e.g. a promoted run that was claimed
    // but never dispatched), wait for quiescence, then retry the parent-table
    // deletes so an in-flight write cannot surface as an FK violation.
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        updatedAt: new Date(),
        errorCode: "test_cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    await waitForHeartbeatIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(heartbeatRunEvents);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(workspaceOperations);
    await db.delete(agentFactRequests);
    await db.delete(issueWorkProducts);
    await db.delete(agentRuns);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
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
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(instanceSettings);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
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
      await db.delete(environments);
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
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedEnvironment(
    companyId: string,
    opts?: { driver?: string; name?: string; config?: Record<string, unknown> },
  ) {
    const environmentId = randomUUID();
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: opts?.name ?? "pairing-host",
      driver: opts?.driver ?? "ssh",
      status: "active",
      config: opts?.config ?? {},
    });
    return environmentId;
  }

  // `travelPairing: true` puts the agent under the board_assignment_only wake
  // policy via runtimeConfig.wakePolicy (the canonical setting) unless
  // `legacyAlias` asks for the old metadata.travelPairing flag instead.
  async function seedAgent(input: {
    companyId: string;
    travelPairing: boolean;
    legacyAlias?: boolean;
    defaultEnvironmentId?: string | null;
    name?: string;
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
  }) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name ?? "PairedHermes",
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType ?? "hermes_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 30,
          wakeOnDemand: true,
          requireWork: false,
          maxConcurrentRuns: 1,
        },
        ...(input.travelPairing && !input.legacyAlias ? { wakePolicy: "board_assignment_only" } : {}),
      },
      permissions: {},
      defaultEnvironmentId: input.defaultEnvironmentId ?? null,
      metadata: input.travelPairing && input.legacyAlias ? { pairing: "travel", travelPairing: true } : { pairing: "travel" },
    });
    return agentId;
  }

  async function seedAssignedIssue(input: { companyId: string; assigneeAgentId: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Reviewed brief",
      status: "todo",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
    });
    return issueId;
  }

  async function wakeupRowsFor(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
  }

  async function expectSkipRecorded(input: { agentId: string; reason: string; wakeCount?: number }) {
    const wakes = await wakeupRowsFor(input.agentId);
    expect(wakes).toHaveLength(input.wakeCount ?? 1);
    const skip = wakes[wakes.length - 1];
    expect(skip?.status).toBe("skipped");
    expect(skip?.reason).toBe(input.reason);
    const runs = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, input.agentId));
    expect(runs[0]?.count ?? 0).toBe(0);
  }

  async function countRunsForAgent(agentId: string) {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    return rows[0]?.count ?? 0;
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function waitForHeartbeatIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function refusalWakes(wakes: Awaited<ReturnType<typeof wakeupRowsFor>>, refusedReason: string) {
    return wakes.filter(
      (wake) => (wake.payload as Record<string, unknown> | null)?.refusedReason === refusedReason,
    );
  }

  // A live execution lock held by another agent's running run — the condition
  // that makes enqueueWakeup defer a wake and releaseIssueExecutionAndPromote
  // look for deferred wakes.
  async function seedExecutionLock(input: {
    companyId: string;
    issueId: string;
    holderAgentId: string;
    holderNameKey: string;
  }) {
    const lockRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: lockRunId,
      companyId: input.companyId,
      agentId: input.holderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
    });
    await db
      .update(issues)
      .set({
        executionRunId: lockRunId,
        executionAgentNameKey: input.holderNameKey,
        executionLockedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issueId));
    return lockRunId;
  }

  const boardKeyAssignmentWake = (issueId: string) => ({
    source: "assignment" as const,
    triggerDetail: "system" as const,
    reason: "issue_assigned",
    payload: { issueId, mutation: "create" },
    contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    requestedByActorType: "user" as const,
    requestedByActorId: "provisioner",
    requestedByActorSource: "board_key" as const,
  });

  it("refuses and records a timer wake for a travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });

    expect(run).toBeNull();
    await expectSkipRecorded({ agentId, reason: "travel_pairing.wake_source" });
  });

  it("refuses and records an on_demand wake for a travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_ping",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      requestedByActorSource: "board_key",
    });

    expect(run).toBeNull();
    await expectSkipRecorded({ agentId, reason: "travel_pairing.wake_source" });
  });

  it("refuses and records comment/automation wakes for a travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    for (const [index, reason] of ["issue_commented", "issue_comment_mentioned", "approval_approved"].entries()) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason,
        payload: { issueId, commentId: randomUUID() },
        contextSnapshot: { issueId, wakeReason: reason },
        requestedByActorType: "user",
        requestedByActorId: "local-board",
        requestedByActorSource: "session",
      });
      expect(run).toBeNull();

      const wakes = await wakeupRowsFor(agentId);
      expect(wakes).toHaveLength(index + 1);
      expect(wakes[index]?.status).toBe("skipped");
      expect(wakes[index]?.reason).toBe("travel_pairing.wake_source");
    }

    const runs = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs[0]?.count ?? 0).toBe(0);
  });

  it("refuses an assignment wake that is not an issue assignment", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_checked_out",
      payload: { issueId, mutation: "checkout" },
      contextSnapshot: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      requestedByActorSource: "board_key",
    });

    expect(run).toBeNull();
    await expectSkipRecorded({ agentId, reason: "travel_pairing.not_issue_assignment" });
  });

  it("refuses an issue_assigned wake that did not authenticate with a board key", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    for (const authSource of ["session", "assistant_grant", "agent_key"] as const) {
      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId, mutation: "create" },
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "user",
        requestedByActorId: "some-user",
        requestedByActorSource: authSource,
      });
      expect(run).toBeNull();
    }

    // No credential recorded at all — internal/system callers never carry one.
    const runWithoutAuth = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "create" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    expect(runWithoutAuth).toBeNull();

    const wakes = await wakeupRowsFor(agentId);
    expect(wakes).toHaveLength(4);
    for (const wake of wakes) {
      expect(wake.status).toBe("skipped");
      expect(wake.reason).toBe("travel_pairing.not_board_key");
    }
  });

  it("does not trust a board_key claim smuggled inside the caller payload", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "create", requestedVia: "board_key" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "some-user",
      // requestedByActorSource deliberately absent — the payload key must not count.
    });

    expect(run).toBeNull();
    await expectSkipRecorded({ agentId, reason: "travel_pairing.not_board_key" });
  });

  it("refuses a board-key issue assignment while defaultEnvironmentId is null", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: null });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "create" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "provisioner",
      requestedByActorSource: "board_key",
    });

    expect(run).toBeNull();
    await expectSkipRecorded({ agentId, reason: "travel_pairing.no_environment" });
  });

  it("allows a board-key issue assignment for a pinned travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "create" },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "provisioner",
      requestedByActorSource: "board_key",
    });

    expect(run).not.toBeNull();

    const wakes = await wakeupRowsFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).not.toBe("skipped");
    expect(wakes[0]?.runId).toBe(run?.id);
    // Provenance is persisted on the wake row payload for the harness to audit.
    expect((wakes[0]?.payload as Record<string, unknown> | null)?.requestedVia).toBe("board_key");

    const runRow = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(runRow?.invocationSource).toBe("assignment");
  });

  it("leaves non-flagged agents on the normal wake policy", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, travelPairing: false, defaultEnvironmentId: null });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_ping",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      requestedByActorSource: "session",
    });

    expect(run).not.toBeNull();

    const wakes = await wakeupRowsFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).not.toBe("skipped");
    expect(wakes[0]?.reason).toBe("manual_ping");
  });

  it("refuses and records a bounded retry scheduled outside the wake funnel", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      createdAt: now,
      updatedAt: now,
    });

    const result = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
    expect(result.outcome).toBe("skipped");

    // Exactly one wake row: the refusal record — and no new run was created.
    const wakes = await wakeupRowsFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("skipped");
    expect(wakes[0]?.reason).toBe("travel_pairing.wake_source");

    const runs = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs[0]?.count ?? 0).toBe(1); // only the original failed run
  });

  it("refuses and records a process-loss retry for a travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, requestedVia: "board_key" },
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
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      processPid: 999_999_999,
      processLossRetryCount: 0,
      startedAt: now,
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: "pairedhermes",
        executionLockedAt: now,
        status: "in_progress",
        updatedAt: now,
      })
      .where(eq(issues.id, issueId));

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    const reapedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(reapedRun?.status).toBe("failed");
    expect(reapedRun?.errorCode).toBe("process_lost");

    // The retry lane is refused: one skipped wake, no retry run.
    const refusals = refusalWakes(await wakeupRowsFor(agentId), "process_lost_retry");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.status).toBe("skipped");
    expect(refusals[0]?.reason).toBe("travel_pairing.wake_source");
    expect(await countRunsForAgent(agentId)).toBe(1); // only the reaped run
  });

  it("refuses and records an immediate-recovery wake for a travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const now = new Date();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, requestedVia: "board_key" },
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
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      // A lost process whose one process-loss retry is already spent: the
      // reaper fails it without retrying and releases the issue, which is
      // what sends a failed run into the immediate-recovery lane (a
      // cancelled run never self-continues on mainline).
      processPid: 999_999_998,
      processLossRetryCount: 1,
      startedAt: now,
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: "pairedhermes",
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issueId));

    const reaped = await heartbeat.reapOrphanedRuns();
    expect(reaped.reaped).toBe(1);

    const refusals = refusalWakes(await wakeupRowsFor(agentId), "issue_assignment_recovery");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.status).toBe("skipped");
    expect(refusals[0]?.reason).toBe("travel_pairing.wake_source");
    expect((refusals[0]?.payload as Record<string, unknown>)?.issueId).toBe(issueId);
    expect(await countRunsForAgent(agentId)).toBe(1); // only the reaped run

    // The execution lock was released even though recovery was refused.
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("r10: the stranded-issue sweep never touches a travelPairing agent (no refused wake rows)", async () => {
    // live p6-l-2026-10-03-1: a previous run's issue left in_progress with a
    // process_lost run was re-tried every 30 s; each guarded refusal landed
    // in the next run window as a foreign wake. A todo issue with no run
    // (the liveness dispatch lane) is swept by the same loop.
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const pairedId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const staleIssueId = await seedAssignedIssue({ companyId, assigneeAgentId: pairedId });
    const todoIssueId = await seedAssignedIssue({ companyId, assigneeAgentId: pairedId });
    const deadRunId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({
      id: deadRunId,
      companyId,
      agentId: pairedId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "process_lost",
      contextSnapshot: { issueId: staleIssueId, taskId: staleIssueId, wakeReason: "issue_assigned" },
      startedAt,
      finishedAt: new Date(),
    });
    await db
      .update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, staleIssueId));

    // A non-flagged agent with the same stranded shape is still recovered —
    // the exclusion is gated on the wake policy only.
    const plainId = await seedAgent({ companyId, travelPairing: false, name: "PlainAgent" });
    await seedAssignedIssue({ companyId, assigneeAgentId: plainId });

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await heartbeat.reconcileStrandedAssignedIssues();
    }

    expect(await wakeupRowsFor(pairedId)).toHaveLength(0);
    expect(await countRunsForAgent(pairedId)).toBe(1); // only the dead run
    expect(todoIssueId).toBeTruthy();
    expect((await wakeupRowsFor(plainId)).length).toBeGreaterThan(0);
  });

  it("refuses and records a missing-issue-comment retry for a travelPairing agent", async () => {
    // Real dispatch: this lane only runs inside run finalization, so the run
    // must execute. The pinned SSH environment carries no config, so
    // acquisition fails deterministically before any network I/O — the run
    // ends failed and uncommented, which is exactly the retry trigger.
    const dispatchingHeartbeat = heartbeatService(db);
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await dispatchingHeartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));
    expect(run).not.toBeNull();

    await waitFor(async () => {
      const row = await dispatchingHeartbeat.getRun(run!.id);
      return !!row && !["queued", "running"].includes(row.status);
    });
    const finished = await dispatchingHeartbeat.getRun(run!.id);
    expect(finished?.status).toBe("failed");

    await waitFor(async () =>
      refusalWakes(await wakeupRowsFor(agentId), "missing_issue_comment").length === 1,
    );
    const wakes = await wakeupRowsFor(agentId);
    const refusals = refusalWakes(wakes, "missing_issue_comment");
    expect(refusals[0]?.status).toBe("skipped");
    expect(refusals[0]?.reason).toBe("travel_pairing.wake_source");
    expect((refusals[0]?.payload as Record<string, unknown>)?.retryOfRunId).toBe(run!.id);
    expect(await countRunsForAgent(agentId)).toBe(1); // no retry run was created
  });

  it.each([
    {
      name: "non-assignment wake source",
      source: "automation",
      seedWakeReason: "issue_assigned",
      authSource: "board_key" as string | null,
      expectedReason: "travel_pairing.wake_source",
    },
    {
      name: "wake that is not an issue assignment",
      source: "assignment",
      seedWakeReason: "issue_comment_mentioned",
      authSource: "board_key",
      expectedReason: "travel_pairing.not_issue_assignment",
    },
    {
      name: "wake authenticated by a session, not a board key",
      source: "assignment",
      seedWakeReason: "issue_assigned",
      authSource: "session",
      expectedReason: "travel_pairing.not_board_key",
    },
    {
      name: "unattributed wake",
      source: "assignment",
      seedWakeReason: "issue_assigned",
      authSource: null,
      expectedReason: "travel_pairing.not_board_key",
    },
  ])(
    "refuses deferred promotion for a wake outside the board-key lane ($name)",
    async ({ source, seedWakeReason, authSource, expectedReason }) => {
      const companyId = await seedCompany();
      const environmentId = await seedEnvironment(companyId);
      const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
      const lockHolderId = await seedAgent({ companyId, travelPairing: false, name: "OtherAgent" });
      const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
      const lockRunId = await seedExecutionLock({
        companyId,
        issueId,
        holderAgentId: lockHolderId,
        holderNameKey: "otheragent",
      });
      const deferredWakeId = randomUUID();

      await db.insert(agentWakeupRequests).values({
        id: deferredWakeId,
        companyId,
        agentId,
        source,
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        requestedByActorType: "user",
        payload: {
          issueId,
          ...(authSource ? { requestedVia: authSource } : {}),
          _paperclipWakeContext: {
            issueId,
            taskId: issueId,
            wakeReason: seedWakeReason,
            wakeSource: source,
          },
        },
        status: "deferred_issue_execution",
      });

      await heartbeat.cancelRun(lockRunId);

      const deferredWake = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWakeId))
        .then((rows) => rows[0] ?? null);
      expect(deferredWake?.status).toBe("skipped");
      expect(deferredWake?.reason).toBe(expectedReason);
      expect(deferredWake?.runId).toBeNull();
      expect(await countRunsForAgent(agentId)).toBe(0); // no promoted run

      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue?.executionRunId).toBeNull(); // the lock release still stands
    },
  );

  it.each([
    { name: "no pinned environment", pin: "none" as const },
    { name: "pinned environment is not SSH", pin: "local" as const },
  ])("refuses deferred promotion when $name", async ({ pin }) => {
    const companyId = await seedCompany();
    const environmentId =
      pin === "local" ? await seedEnvironment(companyId, { driver: "local" }) : null;
    const agentId = await seedAgent({
      companyId,
      travelPairing: true,
      defaultEnvironmentId: environmentId,
    });
    const lockHolderId = await seedAgent({ companyId, travelPairing: false, name: "OtherAgent" });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    const lockRunId = await seedExecutionLock({
      companyId,
      issueId,
      holderAgentId: lockHolderId,
      holderNameKey: "otheragent",
    });
    const deferredWakeId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      requestedByActorType: "user",
      payload: {
        issueId,
        requestedVia: "board_key",
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
          wakeSource: "assignment",
        },
      },
      status: "deferred_issue_execution",
    });

    await heartbeat.cancelRun(lockRunId);

    const deferredWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0] ?? null);
    expect(deferredWake?.status).toBe("skipped");
    expect(deferredWake?.reason).toBe("travel_pairing.no_environment");
    expect(deferredWake?.runId).toBeNull();
    expect(await countRunsForAgent(agentId)).toBe(0);
  });

  it("promotes a deferred board-key issue assignment for a travelPairing agent", async () => {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId);
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
    const lockHolderId = await seedAgent({ companyId, travelPairing: false, name: "OtherAgent" });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    const lockRunId = await seedExecutionLock({
      companyId,
      issueId,
      holderAgentId: lockHolderId,
      holderNameKey: "otheragent",
    });

    // The wake cannot run while the issue is locked — it must be deferred.
    const deferredResult = await heartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));
    expect(deferredResult).toBeNull();

    const deferredWakes = await wakeupRowsFor(agentId);
    expect(deferredWakes).toHaveLength(1);
    expect(deferredWakes[0]?.status).toBe("deferred_issue_execution");
    expect(deferredWakes[0]?.reason).toBe("issue_execution_deferred");

    await heartbeat.cancelRun(lockRunId);

    const wakes = await wakeupRowsFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("claimed");
    expect(wakes[0]?.runId).not.toBeNull();

    const promotedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.id, wakes[0]!.runId!)))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun).not.toBeNull();
    expect(promotedRun?.invocationSource).toBe("assignment");
    // autoDispatchQueuedRuns is false — the promoted run is claimed and held
    // at "running" so the test never spawns an adapter.
    expect(promotedRun?.status).toBe("running");
    expect((promotedRun?.contextSnapshot as Record<string, unknown>)?.wakeReason).toBe(
      "issue_assigned",
    );
  });

  it("refuses a run whose resolved environment is not the pinned one", async () => {
    // A paired agent is pinned to env A (SSH), but the issue pins env B — the
    // workspace resolver would otherwise quietly run the agent on env B.
    const dispatchingHeartbeat = heartbeatService(db);
    const companyId = await seedCompany();
    const pinnedEnvironmentId = await seedEnvironment(companyId, { name: "pairing-host" });
    const issueEnvironmentId = await seedEnvironment(companyId, { driver: "local", name: "stray-local" });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const agentId = await seedAgent({
      companyId,
      travelPairing: true,
      defaultEnvironmentId: pinnedEnvironmentId,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    await db
      .update(issues)
      .set({ executionWorkspaceSettings: { environmentId: issueEnvironmentId }, updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    const run = await dispatchingHeartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));
    expect(run).not.toBeNull();

    // The wake going skipped is the settled state — it lands after the run is
    // cancelled and the lock release below it has run to completion.
    await waitFor(async () => {
      const wakes = await wakeupRowsFor(agentId);
      return (
        wakes.some(
          (wake) => wake.status === "skipped" && wake.reason === "travel_pairing.environment_mismatch",
        ) && wakes.filter((wake) => wake.status === "skipped").length === 1
      );
    });
    const finished = await dispatchingHeartbeat.getRun(run!.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe("travel_pairing.environment_mismatch");

    // The refused run is cancelled, and a cancelled run never self-continues,
    // so the refusal is the only wake row: no recovery wake follows it.
    const wakes = await wakeupRowsFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("skipped");
    expect(wakes[0]?.reason).toBe("travel_pairing.environment_mismatch");

    // The run-start auto-checkout is put back: the refused run leaves the
    // issue in its prior status and holding neither lock.
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();

    // No environment lease was ever acquired for this run.
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, run!.id));
    expect(leases).toHaveLength(0);
  });

  it("refuses a board-key assignment at the front door when the pin is a local environment", async () => {
    const companyId = await seedCompany();
    const localEnvironmentId = await seedEnvironment(companyId, { driver: "local", name: "local-pin" });
    const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: localEnvironmentId });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await heartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));

    expect(run).toBeNull();
    await expectSkipRecorded({ agentId, reason: "travel_pairing.no_environment" });
  });

  it("refuses at run start when the pin turned local after the wake was accepted", async () => {
    // A queued run accepted earlier (here: inserted directly, as if the pin
    // changed after the front door let it through). Run-start checkpoint 1
    // re-reads the pin and refuses before any lease or workspace exists.
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment(companyId, { driver: "local", name: "turned-local" });
    const agentId = await seedAgent({
      companyId,
      travelPairing: true,
      defaultEnvironmentId: environmentId,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "create", requestedVia: "board_key" },
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: "provisioner",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    await db.update(agentWakeupRequests).set({ runId: queuedRunId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    const run = { id: queuedRunId };

    const dispatchingHeartbeat = heartbeatService(db);
    await dispatchingHeartbeat.resumeQueuedRuns();

    await waitFor(async () => {
      const wakes = await wakeupRowsFor(agentId);
      return (
        wakes.some(
          (wake) => wake.status === "skipped" && wake.reason === "travel_pairing.no_environment",
        ) && wakes.filter((wake) => wake.status === "skipped").length === 1
      );
    });
    const finished = await dispatchingHeartbeat.getRun(run!.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe("travel_pairing.no_environment");
    expect(await countRunsForAgent(agentId)).toBe(1);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, run!.id));
    expect(leases).toHaveLength(0);
  });

  it("refuses a run steered to another environment by its persisted execution workspace", async () => {
    // A paired agent pinned to the SSH env is assigned an issue that reuses
    // a persisted execution workspace whose config pins a different
    // environment. The workspace's environmentId steers the resolved
    // environment (`workspaceConfig` wins in the resolver), and the
    // run-start guard must refuse before any lease is acquired on the
    // stray host.
    const dispatchingHeartbeat = heartbeatService(db);
    const companyId = await seedCompany();
    const pinnedEnvironmentId = await seedEnvironment(companyId, { name: "pairing-host" });
    const strayEnvironmentId = await seedEnvironment(companyId, { driver: "local", name: "stray-local" });
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reused workspace project",
      status: "in_progress",
    });
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reused workspace",
      status: "active",
      cwd: "/tmp/paperclip-travel-pairing-reused",
      providerType: "local_fs",
      metadata: { config: { environmentId: strayEnvironmentId } },
    });
    const agentId = await seedAgent({
      companyId,
      travelPairing: true,
      defaultEnvironmentId: pinnedEnvironmentId,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });
    await db
      .update(issues)
      .set({
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    const run = await dispatchingHeartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));
    expect(run).not.toBeNull();

    await waitFor(async () => {
      const wakes = await wakeupRowsFor(agentId);
      return (
        wakes.some(
          (wake) => wake.status === "skipped" && wake.reason === "travel_pairing.environment_mismatch",
        ) && wakes.filter((wake) => wake.status === "skipped").length === 1
      );
    });
    const finished = await dispatchingHeartbeat.getRun(run!.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe("travel_pairing.environment_mismatch");

    // The run-start auto-checkout is put back and neither lock survives.
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();

    // The mismatch is detectable from the resolved environment id, so the
    // refusal lands before acquisition: no lease was ever taken.
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, run!.id));
    expect(leases).toHaveLength(0);
  });

  it("refuses and releases the lease when acquisition lands on a different environment", async () => {
    // Second checkpoint: the pre-acquisition guard validates the RESOLVED
    // environment id, but `acquireForRun` acquires against the persisted
    // workspace's environment — a row whose config steered the lease past
    // that check, or drift between the two reads. The runtime stub below
    // stands in for that lane: the resolver returns the pin, while the
    // acquired lease is bound to a stray local environment. The run must be
    // refused, the stray lease released, and the workspace never realized.
    const companyId = await seedCompany();
    const pinnedEnvironmentId = await seedEnvironment(companyId, { name: "pairing-host" });
    const strayEnvironmentId = await seedEnvironment(companyId, { driver: "local", name: "stray-local" });
    const strayEnvironment = await db
      .select()
      .from(environments)
      .where(eq(environments.id, strayEnvironmentId))
      .then((rows) => rows[0] ?? null);
    expect(strayEnvironment).not.toBeNull();

    const realRuntime = environmentRuntimeService(db);
    const dispatchingHeartbeat = heartbeatService(db, {
      environmentRuntime: {
        ...realRuntime,
        acquireRunLease: (input) =>
          realRuntime.acquireRunLease({
            ...input,
            environment: strayEnvironment as Environment,
          }),
      },
    });
    const agentId = await seedAgent({
      companyId,
      travelPairing: true,
      defaultEnvironmentId: pinnedEnvironmentId,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

    const run = await dispatchingHeartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));
    expect(run).not.toBeNull();

    await waitFor(async () => {
      const wakes = await wakeupRowsFor(agentId);
      return (
        wakes.some(
          (wake) => wake.status === "skipped" && wake.reason === "travel_pairing.environment_mismatch",
        ) && wakes.filter((wake) => wake.status === "skipped").length === 1
      );
    });
    const finished = await dispatchingHeartbeat.getRun(run!.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.errorCode).toBe("travel_pairing.environment_mismatch");

    // The acquired lease was real — and is released by the refusal path
    // rather than left active on the stray environment.
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, run!.id));
    expect(leases).toHaveLength(1);
    expect(leases[0]?.environmentId).toBe(strayEnvironmentId);
    expect(leases[0]?.status).toBe("released");
    expect(leases[0]?.releasedAt).not.toBeNull();

    // Same refusal cleanup as the pre-acquisition lane: the issue returns
    // to its prior status holding neither lock, and no second run exists.
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
    expect(await countRunsForAgent(agentId)).toBe(1);
  });

  describe("legacy alias and policy resolution", () => {
    it("metadata.travelPairing === true enables the same policy (refuses a timer wake)", async () => {
      const companyId = await seedCompany();
      const environmentId = await seedEnvironment(companyId);
      const agentId = await seedAgent({
        companyId,
        travelPairing: true,
        legacyAlias: true,
        defaultEnvironmentId: environmentId,
      });

      const run = await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
      });

      expect(run).toBeNull();
      await expectSkipRecorded({ agentId, reason: "travel_pairing.wake_source" });
    });

    it("metadata.travelPairing === true still allows a pinned board-key issue assignment", async () => {
      const companyId = await seedCompany();
      const environmentId = await seedEnvironment(companyId);
      const agentId = await seedAgent({
        companyId,
        travelPairing: true,
        legacyAlias: true,
        defaultEnvironmentId: environmentId,
      });
      const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

      const run = await heartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));

      expect(run).not.toBeNull();
      expect(await countRunsForAgent(agentId)).toBe(1);
    });

    it("refuses a board-key 'issue_assigned' wake whose issue is not assigned to the agent", async () => {
      const companyId = await seedCompany();
      const environmentId = await seedEnvironment(companyId);
      const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
      const otherId = await seedAgent({ companyId, travelPairing: false, name: "OtherAgent" });
      const foreignIssueId = await seedAssignedIssue({ companyId, assigneeAgentId: otherId });

      // Someone else's issue, a missing issue, and no issue at all — the
      // generic wakeup endpoint could otherwise forge an "assignment".
      expect(await heartbeat.wakeup(agentId, boardKeyAssignmentWake(foreignIssueId))).toBeNull();
      expect(await heartbeat.wakeup(agentId, boardKeyAssignmentWake(randomUUID()))).toBeNull();
      expect(
        await heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "manual",
          reason: "issue_assigned",
          requestedByActorType: "user",
          requestedByActorId: "provisioner",
          requestedByActorSource: "board_key",
        }),
      ).toBeNull();

      const wakes = await wakeupRowsFor(agentId);
      expect(wakes).toHaveLength(3);
      for (const wake of wakes) {
        expect(wake.status).toBe("skipped");
        expect(wake.reason).toBe("travel_pairing.not_issue_assignment");
      }
      expect(await countRunsForAgent(agentId)).toBe(0);
    });

    it("the allowed path starts exactly one run for one board-key assignment", async () => {
      const companyId = await seedCompany();
      const environmentId = await seedEnvironment(companyId);
      const agentId = await seedAgent({ companyId, travelPairing: true, defaultEnvironmentId: environmentId });
      const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: agentId });

      const run = await heartbeat.wakeup(agentId, boardKeyAssignmentWake(issueId));

      expect(run).not.toBeNull();
      expect(await countRunsForAgent(agentId)).toBe(1);
      const wakes = await wakeupRowsFor(agentId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.status).not.toBe("skipped");
    });

    it("wakePolicy \"default\" and a non-true travelPairing value leave the agent unrestricted", async () => {
      const companyId = await seedCompany();
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "DefaultPolicy",
        role: "engineer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: { enabled: true, intervalSec: 30, wakeOnDemand: true, maxConcurrentRuns: 1 },
          wakePolicy: "default",
        },
        permissions: {},
        metadata: { travelPairing: "true" },
      });

      const run = await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
      });

      expect(run).not.toBeNull();
      const wakes = await wakeupRowsFor(agentId);
      expect(wakes[0]?.reason).toBe("heartbeat_timer");
    });

    it("non-policy agents are unaffected on every lane the policy closes", async () => {
      const companyId = await seedCompany();
      const plainId = await seedAgent({ companyId, travelPairing: false, name: "PlainAgent" });
      const issueId = await seedAssignedIssue({ companyId, assigneeAgentId: plainId });

      // A session-authenticated issue assignment without any environment pin.
      const assigned = await heartbeat.wakeup(plainId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId, mutation: "create" },
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "user",
        requestedByActorId: "some-user",
        requestedByActorSource: "session",
      });
      expect(assigned).not.toBeNull();

      // The policy's credential key is never added to a non-policy agent's wake.
      const wakes = await wakeupRowsFor(plainId);
      expect(wakes.some((wake) => wake.reason?.startsWith("travel_pairing."))).toBe(false);
      expect(
        wakes.some((wake) => Object.prototype.hasOwnProperty.call(wake.payload ?? {}, "requestedVia")),
      ).toBe(false);
    });
  });
});
