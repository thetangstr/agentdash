// AgentDash: goals-eval-hitl
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  cosReviewerAssignments,
  issueReviewQueueState,
} from "@paperclipai/db";

/**
 * Agent statuses in which a reviewer can actually do work. `pending_approval`
 * is deliberately not runnable — an approval-gated reviewer occupies a hire
 * slot but cannot review until a human says yes. `paused`, `error` and
 * `active` are also excluded: the queue should not wait on an agent that is
 * not waking.
 */
export const RUNNABLE_REVIEWER_STATUSES = ["idle", "running"] as const;

/**
 * Reviewer statuses the review cycle takes queue items away from: the ones
 * that only change through a human decision or never change again.
 * `terminated` is permanent, `paused` waits for a resume, `pending_approval`
 * waits for a hire decision.
 *
 * `error` is deliberately absent (GH #833 review). Heartbeat finalization
 * writes `error` after any failed run and `idle` after the next successful
 * one, so it is routinely transient. Sweeping it would move a flaky
 * reviewer's items within one 60 s tick — duplicated review work when another
 * reviewer exists, a reviewerless escalation when none does. A reviewer stuck
 * in `error` keeps its items and the SLA escalation fires once, in its name,
 * which is the existing backstop. `active` is legacy and likewise left alone.
 */
export const SWEEPABLE_REVIEWER_STATUSES = ["terminated", "paused", "pending_approval"] as const;

/**
 * The single reviewer a queue item is handed to. Oldest hire wins — simple
 * FIFO; sufficient for v1, refinable later without API change.
 *
 * The join on agents.status is defensive: termination retires the assignment
 * row, but a reviewer retired any other way must never be picked either — an
 * issue assigned to a dead reviewer escalates on the full 24h SLA for no
 * reason anyone can see.
 */
