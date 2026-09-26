// AgentDash: goals-eval-hitl
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  companyMemberships,
  issueReviewQueueState,
  issues,
  verdicts,
} from "@paperclipai/db";
import { COS_REVIEW_DEFAULTS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { issueApprovalService } from "./issue-approvals.js";
import type { FeatureFlagsService } from "./feature-flags.js";
import {
  assignUnassignedReviewItems,
  pickAvailableReviewer,
} from "./review-queue-assignments.js";
import type { CosReviewerAutoHireService } from "./cos-reviewer-auto-hire.js";
import type { VerdictsService } from "./verdicts.js";

interface OrchestratorDeps {
  verdicts: VerdictsService;
  featureFlags: FeatureFlagsService;
  autoHire: CosReviewerAutoHireService;
}

/**
 * CoS verdict orchestrator — manages the issue-review queue lifecycle.
 *
 * Per the consensus plan §3 Phase C2:
 *  - Subscribes to Issue status transitions via the `onIssueStatusChanged`
 *    hook (caller wires this from the issue-update path; orchestrator does
 *    NOT modify inherited issue services).
 *  - Maintains `issue_review_queue_state` rows on enter/exit of `in_review`.
 *  - Triggers `cosReviewerAutoHire.evaluateAndHireIfNeeded` on enqueue.
 *  - Does NOT directly invoke an LLM. The actual reviewer-agent prompting
 *    happens out-of-band via the existing heartbeat / adapter framework.
 *    The orchestrator just maintains queue state and writes a verdict +
 *    `verdict_escalation` approval row when the SLA timer fires.
 */
export function cosVerdictOrchestrator(db: Db, deps: OrchestratorDeps) {
  const issueApprovalsSvc = issueApprovalService(db);

  function escalateAfterMs(): number {
    const raw = process.env.AGENTDASH_VERDICT_ESCALATE_AFTER_MS;
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return COS_REVIEW_DEFAULTS.ESCALATE_AFTER_MS;
  }

  async function enqueueForReview(companyId: string, issueId: string): Promise<void> {
    const now = new Date();
    const escalateAfter = new Date(now.getTime() + escalateAfterMs());
    const reviewerAgentId = await pickAvailableReviewer(db, companyId);

    // Idempotent UPSERT keyed on issueId. Do NOT reset enqueuedAt on conflict.
    await db
      .insert(issueReviewQueueState)
      .values({
        issueId,
        companyId,
        enqueuedAt: now,
        escalateAfter,
        assignedReviewerAgentId: reviewerAgentId,
      })
      .onConflictDoNothing({ target: issueReviewQueueState.issueId });

    // If no reviewer was available, trigger queue-depth-driven auto-hire.
    // Always evaluate after enqueue so growing depth eventually triggers.
    await deps.autoHire.evaluateAndHireIfNeeded(companyId, "queue_depth");

    // Distribute any unassigned backlog to runnable reviewers — items enqueued
    // while a hire approval was pending, or freed by a termination, otherwise
    // sit invisible to reviewers that only judge work assigned to them.
    await assignUnassignedReviewItems(db, companyId);

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "cos_verdict_orchestrator",
      action: "queue_state_changed",
      entityType: "issue",
      entityId: issueId,
      details: {
        op: "enqueue",
        assignedReviewerAgentId: reviewerAgentId,
        escalateAfter: escalateAfter.toISOString(),
      },
    });
  }

  async function dequeue(companyId: string, issueId: string): Promise<void> {
    const deleted = await db
      .delete(issueReviewQueueState)
      .where(
        and(
          eq(issueReviewQueueState.issueId, issueId),
          eq(issueReviewQueueState.companyId, companyId),
        ),
      )
      .returning();
    if (deleted.length > 0) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "cos_verdict_orchestrator",
        action: "queue_state_changed",
        entityType: "issue",
        entityId: issueId,
        details: { op: "dequeue" },
      });
    }
  }

  async function onIssueStatusChanged(
    issueId: string,
    prevStatus: string | null,
    nextStatus: string,
  ): Promise<void> {
    // Look up companyId for the issue.
    const row = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!row) return;
    void prevStatus;

    if (nextStatus === "in_review") {
      await enqueueForReview(row.companyId, issueId);
      return;
    }
    if (nextStatus === "done" || nextStatus === "cancelled") {
      await dequeue(row.companyId, issueId);
      return;
    }
    // Other transitions: no-op.
  }

  /**
   * Tick handler: walk the queue for one company and either dequeue items
   * that have a closing verdict (reviewer agent finished) or escalate items
   * past their SLA to a human via the verdict + approval bridge.
   *
   * Phase D / app bootstrap is responsible for invoking this on a timer.
   */
  async function runReviewCycle(companyId: string): Promise<void> {
    // Hand unassigned items to runnable reviewers first — a reviewer who can
    // take the work must see it before the SLA fires. What survives this with
    // no reviewer is stranded (see escalateToHuman's unassigned branch).
    await assignUnassignedReviewItems(db, companyId);

    // GH #701: no isNotNull(assignedReviewerAgentId) filter — items whose
    // reviewer was unassigned (terminate/remove) or never assigned (hire
    // rejected, tier cap) enter the cycle like any other row. Escalation for
    // reviewerless items is handled below; escalateToHuman no longer bails
    // on a null reviewer.
    const queueRows = await db
      .select()
      .from(issueReviewQueueState)
      .where(eq(issueReviewQueueState.companyId, companyId))
      .orderBy(asc(issueReviewQueueState.enqueuedAt));

    const now = new Date();
    for (const item of queueRows) {
      // (a) Dequeue if a closing verdict already exists.
      const closing = await deps.verdicts.closingVerdictFor(
        companyId,
        "issue",
        item.issueId,
      );
      if (closing) {
        await dequeue(companyId, item.issueId);
        continue;
      }

      // (b) Escalate if SLA expired.
      if (item.escalateAfter && item.escalateAfter <= now) {
        await escalateToHuman(companyId, item.issueId, item.assignedReviewerAgentId);
        continue;
      }
      // Otherwise: reviewer agent owns it; nothing to do here.
    }
  }

  /**
   * Sweep helper that finds any escalated items across all companies. Phase D
   * bootstrap may use the per-company `runReviewCycle` instead; this helper is
   * exposed for tests and global tickers.
   */
  async function findEscalatable(): Promise<typeof issueReviewQueueState.$inferSelect[]> {
    const now = new Date();
    return db
      .select()
      .from(issueReviewQueueState)
      .where(
        and(
          isNotNull(issueReviewQueueState.escalateAfter),
          lte(issueReviewQueueState.escalateAfter, now),
        ),
      );
  }

  /**
   * The company human an unreviewable item escalates to: the oldest active
   * owner/admin membership, so a named, decision-capable person always owns
   * the escalation instead of an anonymous row.
   */
  async function accountableHumanFor(companyId: string): Promise<string | null> {
    const rows = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          inArray(companyMemberships.membershipRole, ["owner", "admin"]),
        ),
      )
      .orderBy(asc(companyMemberships.createdAt))
      .limit(1);
    return rows[0]?.principalId ?? null;
  }

  /**
   * True when an open (non-closing) verdict already exists for the issue —
   * i.e. the review loop is already recorded as in a human's hands or a
   * reviewer's. The closing-verdict idempotency check above only sees
   * passed/failed; without this, every 60s sweep past the SLA would file a
   * duplicate escalated_to_human verdict + approval for the same item.
   */
  async function hasOpenVerdict(companyId: string, issueId: string): Promise<boolean> {
    const rows = await db
      .select({ id: verdicts.id })
      .from(verdicts)
      .where(
        and(
          eq(verdicts.companyId, companyId),
          eq(verdicts.entityType, "issue"),
          eq(verdicts.issueId, issueId),
        ),
      )
      .orderBy(desc(verdicts.createdAt))
      .limit(1);
    return rows.length > 0;
  }

  async function escalateToHuman(
    companyId: string,
    issueId: string,
    reviewerAgentId: string | null,
  ): Promise<void> {
    // 1. Idempotency: bail if there's already a closing verdict.
    const existing = await deps.verdicts.closingVerdictFor(companyId, "issue", issueId);
    if (existing) {
      await dequeue(companyId, issueId);
      return;
    }

    // 1b. GH #701: an open verdict (escalated_to_human / revision_requested /
    //     pending) also means the loop is already recorded — bail so the 60s
    //     sweep cannot pile duplicate escalation verdicts onto one item.
    if (await hasOpenVerdict(companyId, issueId)) {
      return;
    }

    // 2. A reviewerless item can no longer stall silently: escalate directly
    //    to the company's accountable human with the orchestrator as actor
    //    (there is no reviewer to attribute), re-triggering auto-hire so the
    //    reviewer pool grows. reviewerUserId is text, so any membership
    //    principal id is acceptable; with no human member at all the item
    //    still escalates (verdict + approval) and the auto-hire re-check runs.
    if (!reviewerAgentId) {
      const accountableUserId = await accountableHumanFor(companyId);
      const verdict = await deps.verdicts.create({
        companyId,
        entityType: "issue",
        issueId,
        reviewerUserId: accountableUserId ?? "unassigned",
        outcome: "escalated_to_human",
        justification: "SLA expired with no reviewer assigned",
      });
      const insertedApproval = await db
        .insert(approvals)
        .values({
          companyId,
          type: "verdict_escalation",
          status: "pending",
          payload: {
            type: "verdict_escalation",
            verdictId: verdict.id,
            issueId,
            justification: "SLA expired with no reviewer assigned",
          } as Record<string, unknown>,
        })
        .returning();
      const approval = insertedApproval[0]!;
      await issueApprovalsSvc.link(issueId, approval.id, {
        userId: accountableUserId,
      });
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "cos_verdict_orchestrator",
        action: "verdict_escalated",
        entityType: "issue",
        entityId: issueId,
        details: {
          verdictId: verdict.id,
          approvalId: approval.id,
          reason: "sla_expired_unassigned",
          escalatedToUserId: accountableUserId,
        },
      });
      // Auto-hire re-evaluation (GH #701): the queue has work nobody can
      // review — grow the reviewer pool if the cap allows.
      await deps.autoHire.evaluateAndHireIfNeeded(companyId, "neutrality_conflict");
      return;
    }

    let verdictId: string | null = null;
    try {
      const verdict = await deps.verdicts.create({
        companyId,
        entityType: "issue",
        issueId,
        reviewerAgentId,
        outcome: "escalated_to_human",
        justification: "SLA expired without closing verdict",
      });
      verdictId = verdict.id;
    } catch (err) {
      // Neutral-validator may reject if the reviewer is also the assignee.
      // In that case kick neutrality_conflict auto-hire and abort this tick.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("reviewer must not be the assignee")) {
        await deps.autoHire.evaluateAndHireIfNeeded(companyId, "neutrality_conflict");
        return;
      }
      throw err;
    }

    // 3. Create the verdict_escalation approval (caller-only; no edit to
    //    approvals service body). The bridge listens for the resolution.
    const insertedApproval = await db
      .insert(approvals)
      .values({
        companyId,
        type: "verdict_escalation",
        requestedByAgentId: reviewerAgentId,
        status: "pending",
        payload: {
          type: "verdict_escalation",
          verdictId,
          issueId,
          justification: "SLA expired without closing verdict",
        } as Record<string, unknown>,
      })
      .returning();
    const approval = insertedApproval[0]!;

    // 4. Link the approval to the issue.
    await issueApprovalsSvc.link(issueId, approval.id, { agentId: reviewerAgentId });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "cos_verdict_orchestrator",
      action: "verdict_escalated",
      entityType: "issue",
      entityId: issueId,
      agentId: reviewerAgentId,
      details: {
        verdictId,
        approvalId: approval.id,
        reason: "sla_expired",
      },
    });
  }

  return {
    onIssueStatusChanged,
    enqueueForReview,
    dequeue,
    runReviewCycle,
    findEscalatable,
    escalateToHuman,
  };
}

export type CosVerdictOrchestratorService = ReturnType<typeof cosVerdictOrchestrator>;
