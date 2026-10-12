import { and, eq, inArray, isNotNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";

/**
 * AgentDash-MK: which issues are "your requests" -- work the person asked
 * someone else for -- shared by the request service (steward-requests.ts) and
 * the read path (steward-work.ts), so the two can never disagree about it.
 *
 * A request is an issue the person created that is, or was made, someone
 * else's: assigned now to another person or to an agent they do not answer
 * for, or recorded at creation as asked of another person (the bridge request
 * row, or the stewarded-agent routing on the create). The second half keeps a
 * result the counterpart handed back to the requester ("over to you") a
 * request rather than the requester's own work.
 */

/** The activity row a request created through the bridge leaves. */
export const BRIDGE_WORK_REQUESTED = "bridge.work_requested";
/** The activity row an accepted request result leaves. */
export const BRIDGE_WORK_REQUEST_ACCEPTED = "bridge.work_request_accepted";

export type RequestOwner = { companyId: string; userId: string; agentIds: string[] };

export function ownersRequestCondition(owner: RequestOwner): SQL {
  const assignedElsewhere = or(
    and(isNotNull(issues.assigneeUserId), ne(issues.assigneeUserId, owner.userId)),
    owner.agentIds.length > 0
      ? and(isNotNull(issues.assigneeAgentId), notInArray(issues.assigneeAgentId, owner.agentIds))
      : isNotNull(issues.assigneeAgentId),
  );
  const recordedForSomeoneElse = sql`exists (
    select 1 from ${activityLog} rq
    where rq.company_id = ${owner.companyId}
      and rq.entity_type = 'issue'
      and rq.entity_id = ${issues.id}::text
      and rq.action in ('issue.created', ${BRIDGE_WORK_REQUESTED})
      and (rq.details ? 'requestedForUserId' or rq.details ? 'routedToStewardedAgent')
  )`;
  return and(
    eq(issues.companyId, owner.companyId),
    eq(issues.createdByUserId, owner.userId),
    or(assignedElsewhere, recordedForSomeoneElse),
  )!;
}

/** Is this one issue the owner's request? Visibility is the caller's check. */
export async function isOwnersRequest(db: Pick<Db, "select">, owner: RequestOwner, issueId: string): Promise<boolean> {
  return db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), ownersRequestCondition(owner)))
    .then((rows) => rows.length > 0);
}

/**
 * A result is delivered when the work is done, handed back to the requester,
 * or in review with the requester as the reviewer. Only then may the
 * requester accept it or ask for changes from their own session: closing
 * work still in someone's hands is a page action, not a close-out.
 *
 * `in_review` alone is not delivery. On an issue an agent holds it is that
 * agent handing its draft to its own steward (the counterpart's review
 * item), and the result reaches the requester only after that person has
 * finished it. It counts as delivered when the requester is the review's
 * participant: the person it is assigned to, the execution policy's current
 * participant, or a participant of the current stage. On an issue held by an
 * agent the requester answers for, the review is the requester's own.
 */
export function isDeliveredToRequester(
  issue: {
    status: string;
    assigneeUserId: string | null;
    assigneeAgentId?: string | null;
    executionPolicy?: unknown;
    executionState?: unknown;
  },
  requester: { userId: string; agentIds: readonly string[] },
): boolean {
  if (issue.status === "cancelled") return false;
  if (issue.status === "done" || issue.assigneeUserId === requester.userId) return true;
  if (issue.status !== "in_review") return false;
  if (issue.assigneeAgentId && requester.agentIds.includes(issue.assigneeAgentId)) return true;
  return isReviewParticipant(issue, requester.userId);
}

/** Is this person the current review participant named by the issue's execution policy? */
export function isReviewParticipant(
  issue: { executionPolicy?: unknown; executionState?: unknown },
  userId: string,
): boolean {
  const state = (issue.executionState ?? null) as
    | { currentParticipant?: { type?: unknown; userId?: unknown } | null; currentStageId?: unknown }
    | null;
  const current = state?.currentParticipant;
  if (current?.type === "user" && current.userId === userId) return true;
  const stageId = typeof state?.currentStageId === "string" ? state.currentStageId : null;
  if (!stageId) return false;
  const stages = (issue.executionPolicy as { stages?: unknown } | null | undefined)?.stages;
  if (!Array.isArray(stages)) return false;
  const stage = stages.find((entry) => (entry as { id?: unknown } | null)?.id === stageId) as
    | { participants?: unknown }
    | undefined;
  const participants = Array.isArray(stage?.participants) ? stage.participants : [];
  return participants.some((entry) => {
    const participant = entry as { type?: unknown; userId?: unknown } | null;
    return participant?.type === "user" && participant.userId === userId;
  });
}

/**
 * The person each request was asked of: the bridge request row first, then
 * the routing recorded on the create (that person's agent took it). Issues
 * with neither are absent; the caller falls back to the current assignee.
 */
export async function requestedForUserIds(
  db: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({ entityId: activityLog.entityId, action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, issueIds),
        inArray(activityLog.action, ["issue.created", BRIDGE_WORK_REQUESTED]),
      ),
    );
  const routed = new Map<string, string>();
  for (const row of rows) {
    const details = (row.details ?? {}) as Record<string, unknown>;
    if (row.action === BRIDGE_WORK_REQUESTED && typeof details.requestedForUserId === "string") {
      out.set(row.entityId, details.requestedForUserId);
      continue;
    }
    const from = (details.routedToStewardedAgent as { fromUserId?: unknown } | undefined)?.fromUserId;
    if (typeof from === "string") routed.set(row.entityId, from);
  }
  for (const [issueId, userId] of routed) if (!out.has(issueId)) out.set(issueId, userId);
  return out;
}
