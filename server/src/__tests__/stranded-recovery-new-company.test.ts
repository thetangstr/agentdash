// AgentDash (Lane F1): a brand-new company's single CoS agent starts several
// issues at once. Minutes after the onboarding wizard launched, the stranded-
// work reconciler filed "Recover stalled issue BRI-2" against the CoS while it
// was simply busy: some issues were checked out from another issue's live run,
// some were queued behind it, and one early retry had been cancelled. None of
// that is a stall. This reproduces the sequence and proves no recovery issue is
// filed inside the minimum age, and that escalation still happens after it.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "done",
        provider: "test",
        model: "test",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import {
  STRANDED_ISSUE_ESCALATION_MIN_AGE_MS,
  isInsideStrandedEscalationGrace,
} from "../services/recovery/service.ts";
import { DEFAULT_FIRST_OUTPUT_DEADLINE_MS } from "../services/run-liveness-probe.ts";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping new-company stranded recovery tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("stranded escalation minimum age", () => {
  it("matches the first-output deadline", () => {
    expect(STRANDED_ISSUE_ESCALATION_MIN_AGE_MS).toBe(DEFAULT_FIRST_OUTPUT_DEADLINE_MS);
  });

  it("anchors on startedAt, falling back to createdAt", () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60_000);
    const elevenMinutesAgo = new Date(now.getTime() - 11 * 60_000);
    expect(isInsideStrandedEscalationGrace({ startedAt: twoMinutesAgo, createdAt: elevenMinutesAgo }, now)).toBe(true);
    expect(isInsideStrandedEscalationGrace({ startedAt: null, createdAt: twoMinutesAgo }, now)).toBe(true);
    expect(isInsideStrandedEscalationGrace({ startedAt: null, createdAt: elevenMinutesAgo }, now)).toBe(false);
    expect(isInsideStrandedEscalationGrace({ startedAt: elevenMinutesAgo, createdAt: elevenMinutesAgo }, now)).toBe(false);
  });
});

