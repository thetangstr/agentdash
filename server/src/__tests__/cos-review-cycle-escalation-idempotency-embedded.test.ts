// AgentDash: GH #833 — the review cycle escalates an item at most once per
// open verdict, and never on behalf of a reviewer that cannot run.
//
// Regression: a queue row still pointing at a reviewer terminated under a
// release without terminate-time cleanup was escalated on every 60s tick —
// one new `verdict_escalation` approval per item per tick, each requested by
// the dead reviewer. Embedded PostgreSQL drives runReviewCycle repeatedly,
// the way the server's ticker does, and counts what it wrote.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  cosReviewerAssignments,
  createDb,
  issueReviewQueueState,
  issueApprovals,
  issues,
  verdicts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cosReviewerAutoHire } from "../services/cos-reviewer-auto-hire.js";
import { cosVerdictOrchestrator } from "../services/cos-verdict-orchestrator.js";
import { verdictsService } from "../services/verdicts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/** How many review-cycle ticks each test replays. */
const TICKS = 5;

describeEmbeddedPostgres("review-cycle escalation idempotency (embedded postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-cycle-idempotency-");
    db = createDb(tempDb.connectionString);
    // The real auto-hire path runs in some tests; keep the free-tier agent cap
    // out of the way so only the reviewer gates decide.
    process.env.AGENTDASH_BILLING_DISABLED = "true";
  }, 120_000);

  afterEach(async () => {
    delete process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES;
    delete process.env.AGENTDASH_REVIEWER_QUEUE_DEPTH_THRESHOLD;
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
        name: `Review cycle ${randomUUID()}`,
        issuePrefix: `RC${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedIssue(companyId: string) {
    return db
      .insert(issues)
      .values({ companyId, title: `Review ${randomUUID().slice(0, 8)}`, status: "in_review" })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** A reviewer agent with its `cos_reviewer_assignments` row still live. */
  async function seedReviewer(companyId: string, status: string, hiredAt = new Date()) {
    const reviewer = await db
      .insert(agents)
      .values({
        companyId,
        name: `Reviewer ${randomUUID().slice(0, 8)}`,
        role: "reviewer",
        status,
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(cosReviewerAssignments).values({
      companyId,
      reviewerAgentId: reviewer.id,
      hiredAt,
      retiredAt: null,
    });
    return reviewer;
  }

  async function enqueuePastSla(
    companyId: string,
    issueId: string,
    assignedReviewerAgentId: string | null,
  ) {
    await db.insert(issueReviewQueueState).values({
      issueId,
      companyId,
      enqueuedAt: new Date(Date.now() - 2 * 60_000),
      escalateAfter: new Date(Date.now() - 1000),
      assignedReviewerAgentId,
    });
  }

  function orchestrator() {
    const evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false });
    const orch = cosVerdictOrchestrator(db, {
      verdicts: verdictsService(db),
      featureFlags: {} as never,
      autoHire: { evaluateAndHireIfNeeded } as never,
    });
    return { orch, evaluateAndHireIfNeeded };
  }

  /**
   * The orchestrator wired to the REAL reviewer auto-hire service (real
   * gates, real pending agent + hire_agent approval), with a call-through spy
   * to count evaluations. Only mandate provisioning is stubbed — it reads the
   * instructions bundle from disk and is not what these tests are about.
   */
  function orchestratorWithRealAutoHire() {
    const provisionReviewer = vi.fn().mockResolvedValue(undefined);
    const autoHire = cosReviewerAutoHire(db, { provisionReviewer });
    const evaluateAndHireIfNeeded = vi.spyOn(autoHire, "evaluateAndHireIfNeeded");
    const orch = cosVerdictOrchestrator(db, {
      verdicts: verdictsService(db),
      featureFlags: {} as never,
      autoHire,
    });
    return { orch, evaluateAndHireIfNeeded, provisionReviewer };
  }

  async function hireApprovals(companyId: string) {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "hire_agent")));
  }

  async function runTicks(orch: ReturnType<typeof orchestrator>["orch"], companyId: string) {
    for (let i = 0; i < TICKS; i += 1) {
      await orch.runReviewCycle(companyId);
    }
  }

  async function escalationApprovals(companyId: string) {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "verdict_escalation")));
  }

  async function escalationVerdicts(issueId: string) {
    return db
      .select()
      .from(verdicts)
      .where(and(eq(verdicts.issueId, issueId), eq(verdicts.outcome, "escalated_to_human")));
  }

  async function queueRow(issueId: string) {
    return db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.issueId, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function assignmentFor(reviewerAgentId: string) {
    return db
      .select()
      .from(cosReviewerAssignments)
      .where(eq(cosReviewerAssignments.reviewerAgentId, reviewerAgentId))
      .then((rows) => rows[0]!);
  }

  it("terminated reviewer, no live reviewer: unassigns, retires the assignment, escalates once in N ticks", async () => {
    const company = await seedCompany();
    // Terminated under a release with no terminate-time cleanup: the status
    // changed, but the assignment and queue pointer were left behind.
    const dead = await seedReviewer(company.id, "terminated");
    const issue = await seedIssue(company.id);
    await enqueuePastSla(company.id, issue.id, dead.id);

    const { orch } = orchestrator();
    await runTicks(orch, company.id);

    const row = await queueRow(issue.id);
    expect(row).not.toBeNull();
    expect(row!.assignedReviewerAgentId).toBeNull();
    expect((await assignmentFor(dead.id)).retiredAt).not.toBeNull();

    // At most one escalation, and never in the dead reviewer's name.
    const approvalRows = await escalationApprovals(company.id);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.requestedByAgentId).toBeNull();
    expect(await escalationVerdicts(issue.id)).toHaveLength(1);

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    const unassigns = activityRows.filter(
      (r) =>
        r.action === "queue_state_changed" &&
        (r.details as Record<string, unknown> | null)?.op === "unassign",
    );
    expect(unassigns).toHaveLength(1);
    expect(unassigns[0]!.details).toMatchObject({
      reason: "reviewer_not_runnable",
      reviewerAgentId: dead.id,
      reviewerStatus: "terminated",
    });
    expect(
      activityRows.filter(
        (r) => r.action === "reviewer_assignment_retired" && r.entityId === dead.id,
      ),
    ).toHaveLength(1);
    expect(activityRows.filter((r) => r.action === "verdict_escalated")).toHaveLength(1);
  }, 60_000);

  it("terminated reviewer with a live reviewer available: re-routes the item and escalates at most once", async () => {
    const company = await seedCompany();
    const dead = await seedReviewer(company.id, "terminated", new Date(Date.now() - 60_000));
    const live = await seedReviewer(company.id, "idle");
    const issue = await seedIssue(company.id);
    await enqueuePastSla(company.id, issue.id, dead.id);

    const { orch } = orchestrator();
    await runTicks(orch, company.id);

    // Re-routed to the live reviewer; the dead one's slot is retired.
    expect((await queueRow(issue.id))!.assignedReviewerAgentId).toBe(live.id);
    expect((await assignmentFor(dead.id)).retiredAt).not.toBeNull();
    expect((await assignmentFor(live.id)).retiredAt).toBeNull();

    const approvalRows = await escalationApprovals(company.id);
    expect(approvalRows.length).toBeLessThanOrEqual(1);
    expect(approvalRows.every((a) => a.requestedByAgentId !== dead.id)).toBe(true);
    expect((await escalationVerdicts(issue.id)).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it("live reviewer past SLA: exactly one escalation across repeated ticks", async () => {
    const company = await seedCompany();
    const live = await seedReviewer(company.id, "idle");
    const issue = await seedIssue(company.id);
    await enqueuePastSla(company.id, issue.id, live.id);

    const { orch } = orchestrator();
    await runTicks(orch, company.id);

    const approvalRows = await escalationApprovals(company.id);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.requestedByAgentId).toBe(live.id);
    expect(await escalationVerdicts(issue.id)).toHaveLength(1);
    // The live reviewer keeps the item and its slot.
    expect((await queueRow(issue.id))!.assignedReviewerAgentId).toBe(live.id);
    expect((await assignmentFor(live.id)).retiredAt).toBeNull();
  }, 60_000);

  it("reviewerless items escalate once each across repeated ticks", async () => {
    const company = await seedCompany();
    const issueIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const issue = await seedIssue(company.id);
      await enqueuePastSla(company.id, issue.id, null);
      issueIds.push(issue.id);
    }

    const { orch, evaluateAndHireIfNeeded } = orchestrator();
    await runTicks(orch, company.id);

    expect(await escalationApprovals(company.id)).toHaveLength(3);
    for (const issueId of issueIds) {
      expect(await escalationVerdicts(issueId)).toHaveLength(1);
    }
    // One auto-hire evaluation for the whole cycle that escalated them — not
    // one per item, and none on the later ticks that escalated nothing.
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledTimes(1);
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledWith(company.id, "queue_depth");
  }, 60_000);

  it("an item escalated under a live reviewer does not escalate again after that reviewer dies", async () => {
    const company = await seedCompany();
    const reviewer = await seedReviewer(company.id, "idle");
    const issue = await seedIssue(company.id);
    await enqueuePastSla(company.id, issue.id, reviewer.id);

    const { orch } = orchestrator();
    await orch.runReviewCycle(company.id);
    expect(await escalationApprovals(company.id)).toHaveLength(1);

    // Terminated by a path that skipped the terminate-time cleanup.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, reviewer.id));
    await runTicks(orch, company.id);

    // Freed from the dead reviewer, but the open escalation still covers it.
    expect((await queueRow(issue.id))!.assignedReviewerAgentId).toBeNull();
    expect(await escalationApprovals(company.id)).toHaveLength(1);
    expect(await escalationVerdicts(issue.id)).toHaveLength(1);
  }, 60_000);

  it("paused reviewer: items are unassigned but the assignment row is kept for resume", async () => {
    const company = await seedCompany();
    const paused = await seedReviewer(company.id, "paused");
    const pending = await seedReviewer(company.id, "pending_approval");
    const issue = await seedIssue(company.id);
    await db.insert(issueReviewQueueState).values({
      issueId: issue.id,
      companyId: company.id,
      enqueuedAt: new Date(),
      escalateAfter: new Date(Date.now() + 60 * 60_000), // SLA still live
      assignedReviewerAgentId: paused.id,
    });

    const { orch } = orchestrator();
    await runTicks(orch, company.id);

    expect((await queueRow(issue.id))!.assignedReviewerAgentId).toBeNull();
    // Not terminated: a paused reviewer comes back on resume, and a
    // pending_approval row is the hire slot that caps auto-hire.
    expect((await assignmentFor(paused.id)).retiredAt).toBeNull();
    expect((await assignmentFor(pending.id)).retiredAt).toBeNull();
    expect(await escalationApprovals(company.id)).toHaveLength(0);
  }, 60_000);

  it("an open verdict from an earlier queue episode does not suppress a new escalation", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    // Episode 1 escalated and the issue was then closed directly by a human,
    // leaving its escalated_to_human verdict open. Episode 2 starts later.
    await db.insert(verdicts).values({
      companyId: company.id,
      entityType: "issue",
      issueId: issue.id,
      reviewerUserId: "unassigned",
      outcome: "escalated_to_human",
      justification: "earlier episode",
      createdAt: new Date(Date.now() - 24 * 60 * 60_000),
    });
    await enqueuePastSla(company.id, issue.id, null);

    const { orch } = orchestrator();
    await runTicks(orch, company.id);

    expect(await escalationVerdicts(issue.id)).toHaveLength(2);
    expect(await escalationApprovals(company.id)).toHaveLength(1);
  }, 60_000);
  it("real auto-hire: 4 stranded items below the depth threshold escalate without hiring anyone", async () => {
    // A small stranded backlog: 4 reviewerless items, no runnable reviewer,
    // queue depth 4 < QUEUE_DEPTH_HIRE_THRESHOLD 5.
    const company = await seedCompany();
    for (let i = 0; i < 4; i += 1) {
      const issue = await seedIssue(company.id);
      await enqueuePastSla(company.id, issue.id, null);
    }

    const { orch, evaluateAndHireIfNeeded, provisionReviewer } = orchestratorWithRealAutoHire();
    await runTicks(orch, company.id);

    expect(await escalationApprovals(company.id)).toHaveLength(4);
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledTimes(1);
    expect(await hireApprovals(company.id)).toHaveLength(0);
    expect(
      await db.select().from(agents).where(eq(agents.companyId, company.id)),
    ).toHaveLength(0);
    expect(provisionReviewer).not.toHaveBeenCalled();
  }, 60_000);

  it("real auto-hire: a stranded backlog at the threshold files one hire per cycle, not one per item", async () => {
    // Before the fix each reviewerless escalation called auto-hire with the
    // threshold-bypassing neutrality_conflict trigger, so one tick with 6
    // stranded items filed hires until the slot cap (3 by default).
    const company = await seedCompany();
    for (let i = 0; i < 6; i += 1) {
      const issue = await seedIssue(company.id);
      await enqueuePastSla(company.id, issue.id, null);
    }

    const { orch, evaluateAndHireIfNeeded } = orchestratorWithRealAutoHire();
    await runTicks(orch, company.id);

    expect(await escalationApprovals(company.id)).toHaveLength(6);
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledTimes(1);
    const hires = await hireApprovals(company.id);
    expect(hires).toHaveLength(1);
    const reviewers = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]!.status).toBe("pending_approval");
  }, 60_000);

  it("errored reviewer keeps its items; past SLA it escalates once in its own name", async () => {
    const company = await seedCompany();
    // A failed run leaves the agent in `error` until its next successful run.
    const flaky = await seedReviewer(company.id, "error");
    const other = await seedReviewer(company.id, "idle");
    const live = await seedIssue(company.id);
    await db.insert(issueReviewQueueState).values({
      issueId: live.id,
      companyId: company.id,
      enqueuedAt: new Date(),
      escalateAfter: new Date(Date.now() + 60 * 60_000), // SLA still live
      assignedReviewerAgentId: flaky.id,
    });
    const overdue = await seedIssue(company.id);
    await enqueuePastSla(company.id, overdue.id, flaky.id);

    const { orch, evaluateAndHireIfNeeded } = orchestrator();
    await runTicks(orch, company.id);

    // Not moved to the other runnable reviewer: no duplicated review work.
    expect((await queueRow(live.id))!.assignedReviewerAgentId).toBe(flaky.id);
    expect((await queueRow(overdue.id))!.assignedReviewerAgentId).toBe(flaky.id);
    expect((await assignmentFor(flaky.id)).retiredAt).toBeNull();
    expect((await assignmentFor(other.id)).retiredAt).toBeNull();

    const approvalRows = await escalationApprovals(company.id);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.requestedByAgentId).toBe(flaky.id);
    // An assigned escalation calls for no hire.
    expect(evaluateAndHireIfNeeded).not.toHaveBeenCalled();
  }, 60_000);
});
