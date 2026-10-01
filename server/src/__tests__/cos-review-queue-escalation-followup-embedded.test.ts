// AgentDash: #849 follow-up — review-queue escalation hardening.
//
// Embedded-PostgreSQL coverage for three post-merge review findings on the
// once-per-item escalation work (PR #849):
//
//  1. A reviewerless item whose only owner/admin is also the issue's assignee
//     made the neutral-validator 409 escape runReviewCycle, stalling the whole
//     company's queue (and its auto-hire check) on every 60s tick.
//  2. A second review round (issue sent back for revision, then returned to
//     in_review) never escalated: enqueuedAt was not reset on re-entry, so the
//     first round's revision_requested verdict counted as "already open".
//  3. The escalation's verdict + approval + link were not atomic, and two
//     overlapping sweeps could both escalate the same item.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  cosReviewerAssignments,
  createDb,
  issueApprovals,
  issueReviewQueueState,
  issues,
  verdicts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cosVerdictOrchestrator } from "../services/cos-verdict-orchestrator.js";
import { verdictsService } from "../services/verdicts.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("review-queue escalation follow-up (embedded postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-queue-followup-");
    db = createDb(tempDb.connectionString);
    process.env.AGENTDASH_BILLING_DISABLED = "true";
  }, 120_000);

  afterEach(async () => {
    delete process.env.AGENTDASH_VERDICT_ESCALATE_AFTER_MS;
    await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_approval_insert ON approvals`);
    await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_approval_insert()`);
    await db.delete(activityLog);
    await db.delete(verdicts);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueReviewQueueState);
    await db.delete(cosReviewerAssignments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
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

  async function seedCompany(): Promise<{ id: string }> {
    return db
      .insert(companies)
      .values({
        name: `Followup ${randomUUID()}`,
        issuePrefix: `FU${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedMember(companyId: string, role: "owner" | "admin", createdAt: Date) {
    const principalId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId,
      status: "active",
      membershipRole: role,
      createdAt,
    });
    return principalId;
  }

  async function seedIssue(companyId: string, assigneeUserId: string | null = null) {
    return db
      .insert(issues)
      .values({
        companyId,
        title: `Followup ${randomUUID().slice(0, 8)}`,
        status: "in_review",
        assigneeUserId,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function enqueueStranded(
    companyId: string,
    issueId: string,
    enqueuedAt: Date,
    escalateAfter: Date,
  ) {
    await db.insert(issueReviewQueueState).values({
      issueId,
      companyId,
      enqueuedAt,
      escalateAfter,
      assignedReviewerAgentId: null,
    });
  }

  function orchestrator(evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false })) {
    return {
      evaluateAndHireIfNeeded,
      orch: cosVerdictOrchestrator(db, {
        verdicts: verdictsService(db),
        featureFlags: {} as never,
        autoHire: { evaluateAndHireIfNeeded } as never,
      }),
    };
  }

  async function verdictsFor(issueId: string) {
    return db.select().from(verdicts).where(eq(verdicts.issueId, issueId));
  }

  async function approvalsFor(companyId: string) {
    return db.select().from(approvals).where(eq(approvals.companyId, companyId));
  }

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  // -------------------------------------------------------------------------
  // Finding 1: the assignee is the only escalation target
  // -------------------------------------------------------------------------

  it("a one-human company's self-assigned stranded item escalates without stalling the queue", async () => {
    const company = await seedCompany();
    const owner = await seedMember(company.id, "owner", minutesAgo(60));
    // Oldest in the queue, so before the fix it threw first and the second
    // item (and the auto-hire check) never ran.
    const selfAssigned = await seedIssue(company.id, owner);
    await enqueueStranded(company.id, selfAssigned.id, minutesAgo(10), minutesAgo(5));
    const other = await seedIssue(company.id);
    await enqueueStranded(company.id, other.id, minutesAgo(9), minutesAgo(5));

    const { orch, evaluateAndHireIfNeeded } = orchestrator();
    await expect(orch.runReviewCycle(company.id)).resolves.toBeUndefined();

    // The self-assigned item is surfaced without naming the assignee as its
    // own neutral validator.
    const selfVerdicts = await verdictsFor(selfAssigned.id);
    expect(selfVerdicts).toHaveLength(1);
    expect(selfVerdicts[0]!.outcome).toBe("escalated_to_human");
    expect(selfVerdicts[0]!.reviewerUserId).toBe("unassigned");
    expect(selfVerdicts[0]!.reviewerUserId).not.toBe(owner);

    // The rest of the queue still ran: the other item escalated to the owner.
    const otherVerdicts = await verdictsFor(other.id);
    expect(otherVerdicts).toHaveLength(1);
    expect(otherVerdicts[0]!.reviewerUserId).toBe(owner);

    expect(await approvalsFor(company.id)).toHaveLength(2);
    // And the once-per-cycle auto-hire check still ran.
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledTimes(1);
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledWith(company.id, "queue_depth");

    // Surfaced once, not retried forever.
    await orch.runReviewCycle(company.id);
    expect(await verdictsFor(selfAssigned.id)).toHaveLength(1);
    expect(await approvalsFor(company.id)).toHaveLength(2);
  }, 60_000);

  it("escalates to the next owner/admin when the oldest one is the assignee", async () => {
    const company = await seedCompany();
    const assigneeOwner = await seedMember(company.id, "owner", minutesAgo(60));
    const admin = await seedMember(company.id, "admin", minutesAgo(30));
    const issue = await seedIssue(company.id, assigneeOwner);
    await enqueueStranded(company.id, issue.id, minutesAgo(10), minutesAgo(5));

    const { orch } = orchestrator();
    await orch.runReviewCycle(company.id);

    const rows = await verdictsFor(issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reviewerUserId).toBe(admin);
    const approvalRows = await approvalsFor(company.id);
    expect(approvalRows).toHaveLength(1);
    const links = await db
      .select()
      .from(issueApprovals)
      .where(eq(issueApprovals.approvalId, approvalRows[0]!.id));
    expect(links[0]!.linkedByUserId).toBe(admin);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Finding 2: each review round gets its own escalation window
  // -------------------------------------------------------------------------

  it("a second review round that stalls escalates again after a revision", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    // Round 1 was enqueued ten minutes ago...
    await enqueueStranded(company.id, issue.id, minutesAgo(10), minutesAgo(9));
    // ...and a human sent it back for revision five minutes ago.
    await db.insert(verdicts).values({
      companyId: company.id,
      entityType: "issue",
      issueId: issue.id,
      reviewerUserId: `user-${randomUUID()}`,
      outcome: "revision_requested",
      createdAt: minutesAgo(5),
    });

    // The worker revises and returns the issue to review: a new round.
    process.env.AGENTDASH_VERDICT_ESCALATE_AFTER_MS = "1";
    const { orch } = orchestrator();
    await orch.onIssueStatusChanged(issue.id, "in_progress", "in_review");

    const [queueRow] = await db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.issueId, issue.id));
    expect(queueRow!.enqueuedAt.getTime()).toBeGreaterThan(minutesAgo(1).getTime());

    await new Promise((resolve) => setTimeout(resolve, 10));
    await orch.runReviewCycle(company.id);

    // Round 2 stalled past its own SLA, so it escalates.
    const rows = await verdictsFor(issue.id);
    expect(rows.map((row) => row.outcome).sort()).toEqual([
      "escalated_to_human",
      "revision_requested",
    ]);
    expect(await approvalsFor(company.id)).toHaveLength(1);
  }, 60_000);

  // GH #863 (#867 follow-up): closingVerdictFor was not round-scoped, so a
  // round-1 `failed` verdict dequeued the revised round 2 before anyone
  // reviewed it, and it never escalated.
  it("a failed verdict from an earlier round does not dequeue the next round", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(company.id, issue.id, minutesAgo(10), minutesAgo(9));
    await db.insert(verdicts).values({
      companyId: company.id,
      entityType: "issue",
      issueId: issue.id,
      reviewerUserId: `user-${randomUUID()}`,
      outcome: "failed",
      createdAt: minutesAgo(5),
    });

    process.env.AGENTDASH_VERDICT_ESCALATE_AFTER_MS = "1";
    const { orch } = orchestrator();
    await orch.onIssueStatusChanged(issue.id, "in_progress", "in_review");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await orch.runReviewCycle(company.id);

    const queue = await db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.issueId, issue.id));
    expect(queue).toHaveLength(1);
    const rows = await verdictsFor(issue.id);
    expect(rows.map((row) => row.outcome).sort()).toEqual(["escalated_to_human", "failed"]);
    expect(await approvalsFor(company.id)).toHaveLength(1);
  }, 60_000);

  it("a closing verdict in the current round still dequeues the item", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(company.id, issue.id, minutesAgo(10), minutesAgo(5));
    await db.insert(verdicts).values({
      companyId: company.id,
      entityType: "issue",
      issueId: issue.id,
      reviewerUserId: `user-${randomUUID()}`,
      outcome: "passed",
      createdAt: minutesAgo(2),
    });

    const { orch } = orchestrator();
    await orch.runReviewCycle(company.id);

    const queue = await db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.issueId, issue.id));
    expect(queue).toHaveLength(0);
    expect(await verdictsFor(issue.id)).toHaveLength(1);
  }, 60_000);

  it("re-entering review starts a fresh SLA window instead of escalating at once", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(company.id, issue.id, minutesAgo(10), minutesAgo(9));

    const { orch } = orchestrator();
    await orch.onIssueStatusChanged(issue.id, "in_progress", "in_review");
    await orch.runReviewCycle(company.id);

    // The default SLA is far in the future: nothing escalates yet.
    expect(await verdictsFor(issue.id)).toHaveLength(0);
    const [queueRow] = await db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.issueId, issue.id));
    expect(queueRow!.escalateAfter!.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);

  // -------------------------------------------------------------------------
  // Finding 3: atomic, single-writer escalation
  // -------------------------------------------------------------------------

  it("a failed approval insert leaves no orphan verdict, so the next cycle still escalates", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(company.id, issue.id, minutesAgo(10), minutesAgo(5));

    await db.execute(sql`
      CREATE FUNCTION test_fail_approval_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'approval insert failed (test)';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER test_fail_approval_insert BEFORE INSERT ON approvals
      FOR EACH ROW EXECUTE FUNCTION test_fail_approval_insert()
    `);

    // GH #863 (#867 follow-up): activity written in the escalation
    // transaction is published only after commit, so a rolled-back
    // escalation never reaches live events.
    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(company.id, (event) => {
      if (event.type === "activity.logged") published.push(String(event.payload.action));
    });

    try {
      const { orch } = orchestrator();
      await orch.runReviewCycle(company.id);
      // The verdict rolled back with the failed approval.
      expect(await verdictsFor(issue.id)).toHaveLength(0);
      expect(await approvalsFor(company.id)).toHaveLength(0);
      expect(published).toEqual([]);

      await db.execute(sql`DROP TRIGGER test_fail_approval_insert ON approvals`);
      await orch.runReviewCycle(company.id);

      // The item was not silenced: it escalates once the insert succeeds.
      expect(await verdictsFor(issue.id)).toHaveLength(1);
      expect(await approvalsFor(company.id)).toHaveLength(1);
      // ...and its activity is published once it has committed.
      expect(published.sort()).toEqual(["verdict_escalated", "verdict_recorded"]);
    } finally {
      unsubscribe();
    }
  }, 60_000);

  it("two overlapping sweeps escalate an item only once", async () => {
    const company = await seedCompany();
    const items = [] as Array<{ id: string }>;
    for (let i = 0; i < 3; i += 1) {
      const issue = await seedIssue(company.id);
      await enqueueStranded(company.id, issue.id, minutesAgo(10 - i), minutesAgo(5));
      items.push(issue);
    }

    // Two independent orchestrators (e.g. old and new process during an OTA
    // restart) sweep the same company at the same time.
    const a = orchestrator();
    const b = orchestrator();
    await Promise.all([
      a.orch.runReviewCycle(company.id),
      b.orch.runReviewCycle(company.id),
      a.orch.runReviewCycle(company.id),
      b.orch.runReviewCycle(company.id),
    ]);

    for (const issue of items) {
      expect(await verdictsFor(issue.id)).toHaveLength(1);
    }
    expect(await approvalsFor(company.id)).toHaveLength(3);
  }, 60_000);
});
