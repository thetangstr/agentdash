import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";

/**
 * AgentDash: the ONE definition of "your agent stopped and needs you".
 *
 * An issue is waiting on a person when it is `blocked`, not hidden, and
 * assigned to an agent that person answers for (its steward, else its
 * accountable human — `agentAccountabilityService.resolveForAgents`). An agent
 * that needs its steward to decide comments and blocks the issue; this is how
 * that reaches the steward.
 *
 * Read by the bridge digest ("Stopped and needs you", steward-inbox.ts) and the
 * web "waiting on you" (waiting-on-you.ts), so the two lists cannot disagree.
 * Callers resolve `agentIds` themselves; the web adds issue visibility through
 * `visibleWhere`. Oldest first: the longest wait is read first.
 */
export async function listStoppedAgentIssues(
  db: Pick<Db, "select">,
  input: { companyId: string; agentIds: string[]; visibleWhere?: SQL },
) {
  if (input.agentIds.length === 0) return [];
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.status, "blocked"),
        isNull(issues.hiddenAt),
        inArray(issues.assigneeAgentId, input.agentIds),
        ...(input.visibleWhere ? [input.visibleWhere] : []),
      ),
    )
    .orderBy(asc(issues.updatedAt), asc(issues.id));
}
