// AgentDash: goals-eval-hitl
//
// Real-PostgreSQL coverage for the CoS reviewer auto-hire paths that mocks
// cannot prove: the per-company advisory lock under true concurrency,
// transaction rollback of the pending agent, the runnable-status join,
// queue-item unassign/reassign on terminate/remove, the backlog sweep on
// activation, and the reviewerAgentId issue-list filter.

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  cosReviewerAssignments,
  createDb,
  issueReviewQueueState,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { cosReviewerAutoHire } from "../services/cos-reviewer-auto-hire.js";
import { cosVerdictOrchestrator } from "../services/cos-verdict-orchestrator.js";
import { issueService } from "../services/issues.js";
import {
  assignUnassignedReviewItems,
  pickAvailableReviewer,
} from "../services/review-queue-assignments.js";
import { verdictsService } from "../services/verdicts.js";

// A switch to inject a mid-transaction failure into the real approval create
// path — proves the pending agent rolls back instead of orphaning.
const failApprovalCreate = vi.hoisted(() => ({ current: false }));
vi.mock("../services/approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/approvals.js")>();
  return {
    ...mod,
    approvalService: (db: never) => {
      const svc = mod.approvalService(db);
      return {
        ...svc,
        create: async (...args: Parameters<typeof svc.create>) => {
          if (failApprovalCreate.current) {
            throw new Error("injected approval create failure");
          }
          return svc.create(...args);
        },
      };
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function seedCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `AutoHire ${randomUUID()}`,
      issuePrefix: `AH${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedReviewer(
  db: Db,
  companyId: string,
  opts: { status: string; hiredAt?: Date; retiredAt?: Date | null },
) {
  const agent = await db
    .insert(agents)
    .values({
      companyId,
      name: `Reviewer ${randomUUID().slice(0, 8)}`,
      role: "reviewer",
      status: opts.status,
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(cosReviewerAssignments).values({
    companyId,
    reviewerAgentId: agent.id,
    hiredAt: opts.hiredAt ?? new Date(),
    retiredAt: opts.retiredAt ?? null,
  });
  return agent;
}

async function seedIssue(db: Db, companyId: string, status = "in_review") {
  return db
    .insert(issues)
    .values({ companyId, title: `Issue ${randomUUID().slice(0, 8)}`, status })
    .returning()
    .then((rows) => rows[0]!);
}

async function enqueueIssue(
  db: Db,
  companyId: string,
  issueId: string,
  opts: { assigned?: string | null; enqueuedAt?: Date; escalateAfter?: Date | null } = {},
) {
  await db.insert(issueReviewQueueState).values({
    issueId,
    companyId,
    enqueuedAt: opts.enqueuedAt ?? new Date(),
    escalateAfter: opts.escalateAfter ?? new Date(Date.now() + 60_000),
    assignedReviewerAgentId: opts.assigned ?? null,
  });
}

async function queueRowsFor(db: Db, companyId: string) {
  return db
    .select()
    .from(issueReviewQueueState)
    .where(eq(issueReviewQueueState.companyId, companyId))
    .orderBy(asc(issueReviewQueueState.enqueuedAt));
}

describeEmbeddedPostgres("cos reviewer auto-hire (embedded postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cos-reviewer-auto-hire-");
    db = createDb(tempDb.connectionString);
    process.env.AGENTDASH_BILLING_DISABLED = "true";
  }, 120_000);

  afterEach(async () => {
    failApprovalCreate.current = false;
    delete process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES;
    delete process.env.AGENTDASH_REVIEWER_QUEUE_DEPTH_THRESHOLD;
    await db.delete(activityLog);
    await db.delete(issueReviewQueueState);
    await db.delete(cosReviewerAssignments);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalBillingDisabled === undefined) {
      delete process.env.AGENTDASH_BILLING_DISABLED;
    } else {
      process.env.AGENTDASH_BILLING_DISABLED = originalBillingDisabled;
    }
    await tempDb?.cleanup();
  });

  it("serializes concurrent evaluations to the cap on real connections", async () => {
    const company = await seedCompany(db);
    process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES = "1";

    // Two independent pools so the advisory lock contends across real
    // connections, the way two app instances (or two queue ticks) would.
    const db2 = createDb(tempDb!.connectionString);
    const provision = vi.fn().mockResolvedValue(undefined);
    const svcA = cosReviewerAutoHire(db, { provisionReviewer: provision });
    const svcB = cosReviewerAutoHire(db2, { provisionReviewer: provision });

    const [ra, rb] = await Promise.all([
      svcA.evaluateAndHireIfNeeded(company.id, "neutrality_conflict"),
      svcB.evaluateAndHireIfNeeded(company.id, "neutrality_conflict"),
    ]);

    const outcomes = [ra, rb].map((r) => (r.hired ? "hired" : r.reason));
    expect(outcomes.sort()).toEqual(["cap_reached", "hired"]);

    const agentRows = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]!.status).toBe("pending_approval");

    const assignmentRows = await db
      .select()
      .from(cosReviewerAssignments)
      .where(eq(cosReviewerAssignments.companyId, company.id));
    expect(assignmentRows).toHaveLength(1);

    const approvalRows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, company.id));
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.type).toBe("hire_agent");
    expect(approvalRows[0]!.payload).not.toHaveProperty("autoProvisionDefaultKey");
    expect(provision).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("hires up to the cap under concurrent calls, never beyond it", async () => {
    const company = await seedCompany(db);
    process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES = "2";

    const db2 = createDb(tempDb!.connectionString);
    const provision = vi.fn().mockResolvedValue(undefined);
    const callers = [db, db2, db, db2].map((conn) =>
      cosReviewerAutoHire(conn, { provisionReviewer: provision }),
    );

    const results = await Promise.all(
      callers.map((svc) => svc.evaluateAndHireIfNeeded(company.id, "neutrality_conflict")),
    );

    expect(results.filter((r) => r.hired)).toHaveLength(2);
    expect(results.filter((r) => !r.hired && r.reason === "cap_reached")).toHaveLength(2);

    const assignmentRows = await db
      .select()
      .from(cosReviewerAssignments)
      .where(eq(cosReviewerAssignments.companyId, company.id));
    expect(assignmentRows).toHaveLength(2);
  }, 60_000);

  it("rolls back the pending agent when approval creation fails mid-transaction", async () => {
    const company = await seedCompany(db);
    process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES = "3";
    failApprovalCreate.current = true;
    const provision = vi.fn().mockResolvedValue(undefined);
    const svc = cosReviewerAutoHire(db, { provisionReviewer: provision });

    await expect(
      svc.evaluateAndHireIfNeeded(company.id, "neutrality_conflict"),
    ).rejects.toThrow("injected approval create failure");

    // No orphan agent, no dangling assignment, no approval, no activity rows.
    expect(
      (await db.select().from(agents).where(eq(agents.companyId, company.id))).length,
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(cosReviewerAssignments)
          .where(eq(cosReviewerAssignments.companyId, company.id))
      ).length,
    ).toBe(0);
    expect(
      (await db.select().from(approvals).where(eq(approvals.companyId, company.id))).length,
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, company.id))
      ).length,
    ).toBe(0);
    expect(provision).not.toHaveBeenCalled();
  }, 60_000);

  it("pickAvailableReviewer ignores paused/error/terminated reviewers", async () => {
    const company = await seedCompany(db);
    const oldest = new Date("2024-01-01T00:00:00Z");
    // Terminated is the oldest — it must still never be picked.
    await seedReviewer(db, company.id, { status: "terminated", hiredAt: oldest });
    await seedReviewer(db, company.id, {
      status: "paused",
      hiredAt: new Date("2024-01-02T00:00:00Z"),
    });
    await seedReviewer(db, company.id, {
      status: "error",
      hiredAt: new Date("2024-01-03T00:00:00Z"),
    });
    const runnable = await seedReviewer(db, company.id, {
      status: "running",
      hiredAt: new Date("2024-01-04T00:00:00Z"),
    });
    await seedReviewer(db, company.id, {
      status: "idle",
      hiredAt: new Date("2024-01-05T00:00:00Z"),
    });

    expect(await pickAvailableReviewer(db, company.id)).toBe(runnable.id);
  });

  it("assignUnassignedReviewItems round-robins across runnable reviewers", async () => {
    const company = await seedCompany(db);
    const first = await seedReviewer(db, company.id, {
      status: "idle",
      hiredAt: new Date("2024-01-01T00:00:00Z"),
    });
    const second = await seedReviewer(db, company.id, {
      status: "idle",
      hiredAt: new Date("2024-01-02T00:00:00Z"),
    });
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      const issue = await seedIssue(db, company.id);
      await enqueueIssue(db, company.id, issue.id, {
        enqueuedAt: new Date(Date.now() + i * 1000),
      });
      rows.push(issue.id);
    }

    const assigned = await assignUnassignedReviewItems(db, company.id);
    expect(assigned).toBe(3);

    const queue = await queueRowsFor(db, company.id);
    expect(queue.map((r) => r.assignedReviewerAgentId)).toEqual([
      first.id,
      second.id,
      first.id,
    ]);
  });

  it("terminate unassigns queue items and retires the assignment", async () => {
    const company = await seedCompany(db);
    const doomed = await seedReviewer(db, company.id, { status: "running" });
    const survivor = await seedReviewer(db, company.id, { status: "idle" });
    for (let i = 0; i < 2; i += 1) {
      const issue = await seedIssue(db, company.id);
      await enqueueIssue(db, company.id, issue.id, { assigned: doomed.id });
    }

    await agentService(db).terminate(doomed.id);

    const queue = await queueRowsFor(db, company.id);
    expect(queue.every((r) => r.assignedReviewerAgentId === null)).toBe(true);
    const retired = await db
      .select()
      .from(cosReviewerAssignments)
      .where(eq(cosReviewerAssignments.reviewerAgentId, doomed.id));
    expect(retired[0]!.retiredAt).not.toBeNull();

    // The sweep can now hand the freed work to the surviving reviewer.
    expect(await assignUnassignedReviewItems(db, company.id)).toBe(2);
    const reassigned = await queueRowsFor(db, company.id);
    expect(reassigned.every((r) => r.assignedReviewerAgentId === survivor.id)).toBe(true);
  });

  it("remove clears assigned_reviewer_agent_id and the assignment row", async () => {
    const company = await seedCompany(db);
    const pending = await seedReviewer(db, company.id, { status: "pending_approval" });
    const issue = await seedIssue(db, company.id);
    await enqueueIssue(db, company.id, issue.id, { assigned: pending.id });

    await agentService(db).remove(pending.id);

    const queue = await queueRowsFor(db, company.id);
    expect(queue[0]!.assignedReviewerAgentId).toBeNull();
    expect(
      (
        await db
          .select()
          .from(cosReviewerAssignments)
          .where(eq(cosReviewerAssignments.reviewerAgentId, pending.id))
      ).length,
    ).toBe(0);
    expect((await db.select().from(agents).where(eq(agents.id, pending.id))).length).toBe(0);
  });

  it("activatePendingApproval distributes the queued backlog to the new reviewer", async () => {
    const company = await seedCompany(db);
    const pending = await seedReviewer(db, company.id, { status: "pending_approval" });
    for (let i = 0; i < 2; i += 1) {
      const issue = await seedIssue(db, company.id);
      await enqueueIssue(db, company.id, issue.id);
    }

    const result = await agentService(db).activatePendingApproval(pending.id);
    expect(result?.activated).toBe(true);
    expect(result?.agent.status).toBe("idle");

    const queue = await queueRowsFor(db, company.id);
    expect(queue.every((r) => r.assignedReviewerAgentId === pending.id)).toBe(true);
  });

  it("runReviewCycle assigns unassigned work before scanning for escalation", async () => {
    const company = await seedCompany(db);
    const reviewer = await seedReviewer(db, company.id, { status: "idle" });
    const issue = await seedIssue(db, company.id);
    await enqueueIssue(db, company.id, issue.id);

    const evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false });
    const orch = cosVerdictOrchestrator(db, {
      verdicts: verdictsService(db),
      featureFlags: {} as never,
      autoHire: { evaluateAndHireIfNeeded },
    });

    await orch.runReviewCycle(company.id);

    const queue = await queueRowsFor(db, company.id);
    expect(queue[0]!.assignedReviewerAgentId).toBe(reviewer.id);
  });

  it("issue list reviewerAgentId filter returns only that reviewer's queue items", async () => {
    const company = await seedCompany(db);
    const reviewer = await seedReviewer(db, company.id, { status: "idle" });
    const other = await seedReviewer(db, company.id, { status: "idle" });
    const mine1 = await seedIssue(db, company.id);
    const mine2 = await seedIssue(db, company.id);
    const theirs = await seedIssue(db, company.id);
    const nobody = await seedIssue(db, company.id);
    await enqueueIssue(db, company.id, mine1.id, { assigned: reviewer.id });
    await enqueueIssue(db, company.id, mine2.id, { assigned: reviewer.id });
    await enqueueIssue(db, company.id, theirs.id, { assigned: other.id });
    await enqueueIssue(db, company.id, nobody.id);

    const svc = issueService(db);
    const listed = await svc.list(company.id, {
      status: "in_review",
      reviewerAgentId: reviewer.id,
    });
    const ids = listed.map((row) => row.id).sort();
    expect(ids).toEqual([mine1.id, mine2.id].sort());
  });
});
