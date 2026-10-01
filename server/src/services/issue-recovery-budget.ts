import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  ISSUE_RECOVERY_BUDGET_CLEARED_ACTION,
  readIssueRecoveryBudget,
  type IssueRecoveryBudgetClearTrigger,
  type IssueRecoveryBudgetState,
  type IssueRecoveryBudgetUsage,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

/**
 * AgentDash (recovery budget remediation): human remediation for an issue
 * whose automatic-recovery budget is exhausted.
 *
 * The heartbeat writes `execution_state.recoveryBudget = { status: "exhausted" }`
 * when automatic retries for a task run out, and while it is set refuses every
 * run except the one a confirmed task_recovery.remediate permit names. Before
 * this module nothing removed it, although the exhaustion message promised
 * human remediation.
 *
 * Clearing removes the marker and logs `issue.recovery_budget_cleared` in the
 * same transaction. That activity row is also the ledger reset point: the
 * heartbeat counts only automatic retries recorded after the latest clear, so
 * remediation opens a fresh retry window rather than re-tripping on the
 * history it forgave. Writing both together means there is never a cleared
 * marker without its reset point.
 *
 * Callers decide whether the actor is a human with authority to clear; this
 * module only performs and records the clear.
 *
 * AgentDash (2026-09-30 founder decision, permit + explicit clear): the only
 * caller is the board user's explicit "Clear recovery block & retry" route.
 * Status changes out of `blocked`, reopen-by-comment and reassignment used to
 * clear as a side effect (#848/#869); they no longer do. Keep it that way: a
 * new clear path needs its own named, audited trigger.
 */

export function hasExhaustedRecoveryBudget(executionState: unknown): boolean {
  return readIssueRecoveryBudget(executionState) !== null;
}

/**
 * AgentDash (GH #891 F-A): the one run that may own an exhausted issue is the
 * run a named-human permit bound and the claim gate already let through —
 * the permit is `consumed`, names this exact run, and pins this agent. Every
 * other run (a timer run, another issue's run, a sibling) and every caller
 * without a run is refused, whatever status the issue is in. Mirrors the
 * heartbeat claim gate (`enforceTaskRecoveryBudget`): there the permit is
 * `authorized` and the claim consumes it; after the claim it reads `consumed`.
 */
export function exhaustedRecoveryBudgetAllowsRun(
  executionState: unknown,
  input: { runId: string | null | undefined; agentId: string },
): boolean {
  if (!hasExhaustedRecoveryBudget(executionState)) return true;
  if (!input.runId) return false;
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const remediation = record(record(record(executionState)?.recoveryBudget)?.remediation);
  return Boolean(
    remediation &&
      remediation.status === "consumed" &&
      remediation.runId === input.runId &&
      remediation.assigneeAgentId === input.agentId,
  );
}

/**
 * The same rule as {@link exhaustedRecoveryBudgetAllowsRun}, as a WHERE
 * fragment, so the write that hands an issue to a run re-checks it atomically.
 */