describeEmbeddedPostgres("stranded-work recovery on a brand-new company (Lane F1)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("stranded-new-company-");
    db = createDb(temp.connectionString);
  }, 60_000);

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function seedNewCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `B${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const now = Date.now();
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Brightline Dental",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    // One agent, one run at a time: everything else queues behind it.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CoS",
      role: "chief_of_staff",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const ids = {
      busy: randomUUID(), // BRI-1: the run in flight
      checkedOutBySibling: randomUUID(), // BRI-2: checked out from BRI-1's run
      cancelledRetry: randomUUID(), // BRI-3: its one continuation retry was cancelled
      failedDispatch: randomUUID(), // BRI-4: todo, its dispatch retry failed
      queued: randomUUID(), // BRI-5: todo, queued behind the busy agent
    };
    const runs = {
      busy: randomUUID(),
      cancelledRetry: randomUUID(),
      failedDispatch: randomUUID(),
      queued: randomUUID(),
    };

    await db.insert(heartbeatRuns).values([
      {
        id: runs.busy,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { issueId: ids.busy, taskId: ids.busy, wakeReason: "issue_assigned" },
        startedAt: minutesAgo(3),
        lastOutputAt: minutesAgo(1),
      },
      {
        id: runs.cancelledRetry,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "cancelled",
        contextSnapshot: {
          issueId: ids.cancelledRetry,
          taskId: ids.cancelledRetry,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.continuation_recovery",
        },
        startedAt: minutesAgo(1),
        finishedAt: minutesAgo(1),
        errorCode: "cancelled",
        error: "cancelled",
      },
      {
        id: runs.failedDispatch,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        contextSnapshot: {
          issueId: ids.failedDispatch,
          taskId: ids.failedDispatch,
          wakeReason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "issue.assignment_recovery",
        },
        startedAt: minutesAgo(1),
        finishedAt: minutesAgo(1),
        errorCode: "adapter_failed",
        error: "adapter failed",
      },
      {
        id: runs.queued,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: ids.queued, taskId: ids.queued, wakeReason: "issue_assigned" },
      },
    ]);

    const issueBase = {
      companyId,
      priority: "medium",
      assigneeAgentId: agentId,
      createdAt: minutesAgo(3),
    };
    await db.insert(issues).values([
      {
        ...issueBase,
        id: ids.busy,
        title: "Assemble the weekly who-is-waiting review",
        status: "in_progress",
        checkoutRunId: runs.busy,
        executionRunId: runs.busy,
        startedAt: minutesAgo(3),
        issueNumber: 1,
        identifier: `${prefix}-1`,
      },
      {
        ...issueBase,
        id: ids.checkedOutBySibling,
        title: "Collect clients waiting on a reply or a decision",
        status: "in_progress",
        checkoutRunId: runs.busy,
        startedAt: minutesAgo(2),
        issueNumber: 2,
        identifier: `${prefix}-2`,
      },
      {
        ...issueBase,
        id: ids.cancelledRetry,
        title: "Collect candidates waiting on us",
        status: "in_progress",
        startedAt: minutesAgo(2),
        issueNumber: 3,
        identifier: `${prefix}-3`,
      },
      {
        ...issueBase,
        id: ids.failedDispatch,
        title: "Name the owner for each item",
        status: "todo",
        issueNumber: 4,
        identifier: `${prefix}-4`,
      },
      {
        ...issueBase,
        id: ids.queued,
        title: "Get oriented and tell the operator how to use you",
        status: "todo",
        issueNumber: 5,
        identifier: `${prefix}-5`,
      },
    ]);

    return { companyId, agentId, ids };
  }

  async function recoveryIssuesFor(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.strandedIssueRecovery),
        ),
      );
  }

  // A linked run stuck in `running` stops vouching for the issues it checked
  // out once it is silent past the suspicion threshold or older than the
  // critical threshold; a fresh one keeps vouching.
  it.each([
    { label: "fresh", startedMinutesAgo: 3, lastOutputMinutesAgo: 1, live: true },
    { label: "silent past the suspicion threshold", startedMinutesAgo: 90, lastOutputMinutesAgo: 70, live: false },
    { label: "older than the critical threshold", startedMinutesAgo: 5 * 60, lastOutputMinutesAgo: 1, live: false },
  ])("a $label linked run counts as live for a checked-out sibling: $live", async ({ startedMinutesAgo, lastOutputMinutesAgo, live }) => {
    const { companyId, agentId, ids } = await seedNewCompany();
    // Drop the other fixtures out of the sweep so only the sibling is judged.
    await db
      .update(issues)
      .set({ status: "done" })
      .where(inArray(issues.id, [ids.cancelledRetry, ids.failedDispatch, ids.queued]));
    const busyRun = await db
      .select()
      .from(issues)
      .where(eq(issues.id, ids.busy))
      .then((rows) => rows[0]!.executionRunId!);
    await db
      .update(heartbeatRuns)
      .set({
        startedAt: new Date(Date.now() - startedMinutesAgo * 60_000),
        processStartedAt: new Date(Date.now() - startedMinutesAgo * 60_000),
        lastOutputAt: new Date(Date.now() - lastOutputMinutesAgo * 60_000),
      })
      .where(eq(heartbeatRuns.id, busyRun));
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    const siblingTouched = result.issueIds.includes(ids.checkedOutBySibling);
    expect(siblingTouched).toBe(!live);
    if (!live) {
      // No longer hidden: the sweep queues a continuation for it.
      const siblingRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
      expect(
        siblingRuns.some((run) =>
          (run.contextSnapshot as Record<string, unknown> | null)?.issueId === ids.checkedOutBySibling),
      ).toBe(true);
    }
  });

  it("files no recovery issue while one agent works through several new issues, and escalates only after the minimum age", async () => {
    const { companyId, ids } = await seedNewCompany();
    const heartbeat = heartbeatService(db, { autoDispatchQueuedRuns: false });

    // Minutes after launch: nothing is stalled.
    const early = await heartbeat.reconcileStrandedAssignedIssues();
    expect(early.escalated).toBe(0);
    expect(early.escalationDeferred).toBe(2);
    expect(await recoveryIssuesFor(companyId)).toHaveLength(0);

    const sourceIds = Object.values(ids);
    const afterEarly = await db.select().from(issues).where(inArray(issues.id, sourceIds));
    expect(afterEarly.filter((issue) => issue.status === "blocked")).toHaveLength(0);
    expect(afterEarly.find((issue) => issue.id === ids.checkedOutBySibling)?.status).toBe("in_progress");

    // Run the sweep again a few minutes later, still inside the window.
    const stillEarly = await heartbeat.reconcileStrandedAssignedIssues({
      now: new Date(Date.now() + 5 * 60_000),
    });
    expect(stillEarly.escalated).toBe(0);
    expect(await recoveryIssuesFor(companyId)).toHaveLength(0);

    // Past the window, the two issues whose automatic retry really failed are
    // escalated. The issue checked out by the busy agent's live run is not.
    const late = await heartbeat.reconcileStrandedAssignedIssues({
      now: new Date(Date.now() + STRANDED_ISSUE_ESCALATION_MIN_AGE_MS + 60_000),
    });
    expect(late.escalated).toBe(2);
    expect(late.escalationDeferred).toBe(0);
    const recoveries = await recoveryIssuesFor(companyId);
    expect(recoveries.map((issue) => issue.originId).sort()).toEqual(
      [ids.cancelledRetry, ids.failedDispatch].sort(),
    );
    const sibling = await db
      .select()
      .from(issues)
      .where(eq(issues.id, ids.checkedOutBySibling))
      .then((rows) => rows[0]);
    expect(sibling?.status).toBe("in_progress");
  });
});
