import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

const RECOVERY_ORIGIN_KIND_VALUES = Object.values(RECOVERY_ORIGIN_KINDS);

/** How many rows one read returns; the count is always the full one. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * AgentDash: the ONE definition of "your agent stopped and needs you".
 *
 * An issue is waiting on a person when it is `blocked`, not hidden, and
 * assigned to an agent that person answers for (its steward, else its
 * accountable human — `agentAccountabilityService.resolveForAgents`). An agent
 * that needs its steward to decide comments and blocks the issue; this is how
 * that reaches the steward.
 *
 * Not waiting on the person, so left out:
 *  - an issue still blocked by another issue that is not done or cancelled —
 *    it is waiting on that work, and moves on by itself when it finishes;
 *  - an issue the server blocked for recovery: an exhausted automatic-recovery
 *    budget (`executionState.recoveryBudget`, cleared from the board's
 *    recovery controls) or a recovery issue the server filed itself
 *    (`originKind` in RECOVERY_ORIGIN_KINDS). Those belong to the recovery
 *    surfaces, not to a person's inbox.
 *
 * Read by the bridge digest ("Stopped and needs you", steward-inbox.ts) and the
 * web "waiting on you" (waiting-on-you.ts), so the two lists cannot disagree.
 * Callers resolve `agentIds` themselves; the web adds issue visibility through
 * `visibleWhere`. Oldest first: the longest wait is read first. At most
 * `limit` rows are read; `total` counts them all.
 */
export async function listStoppedAgentIssues(
  db: Pick<Db, "select">,
  input: { companyId: string; agentIds: string[]; visibleWhere?: SQL; limit?: number },
) {
  if (input.agentIds.length === 0) return { items: [], total: 0 };
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const unresolvedBlocker = sql`exists (
    select 1 from ${issueRelations} r
    join ${issues} b on b.id = r.issue_id and b.company_id = r.company_id
    where r.company_id = ${input.companyId}
      and r.related_issue_id = ${issues.id}
      and r.type = 'blocks'
      and b.status not in ('done', 'cancelled')
  )`;
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
      total: sql<number>`count(*) over()`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.status, "blocked"),
        isNull(issues.hiddenAt),
        inArray(issues.assigneeAgentId, input.agentIds),
        sql`not ${unresolvedBlocker}`,
        sql`(${issues.executionState} is null or not (${issues.executionState} ? 'recoveryBudget'))`,
        or(isNull(issues.originKind), notInArray(issues.originKind, RECOVERY_ORIGIN_KIND_VALUES)),
        ...(input.visibleWhere ? [input.visibleWhere] : []),
      ),
    )
    .orderBy(asc(issues.updatedAt), asc(issues.id))
    .limit(limit);
  const total = rows[0] ? Number(rows[0].total) : 0;
  return { items: rows.map(({ total: _total, ...row }) => row), total };
}