export function exhaustedRecoveryBudgetAllowsRunSql(runId: string | null | undefined, agentId: string) {
  const notExhausted = sql`coalesce(${issues.executionState} -> 'recoveryBudget' ->> 'status', '') <> 'exhausted'`;
  if (!runId) return notExhausted;
  return or(
    notExhausted,
    and(
      sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'status' = 'consumed'`,
      sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'runId' = ${runId}`,
      sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'assigneeAgentId' = ${agentId}`,
    ),
  )!;
}

export const EXHAUSTED_RECOVERY_CHECKOUT_REFUSAL =
  "This issue's automatic-retry budget is exhausted. Only the one run a board user authorized for it can take it; " +
  "a board user can authorize one run or clear the block from the issue page.";

function withoutRecoveryBudget(executionState: unknown): Record<string, unknown> | null {
  if (typeof executionState !== "object" || executionState === null || Array.isArray(executionState)) {
    return null;
  }
  const { recoveryBudget: _removed, ...rest } = executionState as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : null;
}

export type IssueRecoveryBudgetNotice = {
  status: "exhausted";
  exhaustedBy: string[];
  message: string;
  /** The only way the marker is removed: POST here as a board user. */
  clearPath: string;
};

/**
 * AgentDash (recovery budget, permit + explicit clear — 2026-09-30 founder
 * decision): what the issue PATCH and comment responses say while an
 * exhausted marker is still on the issue. Status changes, reopen-by-comment
 * and reassignment do not clear the marker, and no ordinary wake goes ahead —
 * including one a board user's own action starts. The only run that passes
 * is the exact one a confirmed task_recovery.remediate permit names; the only
 * removal is the explicit clear below.
 */
export function recoveryBudgetNotice(issueId: string, executionState: unknown): IssueRecoveryBudgetNotice | null {
  const budget = readIssueRecoveryBudget(executionState);
  if (!budget) return null;
  return {
    status: "exhausted",
    exhaustedBy: budget.exhaustedBy,
    message:
      "This issue's automatic-retry budget is still exhausted. Changing its status, commenting or reassigning it " +
      "does not clear the block and no ordinary run will start — only the one run a board user authorizes can " +
      "proceed. On the issue page, use \"Clear recovery block & retry\" to clear it, or \"Authorize one run\" " +
      "to let exactly one run go ahead while the block stays.",
    clearPath: `/api/issues/${issueId}/recovery-budget/clear`,
  };
}

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * When a human last cleared this issue's recovery budget. Only server-written
 * rows by a user actor qualify: the activity table also holds manual rows
 * posted through the activity API, and an agent must not be able to reset its
 * own allowance.
 */
export async function latestRecoveryBudgetClearAt(db: DbOrTx, companyId: string, issueId: string) {
  return db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, ISSUE_RECOVERY_BUDGET_CLEARED_ACTION),
        eq(activityLog.actorType, "user"),
        eq(activityLog.origin, "server"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0]?.createdAt ?? null);
}

export async function clearIssueRecoveryBudget(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    actorUserId: string;
    trigger: IssueRecoveryBudgetClearTrigger;
    runId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<{ issue: typeof issues.$inferSelect; cleared: IssueRecoveryBudgetState } | null> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current) return null;
    const cleared = readIssueRecoveryBudget(current.executionState);
    if (!cleared) return null;

    // AgentDash (founder decision, permit + explicit clear): a live
    // task_recovery.remediate permit is finalized BEFORE the marker comes
    // off — never erased silently. If the marker vanished while a bound run
    // sat queued behind an authorized permit, that run would later claim as
    // an ordinary wake with no consumed evidence, which is exactly the
    // silent re-arm the decision prohibits. Deny the permit, cancel the
    // still-claimable bound run, and record both so the activity log keeps
    // the evidence after the marker is gone.
    const remediation =
      current.executionState && typeof current.executionState === "object" && !Array.isArray(current.executionState)
        ? ((current.executionState as Record<string, unknown>).recoveryBudget as Record<string, unknown> | undefined)
              ?.remediation as Record<string, unknown> | undefined
        : undefined;
    const livePermit =
      remediation && remediation.status === "authorized" && typeof remediation.runId === "string"
        ? remediation
        : null;
    if (livePermit) {
      const now = new Date();
      await tx
        .update(issues)
        .set({
          executionState: sql`jsonb_set(${issues.executionState}, '{recoveryBudget,remediation}', (${issues.executionState} -> 'recoveryBudget' -> 'remediation') || ${JSON.stringify({ status: "denied", deniedAt: now.toISOString(), denialReason: "superseded by explicit recovery-budget clear" })}::jsonb)`,
        })
        .where(
          and(
            eq(issues.id, input.issueId),
            sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'status' = 'authorized'`,
            sql`${issues.executionState} -> 'recoveryBudget' -> 'remediation' ->> 'runId' = ${livePermit.runId as string}`,
          ),
        );
      const [boundRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "The one-run authorization was superseded when a board user cleared the recovery block",
          errorCode: "task_recovery_permit_superseded",
        })
        .where(
          and(
            eq(heartbeatRuns.id, livePermit.runId as string),
            eq(heartbeatRuns.companyId, input.companyId),
            inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
          ),
        )
        .returning({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId });
      if (boundRun?.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "skipped", finishedAt: now, error: "The one-run authorization was superseded when a board user cleared the recovery block" })
          .where(eq(agentWakeupRequests.id, boundRun.wakeupRequestId));
      }
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.actorUserId,
        agentId: typeof livePermit.assigneeAgentId === "string" ? livePermit.assigneeAgentId : null,
        runId: livePermit.runId as string,
        action: "issue.task_recovery_permit_denied",
        entityType: "issue",
        entityId: input.issueId,
        details: {
          denialReason: "superseded by explicit recovery-budget clear",
          boundRunCancelled: Boolean(boundRun),
          actionHandleId: typeof livePermit.actionHandleId === "string" ? livePermit.actionHandleId : null,
          wakeupRequestId: typeof livePermit.wakeupRequestId === "string" ? livePermit.wakeupRequestId : null,
        },
      });
    }

    const [updated] = await tx
      .update(issues)
      .set({
        executionState: withoutRecoveryBudget(current.executionState),
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .returning();
    if (!updated) return null;

    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      agentId: null,
      runId: input.runId ?? null,
      action: ISSUE_RECOVERY_BUDGET_CLEARED_ACTION,
      entityType: "issue",
      entityId: input.issueId,
      details: {
        identifier: updated.identifier,
        trigger: input.trigger,
        status: updated.status,
        clearedRecoveryBudget: {
          exhaustedBy: cleared.exhaustedBy,
          usage: cleared.usage,
          limits: cleared.limits,
          exhaustedAt: cleared.exhaustedAt,
          sourceRunId: cleared.sourceRunId,
          refusedRunId: cleared.refusedRunId,
        },
        ...input.details,
      },
    });

    return { issue: updated, cleared };
  });
}

