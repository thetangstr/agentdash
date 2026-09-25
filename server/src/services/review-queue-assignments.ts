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
