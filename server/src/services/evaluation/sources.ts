import { and, asc, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  costEvents,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  verdicts,
} from "@paperclipai/db";
import { EVALUATION_HANDOFF_TYPES, type EvaluationActorType, type EvaluationEventType, type EvaluationHandoffType } from "@paperclipai/shared";
import { clampEventTime, hashCanonical, type EvaluationEventInput } from "./ledger.js";

/**
 * AgentDash: Company Evaluator — ingest sources (spec §6 T0/T2, §8 rules 4/6/13).
 *
 * Every source is a pure mapping from control-plane rows after a cursor to
 * ledger events. Sources never write; the ingest loop appends. Cursors are
 * keyset `(time, id)` pairs so a tick reads only what it has not seen.
 */

/** The drizzle transaction type, so sources can run under SET LOCAL statement_timeout. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Cursor {
  time?: string;
  id?: string;
}

export interface SourceReadResult {
  events: EvaluationEventInput[];
  scanned: number;
  nextCursor: Cursor;
}

export interface IssueScope {
  projectId: string | null;
  goalId: string | null;
  identifier: string | null;
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

/** Payloads above this canonical size are stored as a hash plus key list, not verbatim. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

const TRANSITION_ACTIONS = new Set(["issue.updated"]);
const AGENT_LIFECYCLE_ACTIONS = new Set([
  "agent.created",
  "agent.paused",
  "agent.resumed",
  "agent.terminated",
  "agent.deleted",
  "agent.accountability_changed",
  "agent.stewardship_assigned",
  "agent.stewardship_ended",
  "agent.stewardship_transferred",
  "agent.directives_pushed",
  "agent.governance_change_rejected",
]);
const APPROVAL_DECIDED_ACTIONS = new Set([
  "approval.approved",
  "approval.rejected",
  "approval.revision_requested",
  "approval.emergency_override",
]);

/**
 * Keyset predicate using a Postgres row-value comparison. The cursor time is
 * the database's own `::text` rendering (microsecond precision), never a
 * JavaScript Date (millisecond precision) — otherwise rows created by
 * `now()` sort after their own cursor forever and every tick re-reads them.
 */
