// AgentDash: goals-eval-hitl
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  companyMemberships,
  issueReviewQueueState,
  issues,
  verdicts,
} from "@paperclipai/db";
import { COS_REVIEW_DEFAULTS } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { insertActivity, logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueApprovalService } from "./issue-approvals.js";
import type { FeatureFlagsService } from "./feature-flags.js";
import {
  assignUnassignedReviewItems,
  pickAvailableReviewer,
  releaseNonRunnableReviewerItems,
} from "./review-queue-assignments.js";
import type { AutoHireReason, CosReviewerAutoHireService } from "./cos-reviewer-auto-hire.js";
import { verdictsService, type VerdictsService, type VerdictsServiceDeps } from "./verdicts.js";

interface OrchestratorDeps {
  verdicts: VerdictsService;
  featureFlags: FeatureFlagsService;
  autoHire: CosReviewerAutoHireService;
  /**
   * AgentDash: #849 follow-up — the verdicts service bound to the escalation
   * transaction, so the escalation verdict commits or rolls back with its
   * approval. Defaults to `verdictsService(tx)`; unit tests inject a stub.
   */
  verdictsFor?: (dbOrTx: Db, verdictDeps?: VerdictsServiceDeps) => VerdictsService;
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
  const verdictsFor =
    deps.verdictsFor ?? ((dbOrTx: Db, verdictDeps?: VerdictsServiceDeps) => verdictsService(dbOrTx, verdictDeps));

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

    // UPSERT keyed on issueId. AgentDash: #849 follow-up — a re-entry into
    // `in_review` (the route hook only fires on a real status change, e.g.
    // back from a revision) starts a new review round: enqueuedAt and
    // escalateAfter are reset so the round gets its own SLA window, and
    // hasOpenVerdict (scoped to enqueuedAt) stops counting the previous
    // round's revision_requested / escalation verdict. An existing reviewer
    // assignment is kept; a missing one is filled from this pick.
    await db
      .insert(issueReviewQueueState)
      .values({
        issueId,
        companyId,
        enqueuedAt: now,
        escalateAfter,
        assignedReviewerAgentId: reviewerAgentId,
      })
      .onConflictDoUpdate({
        target: issueReviewQueueState.issueId,
        set: {
          enqueuedAt: now,
          escalateAfter,
          assignedReviewerAgentId: sql`coalesce(${issueReviewQueueState.assignedReviewerAgentId}, excluded.assigned_reviewer_agent_id)`,
        },
      });

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