export async function pickAvailableReviewer(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<string | null> {
  const rows = await db
    .select({ reviewerAgentId: cosReviewerAssignments.reviewerAgentId })
    .from(cosReviewerAssignments)
    .innerJoin(agents, eq(cosReviewerAssignments.reviewerAgentId, agents.id))
    .where(
      and(
        eq(cosReviewerAssignments.companyId, companyId),
        isNull(cosReviewerAssignments.retiredAt),
        inArray(agents.status, [...RUNNABLE_REVIEWER_STATUSES]),
      ),
    )
    .orderBy(asc(cosReviewerAssignments.hiredAt))
    .limit(1);
  return rows[0]?.reviewerAgentId ?? null;
}

/**
 * Hand every unassigned review-queue item to a runnable reviewer.
 *
 * `issue_review_queue_state` rows land unassigned when an issue enters
 * `in_review` while no reviewer exists yet (a hire approval is pending), and
 * when `agentService.terminate`/`remove` frees items a dead reviewer held.
 * Nothing re-distributed them before: the items sat invisible to reviewers —
 * who are instructed to judge only work assigned to them — until the SLA
 * fired. This sweep is the distribution half of the assignment contract; it
 * runs on every enqueue, on reviewer activation/resume, and at the top of the
 * review cycle, so an unassigned backlog is picked up as soon as any reviewer
 * is runnable.
 *
 * Items spread round-robin across runnable reviewers (oldest hire order)
 * rather than piling a whole backlog on the oldest hire. Each update carries
 * `assigned_reviewer_agent_id IS NULL` in its WHERE so two concurrent sweepers
 * cannot both claim the same row — the loser updates nothing and moves on.
 */
export async function assignUnassignedReviewItems(
  db: Db,
  companyId: string,
): Promise<number> {
  const unassigned = await db
    .select({ issueId: issueReviewQueueState.issueId })
    .from(issueReviewQueueState)
    .where(
      and(
        eq(issueReviewQueueState.companyId, companyId),
        isNull(issueReviewQueueState.assignedReviewerAgentId),
      ),
    )
    .orderBy(asc(issueReviewQueueState.enqueuedAt));
  if (unassigned.length === 0) return 0;

  const reviewers = await db
    .select({ reviewerAgentId: cosReviewerAssignments.reviewerAgentId })
    .from(cosReviewerAssignments)
    .innerJoin(agents, eq(cosReviewerAssignments.reviewerAgentId, agents.id))
    .where(
      and(
        eq(cosReviewerAssignments.companyId, companyId),
        isNull(cosReviewerAssignments.retiredAt),
        inArray(agents.status, [...RUNNABLE_REVIEWER_STATUSES]),
      ),
    )
    .orderBy(asc(cosReviewerAssignments.hiredAt));
  if (reviewers.length === 0) return 0;

  let assigned = 0;
  for (const item of unassigned) {
    const reviewer = reviewers[assigned % reviewers.length]!;
    const updated = await db
      .update(issueReviewQueueState)
      .set({ assignedReviewerAgentId: reviewer.reviewerAgentId })
      .where(
        and(
          eq(issueReviewQueueState.issueId, item.issueId),
          eq(issueReviewQueueState.companyId, companyId),
          isNull(issueReviewQueueState.assignedReviewerAgentId),
        ),
      )
      .returning({ issueId: issueReviewQueueState.issueId });
    if (updated.length > 0) assigned += 1;
  }
  return assigned;
}

export interface NonRunnableReviewerRelease {
  /** Queue items taken off a sweepable reviewer, with who held them. */
  unassigned: Array<{ issueId: string; reviewerAgentId: string; reviewerStatus: string }>;
  /** Terminated reviewers whose still-live assignment row was retired. */
  retiredReviewerAgentIds: string[];
}

/**
 * Take queue items off reviewers that will not run without a human, and
 * retire the assignment rows of reviewers that never will again.
 *
 * `agentService.terminate`/`remove` do this at the moment an agent ends, but
 * only for terminations that happened under code that had the cleanup. Rows
 * left behind by an older release — or by a status change on any other path —
 * kept pointing at a dead reviewer, and the review cycle escalated those items
 * on every tick (GH #833). This sweep runs at the top of every review cycle so
 * the cycle only ever sees items held by a runnable reviewer or by nobody.
 *
 * - Items whose reviewer is in `SWEEPABLE_REVIEWER_STATUSES` (terminated,
 *   paused, pending_approval) are unassigned, so the distribution sweep can
 *   re-route them or, with no reviewer left, the SLA escalation sees them as
 *   reviewerless. A paused reviewer gets work back through the resume path's
 *   own distribution sweep. An `error` reviewer keeps its items (see
 *   `SWEEPABLE_REVIEWER_STATUSES`).
 * - Only `terminated` reviewers have their assignment row retired. A paused or
 *   errored reviewer can come back, and a `pending_approval` row is the hire
 *   slot that stops auto-hire filing a duplicate approval — retiring either
 *   would let the pool grow past its cap.
 *
 * The unassign re-checks the reviewer's status inside the UPDATE, so a
 * reviewer resumed between the read and the write keeps its items.
 */
export async function releaseNonRunnableReviewerItems(
  db: Db,
  companyId: string,
): Promise<NonRunnableReviewerRelease> {
  const held = await db
    .select({
      issueId: issueReviewQueueState.issueId,
      reviewerAgentId: agents.id,
      reviewerStatus: agents.status,
    })
    .from(issueReviewQueueState)
    .innerJoin(agents, eq(issueReviewQueueState.assignedReviewerAgentId, agents.id))
    .where(
      and(
        eq(issueReviewQueueState.companyId, companyId),
        inArray(agents.status, [...SWEEPABLE_REVIEWER_STATUSES]),
      ),
    );

  let unassigned: NonRunnableReviewerRelease["unassigned"] = [];
  if (held.length > 0) {
    const released = await db
      .update(issueReviewQueueState)
      .set({ assignedReviewerAgentId: null })
      .where(
        and(
          eq(issueReviewQueueState.companyId, companyId),
          inArray(
            issueReviewQueueState.issueId,
            held.map((row) => row.issueId),
          ),
          inArray(
            issueReviewQueueState.assignedReviewerAgentId,
            db
              .select({ id: agents.id })
              .from(agents)
              .where(inArray(agents.status, [...SWEEPABLE_REVIEWER_STATUSES])),
          ),
        ),
      )
      .returning({ issueId: issueReviewQueueState.issueId });
    const releasedIds = new Set(released.map((row) => row.issueId));
    unassigned = held.filter((row) => releasedIds.has(row.issueId));
  }

  const deadAssignments = await db
    .select({ id: cosReviewerAssignments.id })
    .from(cosReviewerAssignments)
    .innerJoin(agents, eq(cosReviewerAssignments.reviewerAgentId, agents.id))
    .where(
      and(
        eq(cosReviewerAssignments.companyId, companyId),
        isNull(cosReviewerAssignments.retiredAt),
        eq(agents.status, "terminated"),
      ),
    );
  let retired: Array<{ reviewerAgentId: string }> = [];
  if (deadAssignments.length > 0) {
    retired = await db
      .update(cosReviewerAssignments)
      .set({ retiredAt: new Date() })
      .where(
        and(
          inArray(
            cosReviewerAssignments.id,
            deadAssignments.map((row) => row.id),
          ),
          isNull(cosReviewerAssignments.retiredAt),
        ),
      )
      .returning({ reviewerAgentId: cosReviewerAssignments.reviewerAgentId });
  }

  return {
    unassigned,
    retiredReviewerAgentIds: [...new Set(retired.map((row) => row.reviewerAgentId))],
  };
}
