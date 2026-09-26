// AgentDash: GH #701 — reviewerless queue items must escalate, not stall.
//
// Embedded-PostgreSQL coverage for the stranded-item path that mocks cannot
// prove end to end: an in_review item whose reviewer was unassigned (or never
// assigned) is now visible to runReviewCycle, and once its SLA expires it
// escalates to a human (`escalated_to_human` verdict + `verdict_escalation`
// approval + issue link) and auto-hire is re-evaluated. Before the fix the
// cycle's `isNotNull(assignedReviewerAgentId)` filter hid these rows from the
// sweep entirely, and escalateToHuman bailed on a null reviewer.
//
// Also covers the 60s-sweep idempotency: the second cycle past the SLA must
// NOT file a duplicate escalation verdict/approval for the same item.

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

describeEmbeddedPostgres("reviewerless queue items escalate (embedded postgres)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reviewerless-escalation-");
    db = createDb(tempDb.connectionString);
    process.env.AGENTDASH_BILLING_DISABLED = "true";
  }, 120_000);

  afterEach(async () => {
    delete process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES;
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
        name: `Stranded ${randomUUID()}`,
        issuePrefix: `ST${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedIssue(companyId: string, status = "in_review") {
    return db
      .insert(issues)
      .values({ companyId, title: `Stranded ${randomUUID().slice(0, 8)}`, status })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function enqueueStranded(
    companyId: string,
    issueId: string,
    escalateAfter: Date,
  ) {
    await db.insert(issueReviewQueueState).values({
      issueId,
      companyId,
      enqueuedAt: new Date(Date.now() - 60_000),
      escalateAfter,
      assignedReviewerAgentId: null,
    });
  }

  function orchestrator(autoHire: { evaluateAndHireIfNeeded: (companyId: string, reason: string) => Promise<unknown> }) {
    return cosVerdictOrchestrator(db, {
      verdicts: verdictsService(db),
      featureFlags: {} as never,
      autoHire: autoHire as never,
    });
  }

  it("escalates an unassigned in_review item past its SLA and re-evaluates auto-hire", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(
      company.id,
      issue.id,
      new Date(Date.now() - 1000), // SLA already expired
    );
    // No reviewer assignments exist for this company — nothing for the
    // distribution sweep to hand the item to, so it must escalate.

    const evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false });
    const orch = orchestrator({ evaluateAndHireIfNeeded });

    await orch.runReviewCycle(company.id);

    // 1. The item is escalated: an escalated_to_human verdict exists.
    const verdictRows = await db
      .select()
      .from(verdicts)
      .where(and(eq(verdicts.companyId, company.id), eq(verdicts.issueId, issue.id)));
    expect(verdictRows).toHaveLength(1);
    expect(verdictRows[0]!.outcome).toBe("escalated_to_human");

    // 2. The verdict-approval bridge has something to listen for: a pending
    //    verdict_escalation approval, linked to the issue.
    const approvalRows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, company.id));
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.type).toBe("verdict_escalation");
    expect(approvalRows[0]!.status).toBe("pending");
    expect(approvalRows[0]!.payload).toMatchObject({
      type: "verdict_escalation",
      verdictId: verdictRows[0]!.id,
      issueId: issue.id,
    });
    const linkRows = await db
      .select()
      .from(issueApprovals)
      .where(eq(issueApprovals.approvalId, approvalRows[0]!.id));
    expect(linkRows).toHaveLength(1);
    expect(linkRows[0]!.issueId).toBe(issue.id);

    // 3. Auto-hire was re-evaluated (GH #701 acceptance).
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledWith(company.id, "neutrality_conflict");

    // 4. An activity row records the escalation for the audit trail.
    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    expect(
      activityRows.some(
        (row) => row.action === "verdict_escalated" && row.entityId === issue.id,
      ),
    ).toBe(true);
  }, 60_000);

  it("does not file duplicate escalations when the sweep runs twice past the SLA", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(company.id, issue.id, new Date(Date.now() - 1000));

    const evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false });
    const orch = orchestrator({ evaluateAndHireIfNeeded });

    // The 60s production sweep means the same item is revisited forever until
    // a human decides; only the first pass may write an escalation.
    await orch.runReviewCycle(company.id);
    await orch.runReviewCycle(company.id);

    const verdictRows = await db
      .select()
      .from(verdicts)
      .where(eq(verdicts.issueId, issue.id));
    expect(verdictRows).toHaveLength(1);
    const approvalRows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, company.id));
    expect(approvalRows).toHaveLength(1);
    // Auto-hire is only re-kicked on the first pass.
    expect(evaluateAndHireIfNeeded).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("assigns unassigned items first so a live reviewer preempts escalation", async () => {
    const company = await seedCompany();
    // The distribution sweep has a runnable reviewer to give work to.
    const reviewer = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Reviewer ${randomUUID().slice(0, 8)}`,
        role: "reviewer",
        status: "idle",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(cosReviewerAssignments).values({
      companyId: company.id,
      reviewerAgentId: reviewer.id,
      hiredAt: new Date(),
      retiredAt: null,
    });

    // Unassigned items with a live SLA: the distribution sweep assigns them
    // before the escalation scan, so nothing escalates.
    for (let i = 0; i < 2; i += 1) {
      const issue = await seedIssue(company.id);
      await enqueueStranded(company.id, issue.id, new Date(Date.now() + 60_000));
    }

    const evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false });
    const orch = orchestrator({ evaluateAndHireIfNeeded });

    await orch.runReviewCycle(company.id);

    const queueRows = await db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.companyId, company.id));
    expect(queueRows).toHaveLength(2);
    expect(
      queueRows.every((row) => row.assignedReviewerAgentId === reviewer.id),
    ).toBe(true);
    expect(
      await db.select().from(verdicts).where(eq(verdicts.companyId, company.id)),
    ).toHaveLength(0);
    expect(evaluateAndHireIfNeeded).not.toHaveBeenCalled();
  }, 60_000);

  it("escalates a stranded item to the named owner membership when one exists", async () => {
    const company = await seedCompany();
    const issue = await seedIssue(company.id);
    await enqueueStranded(company.id, issue.id, new Date(Date.now() - 1000));

    const ownerUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    });

    const evaluateAndHireIfNeeded = vi.fn().mockResolvedValue({ hired: false });
    const orch = orchestrator({ evaluateAndHireIfNeeded });

    await orch.runReviewCycle(company.id);

    const verdictRows = await db
      .select()
      .from(verdicts)
      .where(eq(verdicts.issueId, issue.id));
    expect(verdictRows).toHaveLength(1);
    expect(verdictRows[0]!.reviewerUserId).toBe(ownerUserId);
    const approvalRows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, company.id));
    expect(approvalRows[0]!.requestedByAgentId).toBeNull();
  }, 60_000);
});