  async function releaseNonRunnableReviewers(companyId: string): Promise<void> {
    const released = await releaseNonRunnableReviewerItems(db, companyId);
    for (const item of released.unassigned) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "cos_verdict_orchestrator",
        action: "queue_state_changed",
        entityType: "issue",
        entityId: item.issueId,
        details: {
          op: "unassign",
          reason: "reviewer_not_runnable",
          reviewerAgentId: item.reviewerAgentId,
          reviewerStatus: item.reviewerStatus,
        },
      });
    }
    for (const reviewerAgentId of released.retiredReviewerAgentIds) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "cos_verdict_orchestrator",
        action: "reviewer_assignment_retired",
        entityType: "agent",
        entityId: reviewerAgentId,
        agentId: reviewerAgentId,
        details: { reason: "reviewer_terminated" },
      });
    }
  }

  /**
   * Tick handler: walk the queue for one company and either dequeue items
   * that have a closing verdict (reviewer agent finished) or escalate items
   * past their SLA to a human via the verdict + approval bridge.
   *
   * Phase D / app bootstrap is responsible for invoking this on a timer.
   */
  async function runReviewCycle(companyId: string): Promise<void> {
    // GH #833: take items off terminated, paused and pending_approval
    // reviewers before anything else (`error` is transient and keeps them).
    // A queue row left pointing at a terminated reviewer (terminated under a
    // release without terminate-time cleanup, or by any other path) was
    // escalated on every tick with the dead reviewer as requester. Freed items
    // go through the distribution sweep below like any other unassigned row.
    await releaseNonRunnableReviewers(companyId);

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
    // GH #833: auto-hire is evaluated at most once per cycle, after the loop.
    // Calling it per escalated item let one tick with N stranded items fill
    // every free hire slot at once (each call finds a slot until the cap).
    const hireTriggers = new Set<AutoHireReason>();
    for (const item of queueRows) {
      // AgentDash: #849 follow-up — per-item isolation. One item that throws
      // (a neutrality 409, a constraint error, a transient DB failure) used
      // to escape the loop and abort the rest of the company's queue and the
      // once-per-cycle auto-hire check below, on every tick. Log it and move
      // on; the item is retried next cycle.
      try {
        // (a) Dequeue if a closing verdict already exists.
        // GH #863 (#867 follow-up): only this review round's verdicts close it.
        const closing = await deps.verdicts.closingVerdictFor(
          companyId,
          "issue",
          item.issueId,
          { since: item.enqueuedAt },
        );
        if (closing) {
          await dequeue(companyId, item.issueId);
          continue;
        }

        // (b) Escalate if SLA expired.
        if (item.escalateAfter && item.escalateAfter <= now) {
          const trigger = await escalateToHuman(
            companyId,
            item.issueId,
            item.assignedReviewerAgentId,
            { enqueuedAt: item.enqueuedAt, deferAutoHire: true },
          );
          if (trigger) hireTriggers.add(trigger);
          continue;
        }
        // Otherwise: reviewer agent owns it; nothing to do here.
      } catch (err) {
        logger.error(
          { err, companyId, issueId: item.issueId },
          "cos_review_cycle: review item failed; continuing with the rest of the queue",
        );
      }
    }

    // One evaluation per company per cycle. A neutrality conflict (the only
    // reviewer is the assignee) keeps its threshold bypass — more reviewers of
    // the same kind cannot help otherwise. Reviewerless escalations go through
    // the normal queue-depth gate and slot cap, exactly like an enqueue: the
    // item already reached a human, so growing the pool is not urgent.
    const reason: AutoHireReason | null = hireTriggers.has("neutrality_conflict")
      ? "neutrality_conflict"
      : hireTriggers.has("queue_depth")
        ? "queue_depth"
        : null;
    if (reason) {
      await deps.autoHire.evaluateAndHireIfNeeded(companyId, reason);
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
   *
   * `excludeUserId` is the issue's assignee: the neutral-validator rule
   * rejects a verdict whose reviewer is the assignee (409), so the assignee
   * can never be the escalation target — the next owner/admin is picked
   * instead (#849 follow-up).
   */
  async function accountableHumanFor(
    dbOrTx: Db,
    companyId: string,
    excludeUserId: string | null,
  ): Promise<string | null> {
    const rows = await dbOrTx
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          inArray(companyMemberships.membershipRole, ["owner", "admin"]),
          excludeUserId ? ne(companyMemberships.principalId, excludeUserId) : undefined,
        ),
      )
      .orderBy(asc(companyMemberships.createdAt))
      .limit(1);
    return rows[0]?.principalId ?? null;
  }

  /** The issue's human assignee, if any (see accountableHumanFor). */
  async function issueAssigneeUserId(dbOrTx: Db, issueId: string): Promise<string | null> {
    const rows = await dbOrTx
      .select({ assigneeUserId: issues.assigneeUserId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    return rows[0]?.assigneeUserId ?? null;
  }

  /**
   * True when an open (non-closing) verdict already exists for the issue —
   * i.e. the review loop is already recorded as in a human's hands or a
   * reviewer's. The closing-verdict idempotency check above only sees
   * passed/failed; without this, every 60s sweep past the SLA would file a
   * duplicate escalated_to_human verdict + approval for the same item.
   *
   * `since` scopes the check to the current review round (the item's
   * `enqueuedAt`, which enqueueForReview resets on every re-entry into
   * `in_review`): an issue sent back for revision, or closed while its
   * escalation was still open, and then returned to review must be able to
   * escalate once more rather than be silenced forever by an earlier
   * round's verdict (GH #833, #849 follow-up).
   */
  async function hasOpenVerdict(
    dbOrTx: Db,
    companyId: string,
    issueId: string,
    since?: Date | null,
  ): Promise<boolean> {
    const rows = await dbOrTx
      .select({ id: verdicts.id })
      .from(verdicts)
      .where(
        and(
          eq(verdicts.companyId, companyId),
          eq(verdicts.entityType, "issue"),
          eq(verdicts.issueId, issueId),
          since ? gte(verdicts.createdAt, since) : undefined,
        ),
      )
      .orderBy(desc(verdicts.createdAt))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * AgentDash: #849 follow-up — run one item's escalation write set (verdict,
   * approval, issue link, activity) in a single transaction under a
   * per-issue advisory lock. Without the transaction a failed approval insert
   * left an orphan escalated_to_human verdict that hasOpenVerdict then read
   * as "already escalated", silencing the item forever. Without the lock two
   * overlapping sweeps (a slow tick overlapping the next setInterval, or two
   * processes during an OTA restart) could both pass the idempotency checks
   * and file two escalations. The checks re-run after the lock is taken, so
   * the second sweep sees the first one's committed verdict.
   */
  async function withEscalationLock<T>(
    issueId: string,
    work: (tx: Db) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('cos_review_escalation'), hashtext(${issueId}))`,
      );
      return work(txDb);
    });
  }

  type EscalationOutcome =
    | { kind: "closed" }
    | { kind: "already_open" }
    | { kind: "escalated"; hireReason: AutoHireReason | null }
    | { kind: "neutrality_conflict" };

  async function escalateToHuman(
    companyId: string,
    issueId: string,
    reviewerAgentId: string | null,
    options: { enqueuedAt?: Date | null; deferAutoHire?: boolean } = {},
  ): Promise<AutoHireReason | null> {
    // The auto-hire evaluation this escalation calls for. runReviewCycle
    // passes deferAutoHire and makes one evaluation per cycle; a direct caller
    // gets it run here. It runs after the escalation transaction commits —
    // auto-hire takes its own locks on the outer connection.
    const requestHire = async (reason: AutoHireReason): Promise<AutoHireReason> => {
      if (!options.deferAutoHire) {
        await deps.autoHire.evaluateAndHireIfNeeded(companyId, reason);
      }
      return reason;
    };

    // GH #863 (#867 follow-up): activity written inside the escalation
    // transaction is published after it commits, never before.
    const publications: ActivityPublication[] = [];
    const outcome = await withEscalationLock<EscalationOutcome>(issueId, async (tx) => {
      const txVerdicts = verdictsFor(tx, { onActivity: (publication) => publications.push(publication) });
      const txIssueApprovals = issueApprovalService(tx);

      // 1. Idempotency: bail if there's already a closing verdict.
      const existing = await txVerdicts.closingVerdictFor(companyId, "issue", issueId, {
        since: options.enqueuedAt,
      });
      if (existing) return { kind: "closed" };

      // 1b. GH #701: an open verdict (escalated_to_human / revision_requested /
      //     pending) in the current review round also means the loop is
      //     already recorded — bail so the 60s sweep cannot pile duplicate
      //     escalation verdicts onto one item. This holds across a reviewer
      //     change too: an item escalated while its reviewer was live and then
      //     freed by the reviewer sweep is still covered by the same open
      //     verdict (GH #833).
      if (await hasOpenVerdict(tx, companyId, issueId, options.enqueuedAt)) {
        return { kind: "already_open" };
      }

      // 2. A reviewerless item can no longer stall silently: escalate directly
      //    to the company's accountable human with the orchestrator as actor
      //    (there is no reviewer to attribute), then re-evaluate auto-hire
      //    through the normal queue-depth gate (GH #833: the old
      //    neutrality_conflict trigger bypassed the gate, so every stranded
      //    item could file a hire). reviewerUserId is text, so any membership
      //    principal id is acceptable.
      //
      //    #849 follow-up: the target is never the issue's assignee — the
      //    neutral-validator rule would 409 the verdict. When the assignee is
      //    the only owner/admin (a one-human company reviewing its own work),
      //    the item escalates exactly like a company with no human member:
      //    the "unassigned" sentinel reviewer and an unnamed approval in the
      //    company's approvals inbox. The item is surfaced once, the open
      //    verdict then keeps the sweep from retrying it, and auto-hire can
      //    still grow a neutral reviewer.
      if (!reviewerAgentId) {
        const assigneeUserId = await issueAssigneeUserId(tx, issueId);
        const accountableUserId = await accountableHumanFor(tx, companyId, assigneeUserId);
        const onlyHumanIsAssignee =
          !accountableUserId &&
          assigneeUserId !== null &&
          (await accountableHumanFor(tx, companyId, null)) !== null;
        const justification = onlyHumanIsAssignee
          ? "SLA expired with no reviewer assigned; the only owner/admin is the issue's assignee"
          : "SLA expired with no reviewer assigned";
        const verdict = await txVerdicts.create({
          companyId,
          entityType: "issue",
          issueId,
          reviewerUserId: accountableUserId ?? "unassigned",
          outcome: "escalated_to_human",
          justification,
        });
        const insertedApproval = await tx
          .insert(approvals)
          .values({
            companyId,
            type: "verdict_escalation",
            status: "pending",
            payload: {
              type: "verdict_escalation",
              verdictId: verdict.id,
              issueId,
              justification,
            } as Record<string, unknown>,
          })
          .returning();
        const approval = insertedApproval[0]!;
        await txIssueApprovals.link(issueId, approval.id, {
          userId: accountableUserId,
        });
        publications.push(await insertActivity(tx, {
          companyId,
          actorType: "system",
          actorId: "cos_verdict_orchestrator",
          action: "verdict_escalated",
          entityType: "issue",
          entityId: issueId,
          details: {
            verdictId: verdict.id,
            approvalId: approval.id,
            reason: onlyHumanIsAssignee
              ? "sla_expired_unassigned_assignee_only_human"
              : "sla_expired_unassigned",
            escalatedToUserId: accountableUserId,
          },
        }));
        // Auto-hire re-evaluation (GH #701): the queue has work nobody can
        // review — grow the reviewer pool if the depth threshold and cap allow.
        return { kind: "escalated", hireReason: "queue_depth" };
      }

      let verdictId: string | null = null;
      try {
        const verdict = await txVerdicts.create({
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
        // The rejection is thrown before any SQL write, so the transaction
        // is still healthy; kick neutrality_conflict auto-hire and abort.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("reviewer must not be the assignee")) {
          return { kind: "neutrality_conflict" };
        }
        throw err;
      }

      // 3. Create the verdict_escalation approval (caller-only; no edit to
      //    approvals service body). The bridge listens for the resolution.
      const insertedApproval = await tx
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
      await txIssueApprovals.link(issueId, approval.id, { agentId: reviewerAgentId });

      publications.push(await insertActivity(tx, {
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
      }));
      return { kind: "escalated", hireReason: null };
    });
    // Committed: only now may the escalation's activity reach live events
    // and plugins (a rolled-back escalation threw above and publishes nothing).
    for (const publication of publications) publishActivity(publication);

    switch (outcome.kind) {
      case "closed":
        await dequeue(companyId, issueId);
        return null;
      case "already_open":
        return null;
      case "neutrality_conflict":
        return requestHire("neutrality_conflict");
      case "escalated":
        return outcome.hireReason ? requestHire(outcome.hireReason) : null;
    }
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