/** Statuses that read as live work, where a silent exhausted marker misleads. */
const LIVE_WORK_STATUSES = ["todo", "in_progress"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
export const RECOVERY_BUDGET_REBLOCK_COMMENT_PREFIX = "Automatic recovery is still blocked";

function formatUsage(usage: IssueRecoveryBudgetUsage | null, limits: IssueRecoveryBudgetUsage | null) {
  if (!usage) return null;
  const limit = (value: number | undefined) => (limits && value !== undefined ? `/${value}` : "");
  return [
    `attempts=${usage.automaticRetries}${limit(limits?.automaticRetries)}`,
    `turns=${usage.providerTurns}${limit(limits?.providerTurns)}`,
    `tokens=${usage.providerTokens}${limit(limits?.providerTokens)}`,
    `costUsd=${usage.providerCostUsd.toFixed(6)}${limits ? `/${limits.providerCostUsd.toFixed(2)}` : ""}`,
    `runtimeMs=${usage.runtimeMs}${limit(limits?.runtimeMs)}`,
  ].join(", ");
}

/**
 * An issue must never carry an exhausted marker while it looks like live work
 * (`todo` / `in_progress`) with nobody told. That happens when something other
 * than the explicit clear moved it out of `blocked`: a board user's status
 * change, reopen-by-comment or reassignment (none of which clear the marker
 * any more), the assignee agent checking it out or PATCHing it, an
 * assistant-grant reopen, or a permit-bound remediation run that then left
 * the issue in `todo`. Every wake is then refused except a live permit's
 * bound run, and nothing else ever surfaces it.
 *
 * This moves such an issue back to `blocked` and posts one explanatory comment
 * per clear window (deduped on the comment prefix since the latest clear). It
 * does nothing while another run on the issue is queued or running, so it
 * never pulls the issue out from under a permitted run.
 * `excludeRunId` is the run being refused, which is not live work.
 */
export async function reblockExhaustedIssue(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    source: string;
    excludeRunId?: string | null;
    commentAuthorAgentId?: string | null;
  },
): Promise<typeof issues.$inferSelect | null> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!current) return null;
    const budget = readIssueRecoveryBudget(current.executionState);
    if (!budget) return null;
    if (!(LIVE_WORK_STATUSES as readonly string[]).includes(current.status)) return null;

    const activeRun = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          input.excludeRunId ? sql`${heartbeatRuns.id} <> ${input.excludeRunId}` : undefined,
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${input.issueId}`,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (activeRun) return null;

    const now = new Date();
    const [updated] = await tx
      .update(issues)
      .set({
        status: "blocked",
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .returning();
    if (!updated) return null;

    const clearedAt = await latestRecoveryBudgetClearAt(tx, input.companyId, input.issueId);
    const existingComment = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, input.issueId),
          sql`${issueComments.body} like ${`${RECOVERY_BUDGET_REBLOCK_COMMENT_PREFIX}%`}`,
          clearedAt ? gt(issueComments.createdAt, clearedAt) : undefined,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existingComment) {
      const usage = formatUsage(budget.usage, budget.limits);
      await tx.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorAgentId: input.commentAuthorAgentId ?? null,
        body:
          `${RECOVERY_BUDGET_REBLOCK_COMMENT_PREFIX}: this issue's automatic-retry budget is exhausted` +
          `${usage ? ` (${usage})` : ""}, but it was in \`${current.status}\`, where it looked like live work. ` +
          "Moved it back to `blocked`. No automatic retry will start until a board user clears the recovery block with " +
          "\"Clear recovery block & retry\" on this issue or authorizes exactly one run with \"Authorize one run\"; " +
          "moving it out of `blocked`, commenting or reassigning does not clear it.",
      });
    }

    await logActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        identifier: updated.identifier,
        status: "blocked",
        previousStatus: current.status,
        source: input.source,
        reason: "recovery_budget_exhausted",
      },
    });

    return updated;
  });
}