function keysetAfter(timeCol: unknown, idCol: unknown, cursor: Cursor) {
  if (!cursor.time) return undefined;
  return cursor.id
    ? sql`(${timeCol as never}, ${idCol as never}) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
    : sql`${timeCol as never} > ${cursor.time}::timestamptz`;
}

/** Select every column of a table plus the full-precision text of its cursor column. */
function withCursorTime<T extends Parameters<typeof getTableColumns>[0]>(table: T, timeCol: unknown) {
  return { ...getTableColumns(table), cursorTime: sql<string>`${timeCol as never}::text` };
}

function actorFrom(actorType: string | null | undefined, actorId: string | null | undefined): {
  actorType: EvaluationActorType;
  actorId: string | null;
} {
  const t = actorType === "agent" || actorType === "user" || actorType === "plugin" ? actorType : "system";
  return { actorType: t, actorId: actorId ?? null };
}

export async function resolveIssueScope(tx: Tx, companyId: string, issueIds: string[]): Promise<Map<string, IssueScope>> {
  const ids = [...new Set(issueIds.filter((x) => typeof x === "string" && x.length === 36))];
  const out = new Map<string, IssueScope>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ id: issues.id, projectId: issues.projectId, goalId: issues.goalId, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  for (const r of rows) out.set(r.id, { projectId: r.projectId ?? null, goalId: r.goalId ?? null, identifier: r.identifier ?? null });
  return out;
}

function boundedPayload(obj: Record<string, unknown>): Record<string, unknown> {
  const canonical = JSON.stringify(obj);
  if (canonical.length <= MAX_PAYLOAD_BYTES) return obj;
  return { truncated: true, keys: Object.keys(obj).sort(), hash: hashCanonical(obj), bytes: canonical.length };
}

/** T0: activity_log → issue/agent/approval/authority events. sourceVersion = the activity row id. */
export async function readActivityLog(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(activityLog.createdAt, activityLog.id, cursor);
  const rows = await tx
    .select(withCursorTime(activityLog, activityLog.createdAt))
    .from(activityLog)
    .where(after ? and(eq(activityLog.companyId, companyId), after) : eq(activityLog.companyId, companyId))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
    .limit(limit);
  const issueIds = rows.filter((r) => r.entityType === "issue" && r.entityId).map((r) => r.entityId as string);
  const scope = await resolveIssueScope(tx, companyId, issueIds);
  const events: EvaluationEventInput[] = [];
  for (const r of rows) {
    const details = (r.details ?? {}) as Record<string, unknown>;
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const actor = actorFrom(r.actorType, r.actorId);
    const isIssue = r.entityType === "issue" && !!r.entityId;
    const sc = isIssue ? scope.get(r.entityId as string) : undefined;
    const base = {
      companyId,
      projectId: sc?.projectId ?? null,
      goalId: sc?.goalId ?? null,
      ...actor,
      sourceTable: "activity_log",
      sourceId: r.id,
      sourceVersion: r.id,
      eventTime: r.createdAt,
    };
    const issueRef = isIssue ? { issueId: r.entityId, identifier: sc?.identifier ?? details.identifier ?? null } : {};
    let eventType: EvaluationEventType = "activity.other";
    let payload: Record<string, unknown> = { action: r.action, entityType: r.entityType, entityId: r.entityId, ...issueRef };
    if (r.action === "issue.created") {
      eventType = "issue.created";
    } else if (TRANSITION_ACTIONS.has(r.action) && isIssue) {
      if (typeof previous.status === "string" && typeof details.status === "string") {
        eventType = "issue.transition";
        payload = { ...issueRef, from: previous.status, to: details.status, reopened: details.reopened === true };
      } else if ("assigneeAgentId" in previous || "assigneeUserId" in previous) {
        eventType = "issue.assignment_changed";
        payload = {
          ...issueRef,
          fromAgentId: previous.assigneeAgentId ?? null,
          toAgentId: details.assigneeAgentId ?? null,
          fromUserId: previous.assigneeUserId ?? null,
          toUserId: details.assigneeUserId ?? null,
        };
      } else {
        payload = { ...payload, changedKeys: Object.keys(details).filter((k) => k !== "_previous" && k !== "identifier").sort() };
      }
    } else if (r.action === "issue.blockers_updated") {
      eventType = "issue.blockers_updated";
      payload = { ...issueRef, blockedByIssueIds: details.blockedByIssueIds ?? null, previous: previous.blockedByIssueIds ?? null };
    } else if (r.action === "issue.comment_added") {
      eventType = "issue.comment_added";
      payload = { ...issueRef, commentId: details.commentId ?? null, reopened: details.reopened === true };
    } else if (r.action === "dod_set") {
      eventType = "issue.dod_set";
      payload = { ...issueRef, hasPrevious: "_previous" in details, criteriaCount: countCriteria(details.definitionOfDone) };
    } else if (r.action === "issue.recovery_budget_exhausted") {
      eventType = "issue.recovery_budget_exhausted";
      payload = { ...issueRef, ...pick(details, ["reason", "runId", "attempts"]) };
    } else if (AGENT_LIFECYCLE_ACTIONS.has(r.action)) {
      eventType = "agent.lifecycle";
      payload = { action: r.action, agentId: r.agentId ?? r.entityId ?? null };
    } else if (r.action === "approval.created") {
      eventType = "approval.created";
      payload = { approvalId: r.entityId, type: details.type ?? null };
    } else if (APPROVAL_DECIDED_ACTIONS.has(r.action)) {
      eventType = "approval.decided";
      payload = { approvalId: r.entityId, decision: r.action.replace("approval.", ""), type: details.type ?? null };
    } else if (r.action === "authz.refused") {
      eventType = "authz.refused";
      payload = { ...pick(details, ["method", "routePath", "reasonCode"]), entityType: r.entityType, entityId: r.entityId };
    }
    events.push({ ...base, eventType, payload: boundedPayload(payload) });
  }
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

function countCriteria(dod: unknown): number | null {
  if (!dod || typeof dod !== "object") return null;
  const c = (dod as Record<string, unknown>).criteria;
  return Array.isArray(c) ? c.length : null;
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** T0: terminal heartbeat runs → run.finished. sourceVersion = status + finish time, so a retried run is a new fact. */
export async function readHeartbeatRuns(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(heartbeatRuns.updatedAt, heartbeatRuns.id, cursor);
  const rows = await tx
    .select(withCursorTime(heartbeatRuns, heartbeatRuns.updatedAt))
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
        ...(after ? [after] : []),
      ),
    )
    .orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id))
    .limit(limit);
  const issueIds = rows.map((r) => (r.contextSnapshot as Record<string, unknown> | null)?.issueId).filter((x): x is string => typeof x === "string");
  const scope = await resolveIssueScope(tx, companyId, issueIds);
  const events: EvaluationEventInput[] = rows.map((r) => {
    const ctx = (r.contextSnapshot ?? {}) as Record<string, unknown>;
    const issueId = typeof ctx.issueId === "string" ? ctx.issueId : null;
    const sc = issueId ? scope.get(issueId) : undefined;
    const usage = (r.usageJson ?? null) as Record<string, unknown> | null;
    const finished = r.finishedAt ?? r.updatedAt;
    return {
      companyId,
      projectId: sc?.projectId ?? null,
      goalId: sc?.goalId ?? null,
      actorType: "agent",
      actorId: r.agentId,
      sourceTable: "heartbeat_runs",
      sourceId: r.id,
      sourceVersion: `${r.status}:${finished.toISOString()}`,
      eventType: "run.finished",
      eventTime: finished,
      payload: {
        runId: r.id,
        agentId: r.agentId,
        issueId,
        identifier: sc?.identifier ?? null,
        status: r.status,
        exitCode: r.exitCode,
        errorCode: r.errorCode,
        livenessState: r.livenessState,
        invocationSource: r.invocationSource,
        triggerDetail: r.triggerDetail,
        retryOfRunId: r.retryOfRunId,
        startedAt: r.startedAt?.toISOString() ?? null,
        durationMs: r.startedAt ? finished.getTime() - r.startedAt.getTime() : null,
        usagePresent: !!usage && Object.keys(usage).length > 0,
        inputTokens: numberOrNull(usage?.inputTokens ?? usage?.input_tokens),
        outputTokens: numberOrNull(usage?.outputTokens ?? usage?.output_tokens),
      },
    };
  });
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** T0: verdicts are insert-only → verdict.recorded. Justification prose (T3) is not copied; its length is. */
export async function readVerdicts(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(verdicts.createdAt, verdicts.id, cursor);
  const rows = await tx
    .select(withCursorTime(verdicts, verdicts.createdAt))
    .from(verdicts)
    .where(after ? and(eq(verdicts.companyId, companyId), after) : eq(verdicts.companyId, companyId))
    .orderBy(asc(verdicts.createdAt), asc(verdicts.id))
    .limit(limit);
  const scope = await resolveIssueScope(tx, companyId, rows.map((r) => r.issueId).filter((x): x is string => !!x));
  const events: EvaluationEventInput[] = rows.map((r) => {
    const sc = r.issueId ? scope.get(r.issueId) : undefined;
    const actor = r.reviewerAgentId ? { actorType: "agent" as const, actorId: r.reviewerAgentId } : { actorType: "user" as const, actorId: r.reviewerUserId ?? null };
    return {
      companyId,
      projectId: r.projectId ?? sc?.projectId ?? null,
      goalId: r.goalId ?? sc?.goalId ?? null,
      ...actor,
      sourceTable: "verdicts",
      sourceId: r.id,
      sourceVersion: r.id,
      eventType: "verdict.recorded",
      eventTime: r.createdAt,
      payload: {
        verdictId: r.id,
        entityType: r.entityType,
        issueId: r.issueId,
        identifier: sc?.identifier ?? null,
        outcome: r.outcome,
        rubricScores: r.rubricScores ?? null,
        justificationLength: r.justification?.length ?? 0,
        reviewerAgentId: r.reviewerAgentId,
        reviewerUserId: r.reviewerUserId,
      },
    };
  });
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

/** T0: ask_user_questions and other interactions → interaction.changed, one event per status. */
export async function readInteractions(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(issueThreadInteractions.updatedAt, issueThreadInteractions.id, cursor);
  const rows = await tx
    .select(withCursorTime(issueThreadInteractions, issueThreadInteractions.updatedAt))
    .from(issueThreadInteractions)
    .where(after ? and(eq(issueThreadInteractions.companyId, companyId), after) : eq(issueThreadInteractions.companyId, companyId))
    .orderBy(asc(issueThreadInteractions.updatedAt), asc(issueThreadInteractions.id))
    .limit(limit);
  const scope = await resolveIssueScope(tx, companyId, rows.map((r) => r.issueId));
  const events: EvaluationEventInput[] = rows.map((r) => {
    const sc = scope.get(r.issueId);
    const actor = r.createdByAgentId ? { actorType: "agent" as const, actorId: r.createdByAgentId } : { actorType: "user" as const, actorId: r.createdByUserId ?? null };
    return {
      companyId,
      projectId: sc?.projectId ?? null,
      goalId: sc?.goalId ?? null,
      ...actor,
      sourceTable: "issue_thread_interactions",
      sourceId: r.id,
      sourceVersion: `${r.status}:${r.updatedAt.toISOString()}`,
      eventType: "interaction.changed",
      eventTime: r.updatedAt,
      payload: {
        interactionId: r.id,
        issueId: r.issueId,
        identifier: sc?.identifier ?? null,
        kind: r.kind,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        resolvedByAgentId: r.resolvedByAgentId ?? null,
        resolvedByUserId: r.resolvedByUserId ?? null,
        pendingMs: r.status === "pending" ? null : r.updatedAt.getTime() - r.createdAt.getTime(),
      },
    };
  });
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

/** T0: cost_events → cost.recorded (the one metering source; agent_runs is derived from it). */
export async function readCostEvents(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(costEvents.createdAt, costEvents.id, cursor);
  const rows = await tx
    .select(withCursorTime(costEvents, costEvents.createdAt))
    .from(costEvents)
    .where(after ? and(eq(costEvents.companyId, companyId), after) : eq(costEvents.companyId, companyId))
    .orderBy(asc(costEvents.createdAt), asc(costEvents.id))
    .limit(limit);
  const events: EvaluationEventInput[] = rows.map((r) => ({
    companyId,
    projectId: r.projectId ?? null,
    goalId: r.goalId ?? null,
    actorType: "agent",
    actorId: r.agentId,
    sourceTable: "cost_events",
    sourceId: r.id,
    sourceVersion: r.id,
    eventType: "cost.recorded",
    eventTime: r.occurredAt,
    payload: {
      costEventId: r.id,
      agentId: r.agentId,
      issueId: r.issueId,
      heartbeatRunId: r.heartbeatRunId,
      provider: r.provider,
      model: r.model,
      inputTokens: r.inputTokens,
      cachedInputTokens: r.cachedInputTokens,
      outputTokens: r.outputTokens,
      costCents: r.costCents,
    },
  }));
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

/** Find MAW handoff payloads inside a comment body: fenced JSON with `handoff_type` or `type` in the known set. */
export function extractHandoffPayloads(body: string): Array<{ type: EvaluationHandoffType; payload: Record<string, unknown> }> {
  const out: Array<{ type: EvaluationHandoffType; payload: Record<string, unknown> }> = [];
  if (!body.includes("{")) return out;
  for (const match of body.matchAll(FENCE_RE)) {
    const raw = match[1]?.trim();
    if (!raw || !raw.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      const t = (obj.handoff_type ?? obj.type) as unknown;
      if (typeof t === "string" && (EVALUATION_HANDOFF_TYPES as readonly string[]).includes(t)) {
        out.push({ type: t as EvaluationHandoffType, payload: obj });
      }
    } catch {
      // not JSON — prose stays T3 and is ignored
    }
  }
  return out;
}

/**
 * T2: structured self-reports in comments → handoff.<type>. The payload's own
 * timestamp is clamped to the comment's arrival (rule 4). sourceVersion is the
 * body hash, so an edited-in-place body would be a new version (there is no
 * comment-edit route today; deletion is detected separately).
 */
export async function readCommentHandoffs(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(issueComments.createdAt, issueComments.id, cursor);
  const rows = await tx
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
      cursorTime: sql<string>`${issueComments.createdAt}::text`,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        // Cheap prefilter before any parsing (spec §11).
        or(sql`${issueComments.body} LIKE '%"handoff_type"%'`, sql`${issueComments.body} LIKE '%"type"%'`),
        ...(after ? [after] : []),
      ),
    )
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
    .limit(limit);
  const scope = await resolveIssueScope(tx, companyId, rows.map((r) => r.issueId));
  const events: EvaluationEventInput[] = [];
  for (const r of rows) {
    const found = extractHandoffPayloads(r.body);
    if (found.length === 0) continue;
    const sc = scope.get(r.issueId);
    const bodyHash = hashCanonical(r.body);
    const actor = r.authorAgentId ? { actorType: "agent" as const, actorId: r.authorAgentId } : { actorType: "user" as const, actorId: r.authorUserId ?? null };
    for (const { type, payload } of found) {
      const clamp = clampEventTime((payload.timestamp as string | undefined) ?? null, r.createdAt);
      events.push({
        companyId,
        projectId: sc?.projectId ?? null,
        goalId: sc?.goalId ?? null,
        ...actor,
        sourceTable: "issue_comments",
        sourceId: r.id,
        sourceVersion: `${type}:${bodyHash}`,
        sourceRowHash: bodyHash,
        eventType: `handoff.${type}` as EvaluationEventType,
        eventTime: clamp.eventTime,
        payload: boundedPayload({
          commentId: r.id,
          issueId: r.issueId,
          identifier: sc?.identifier ?? null,
          handoffType: type,
          selfReported: true,
          claimedTimestamp: typeof payload.timestamp === "string" ? payload.timestamp : null,
          timestampClamped: clamp.clamped,
          timestampSuspicious: clamp.suspicious,
          claimedEarlierByMs: clamp.claimedEarlierByMs,
          payload,
        }),
      });
    }
  }
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

/** Rule 13: comments the ledger has seen that no longer exist → evidence.withdrawn (one event per comment). */
export async function detectWithdrawnComments(
  tx: Tx,
  companyId: string,
  knownCommentIds: Set<string>,
  detectedAt: Date,
): Promise<EvaluationEventInput[]> {
  if (knownCommentIds.size === 0) return [];
  const ids = [...knownCommentIds];
  const existing = new Set<string>();
  const CHUNK = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.id, ids.slice(i, i + CHUNK))));
    for (const r of rows) existing.add(r.id);
  }
  return ids
    .filter((id) => !existing.has(id))
    .map((id) => ({
      companyId,
      actorType: "system" as const,
      actorId: null,
      sourceTable: "issue_comments",
      sourceId: id,
      sourceVersion: "withdrawn",
      eventType: "evidence.withdrawn" as const,
      eventTime: detectedAt,
      payload: { commentId: id, detectedAt: detectedAt.toISOString(), reason: "comment no longer exists" },
    }));
}

/**
 * Rule 13: a content hash per issue on every change, so a rewrite inside the
 * ingest window is visible even when no activity row explains it. Prose stays
 * out of the ledger; only the hash and structural fields are stored.
 */
export async function readIssueSnapshots(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const after = keysetAfter(issues.updatedAt, issues.id, cursor);
  const rows = await tx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      definitionOfDone: issues.definitionOfDone,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      projectId: issues.projectId,
      goalId: issues.goalId,
      parentId: issues.parentId,
      updatedAt: issues.updatedAt,
      completedAt: issues.completedAt,
      cursorTime: sql<string>`${issues.updatedAt}::text`,
    })
    .from(issues)
    .where(after ? and(eq(issues.companyId, companyId), after) : eq(issues.companyId, companyId))
    .orderBy(asc(issues.updatedAt), asc(issues.id))
    .limit(limit);
  const events: EvaluationEventInput[] = rows.map((r) => {
    const hash = hashCanonical({
      title: r.title,
      description: r.description,
      definitionOfDone: r.definitionOfDone,
      status: r.status,
      assigneeAgentId: r.assigneeAgentId,
      assigneeUserId: r.assigneeUserId,
      projectId: r.projectId,
      goalId: r.goalId,
      parentId: r.parentId,
    });
    return {
      companyId,
      projectId: r.projectId ?? null,
      goalId: r.goalId ?? null,
      actorType: "system",
      actorId: null,
      sourceTable: "issues",
      sourceId: r.id,
      sourceVersion: hash,
      sourceRowHash: hash,
      eventType: "issue.snapshot",
      eventTime: r.updatedAt,
      payload: {
        issueId: r.id,
        identifier: r.identifier,
        status: r.status,
        hasDod: countCriteria(r.definitionOfDone) != null && (countCriteria(r.definitionOfDone) as number) > 0,
        dodCriteria: countCriteria(r.definitionOfDone),
        assigneeAgentId: r.assigneeAgentId,
        assigneeUserId: r.assigneeUserId,
        parentId: r.parentId,
        completedAt: r.completedAt?.toISOString() ?? null,
        contentHash: hash,
      },
    };
  });
  const last = rows[rows.length - 1];
  return { events, scanned: rows.length, nextCursor: last ? { time: last.cursorTime, id: last.id } : cursor };
}

export const SOURCE_READERS = {
  activity_log: readActivityLog,
  heartbeat_runs: readHeartbeatRuns,
  verdicts: readVerdicts,
  issue_thread_interactions: readInteractions,
  cost_events: readCostEvents,
  issue_comments: readCommentHandoffs,
  issues: readIssueSnapshots,
} as const;
export type SourceName = keyof typeof SOURCE_READERS;
