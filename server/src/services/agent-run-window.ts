import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { redactEventPayload } from "../redaction.js";

/**
 * AgentDash (run window): a read-only, board-only audit of one agent over a
 * bounded interval — every run, every wake request (including skipped
 * refusals) and every comment tied to the agent, straight from Postgres, so
 * an external harness can prove nothing else ran or spoke in the window.
 * See doc/AGENT-WAKE-POLICY.md for the contract.
 */

/** Per-list row cap; each list is fetched as cap+1 so the extra row signals truncation. */
export const RUN_WINDOW_ROW_CAP = 2000;
/** The widest window one request may ask for. */
export const RUN_WINDOW_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export type RunWindowBounds = { from: Date; to: Date };

/** Parses and validates `from`/`to`; returns an error message instead of throwing. */
export function parseRunWindowBounds(rawFrom: unknown, rawTo: unknown): RunWindowBounds | { error: string } {
  if (typeof rawFrom !== "string" || typeof rawTo !== "string") {
    return { error: "from and to are required ISO-8601 timestamps" };
  }
  if (!ISO_TIMESTAMP_RE.test(rawFrom) || !ISO_TIMESTAMP_RE.test(rawTo)) {
    return { error: "from and to must be ISO-8601 timestamps with a timezone (e.g. 2026-10-07T12:00:00Z)" };
  }
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: "from and to must be valid timestamps" };
  }
  if (from.getTime() >= to.getTime()) {
    return { error: "from must be before to" };
  }
  if (to.getTime() - from.getTime() > RUN_WINDOW_MAX_SPAN_MS) {
    return { error: "the window may span at most 7 days" };
  }
  return { from, to };
}

export async function readAgentRunWindow(
  db: Db,
  agent: { id: string; companyId: string },
  bounds: RunWindowBounds,
) {
  const { from, to } = bounds;
  const limit = RUN_WINDOW_ROW_CAP + 1;

  const [runs, wakes, comments] = await Promise.all([
    db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("run_window_issue_id"),
        taskId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`.as("run_window_task_id"),
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        logSha256: heartbeatRuns.logSha256,
        logBytes: heartbeatRuns.logBytes,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          // Lifetime overlap, not containment: a run created before `from`
          // that is still open, or finished inside the window, belongs to it.
          lte(heartbeatRuns.createdAt, to),
          or(isNull(heartbeatRuns.finishedAt), gte(heartbeatRuns.finishedAt, from)),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(limit),
    db
      .select({
        id: agentWakeupRequests.id,
        source: agentWakeupRequests.source,
        triggerDetail: agentWakeupRequests.triggerDetail,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        payload: agentWakeupRequests.payload,
        requestedByActorType: agentWakeupRequests.requestedByActorType,
        requestedByActorId: agentWakeupRequests.requestedByActorId,
        runId: agentWakeupRequests.runId,
        requestedAt: agentWakeupRequests.requestedAt,
        finishedAt: agentWakeupRequests.finishedAt,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, agent.companyId),
          eq(agentWakeupRequests.agentId, agent.id),
          // Same lifetime overlap as runs: a deferred wake requested before
          // `from` but promoted or refused inside the window belongs to it.
          lte(agentWakeupRequests.requestedAt, to),
          or(isNull(agentWakeupRequests.finishedAt), gte(agentWakeupRequests.finishedAt, from)),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id))
      .limit(limit),
    db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdByRunId: issueComments.createdByRunId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .innerJoin(
        issues,
        and(eq(issueComments.issueId, issues.id), eq(issueComments.companyId, issues.companyId)),
      )
      .where(
        and(
          eq(issueComments.companyId, agent.companyId),
          // Four lanes, one row each: comments on issues currently assigned
          // to the agent, on issues it was EVER woken for (the wake ledger is
          // append-only), comments it authored, and comments one of its runs
          // wrote. Compared as text so a malformed payload issueId can never
          // fail the whole query on a uuid cast.
          or(
            eq(issues.assigneeAgentId, agent.id),
            sql`${issueComments.issueId}::text in (
              select ${agentWakeupRequests.payload} ->> 'issueId'
              from ${agentWakeupRequests}
              where ${agentWakeupRequests.companyId} = ${agent.companyId}
                and ${agentWakeupRequests.agentId} = ${agent.id}
                and ${agentWakeupRequests.payload} ->> 'issueId' is not null
            )`,
            eq(issueComments.authorAgentId, agent.id),
            sql`${issueComments.createdByRunId} in (
              select ${heartbeatRuns.id}
              from ${heartbeatRuns}
              where ${heartbeatRuns.companyId} = ${agent.companyId}
                and ${heartbeatRuns.agentId} = ${agent.id}
            )`,
          ),
          gte(issueComments.createdAt, from),
          lte(issueComments.createdAt, to),
        ),
      )
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
      .limit(limit),
  ]);

  const truncated =
    runs.length > RUN_WINDOW_ROW_CAP ||
    wakes.length > RUN_WINDOW_ROW_CAP ||
    comments.length > RUN_WINDOW_ROW_CAP;

  return {
    agentId: agent.id,
    companyId: agent.companyId,
    from: from.toISOString(),
    to: to.toISOString(),
    runs: runs.slice(0, RUN_WINDOW_ROW_CAP),
    // Wake payloads can carry caller-supplied data; secret-looking keys are
    // redacted like every other payload the API returns.
    wakes: wakes.slice(0, RUN_WINDOW_ROW_CAP).map((wake) => ({
      ...wake,
      payload: redactEventPayload(wake.payload ?? null),
    })),
    comments: comments.slice(0, RUN_WINDOW_ROW_CAP),
    truncated,
  };
}
