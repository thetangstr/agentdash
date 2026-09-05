import { and, asc, desc, eq, getTableColumns, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  costEvents,
  evaluationEvents,
  goals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueLabels,
  issueThreadInteractions,
  issues,
  labels,
  projects,
  verdicts,
} from "@paperclipai/db";
import {
  EVALUATION_HANDOFF_TYPES,
  type EvaluationActorType,
  type EvaluationEventType,
  type EvaluationHandoffType,
} from "@paperclipai/shared";
import { clampEventTime, hashCanonical, type EvaluationEventInput } from "./ledger.js";

/**
 * AgentDash: Company Evaluator — ingest sources (spec §6 T0/T2, §8 rules 4/6/7/13).
 *
 * Every source is a pure mapping from control-plane rows after a cursor to
 * ledger events. Sources never write; the ingest loop appends. Cursors are
 * keyset `(time, id)` pairs at Postgres precision, re-read with a small lag so
 * rows whose timestamps were set or backdated after insert are not skipped
 * (dedupe makes the overlap free).
 */

/** The drizzle transaction type, so sources can run under a local statement_timeout. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Cursor {
  time?: string;
  id?: string;
  /** issue_comments only: when withdrawal detection (rule 13) last ran; it scans every known id, so it runs on a cadence. */
  withdrawalCheckedAt?: string;
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
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

/** Payloads above this canonical size are stored as a hash plus key list, not verbatim. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

/** Re-read this far behind the cursor each tick; dedupe absorbs the overlap. */
export const CURSOR_LAG_SECONDS = 60;

/** One comment mints at most this many handoff events; further fenced payloads are counted, not stored. */
export const MAX_HANDOFFS_PER_COMMENT = 8;

/** How far up `parentId` a descendant is followed to inherit a project (spec §3 membership). */
const MAX_PARENT_DEPTH = 10;

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
 * MAW payload fields kept per handoff type (D4-A: schema-validated subset of
 * doc/maw/handoff-schemas.json). Free-text fields — implementation_notes,
 * test_plan, out_of_scope, user_stories, deployment_notes — are T3 prose and
 * are dropped; `acceptance_criteria` is kept because it is the acceptance
 * source the contract derives from (spec §4.3).
 */
export const HANDOFF_FIELD_ALLOWLIST: Record<EvaluationHandoffType, readonly string[]> = {
  pm_to_builder: ["issue", "epic", "size", "estimate_points", "deployment_path", "pr_target_branch", "acceptance_criteria", "cujs", "staging_required", "timestamp"],
  builder_to_ci: ["issue", "size", "epic", "pr", "branch", "regression_gates", "e2e_tests", "cujs", "execution_engine", "labels_applied", "fix_attempt", "timestamp"],
  tester_to_reviewer: ["issue", "size", "verdict", "quality_gate_label", "regression_gates", "e2e_results", "code_review", "cuj_verification", "console_errors", "network_failures", "human_only_checklist", "failure_sub_issues", "fix_attempt", "labels_applied", "timestamp"],
  reviewer_to_tpm: ["issue", "size", "deployment_path", "pr", "verification_method", "human_checklist_items_verified", "wave", "labels_applied", "timestamp"],
  tpm_merge_report: ["issue", "merge_result", "pr", "health_check", "smoke_test", "staging_rebase", "labels_applied", "linear_state", "wave_progress", "timestamp"],
};

/** Re-read at most this many rows behind the cursor per tick (backdated or same-instant rows a page boundary split). */
export const LAG_REREAD_BUDGET = 1000;

/**
 * Keyset reads in two bounded parts, so a dense window can never stall the
 * cursor (a time-only predicate re-admits the same page forever once more
 * than a budget of rows share a 60-second span):
 * - progress: rows strictly after the cursor in `(time, id)` order — these
 *   advance the cursor and are what `scanned` counts;
 * - lag re-read: rows at or before the cursor whose time is within the lag
 *   window — rows whose timestamp was assigned or backdated after the cursor
 *   passed, or split from their page by an equal timestamp — read backwards
 *   from the cursor so the bounded budget covers the rows nearest it. Dedupe
 *   makes the overlap free; they never move the cursor.
 * Cursor times are the database's own `::text` rendering (microseconds), never
 * a JavaScript Date (milliseconds): otherwise rows created by `now()` sort
 * after their own cursor forever.
 */
/** ORDER BY for a keyset read: forwards for progress, backwards from the cursor for the lag re-read. */
export function ordered(direction: "asc" | "desc", timeCol: unknown, idCol: unknown) {
  return direction === "asc" ? [asc(timeCol as never), asc(idCol as never)] : [desc(timeCol as never), desc(idCol as never)];
}

export async function keysetRead<Row extends { cursorTime: string }>(
  cursor: Cursor,
  limit: number,
  timeCol: unknown,
  idCol: unknown,
  run: (predicate: SQL | undefined, take: number, direction: "asc" | "desc") => Promise<Row[]>,
  idOf: (row: Row) => string,
  /** Unique per row when the tiebreak column is not (issue_labels: issue id for the cursor, issue:label for dedupe). */
  rowKey: (row: Row) => string = idOf,
): Promise<{ rows: Row[]; scanned: number; nextCursor: Cursor }> {
  const t = timeCol as never;
  const i = idCol as never;
  const progressPredicate: SQL | undefined = !cursor.time
    ? undefined
    : cursor.id
      ? sql`(${t}, ${i}) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
      : sql`${t} > ${cursor.time}::timestamptz`;
  const progress = await run(progressPredicate, limit, "asc");
  const last = progress[progress.length - 1];
  const nextCursor: Cursor = last ? { time: last.cursorTime, id: idOf(last) } : { ...cursor };
  let rows = progress;
  if (cursor.time) {
    const upper = cursor.id
      ? sql`(${t}, ${i}) <= (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
      : sql`${t} <= ${cursor.time}::timestamptz`;
    const lagPredicate = sql`${t} > (${cursor.time}::timestamptz - make_interval(secs => ${CURSOR_LAG_SECONDS})) AND ${upper}`;
    // Descending from the cursor: the budget is spent on the rows nearest the cursor, where a late or backdated row lands.
    const lag = await run(lagPredicate, Math.min(limit, LAG_REREAD_BUDGET), "desc");
    const seen = new Set(progress.map(rowKey));
    rows = progress.concat(lag.filter((r) => !seen.has(rowKey(r))));
  }
  return { rows, scanned: progress.length, nextCursor };
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

type IssueRow = {
  projectId: string | null;
  goalId: string | null;
  identifier: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

/**
 * Resolve project/goal scope for issues. A descendant that carries no
 * projectId inherits the nearest ancestor's (spec §3), followed up to
 * MAX_PARENT_DEPTH parents.
 */
export async function resolveIssueScope(tx: Tx, companyId: string, issueIds: string[]): Promise<Map<string, IssueScope>> {
  const wanted = [...new Set(issueIds.filter((x) => typeof x === "string" && x.length === 36))];
  const out = new Map<string, IssueScope>();
  if (wanted.length === 0) return out;
  const cache = new Map<string, IssueRow>();
  async function load(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    if (missing.length === 0) return;
    const rows = await tx
      .select({
        id: issues.id,
        projectId: issues.projectId,
        goalId: issues.goalId,
        identifier: issues.identifier,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, missing)));
    for (const r of rows) cache.set(r.id, r);
  }
  await load(wanted);
  // Load ancestors one level per round for issues that still lack a project.
  let frontier = wanted.filter((id) => cache.get(id) && !cache.get(id)!.projectId && cache.get(id)!.parentId);
  for (let depth = 0; depth < MAX_PARENT_DEPTH && frontier.length > 0; depth++) {
    const parents = frontier.map((id) => cache.get(id)!.parentId!).filter(Boolean);
    await load(parents);
    frontier = parents.filter((pid) => cache.get(pid) && !cache.get(pid)!.projectId && cache.get(pid)!.parentId);
  }
  for (const id of wanted) {
    const row = cache.get(id);
    if (!row) continue;
    let projectId = row.projectId;
    let goalId = row.goalId;
    let walk: IssueRow | undefined = row;
    for (let depth = 0; depth < MAX_PARENT_DEPTH && !projectId && walk?.parentId; depth++) {
      const parent = cache.get(walk.parentId);
      if (!parent) break;
      if (parent.projectId) {
        projectId = parent.projectId;
        goalId = goalId ?? parent.goalId;
        break;
      }
      walk = parent;
    }
    out.set(id, {
      projectId: projectId ?? null,
      goalId: goalId ?? null,
      identifier: row.identifier ?? null,
      assigneeAgentId: row.assigneeAgentId ?? null,
      assigneeUserId: row.assigneeUserId ?? null,
    });
  }
  return out;
}

function boundedPayload(obj: Record<string, unknown>): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(obj), "utf8");
  if (bytes <= MAX_PAYLOAD_BYTES) return obj;
  return { truncated: true, keys: Object.keys(obj).sort(), hash: hashCanonical(obj), bytes };
}

function countCriteria(dod: unknown): number | null {
  if (!dod || typeof dod !== "object") return null;
  const c = (dod as Record<string, unknown>).criteria;
  return Array.isArray(c) ? c.length : null;
}

/** Criterion ids and text hashes (never the text): enough to see removal or rewording (rule 11 / E12). */
function criteriaDigest(dod: unknown): { ids: string[]; hashes: string[] } | null {
  if (!dod || typeof dod !== "object") return null;
  const c = (dod as Record<string, unknown>).criteria;
  if (!Array.isArray(c)) return null;
  const ids: string[] = [];
  const hashes: string[] = [];
  for (const item of c) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    ids.push(typeof o.id === "string" ? o.id : "");
    hashes.push(hashCanonical(typeof o.text === "string" ? o.text.trim().toLowerCase() : null).slice(0, 16));
  }
  return { ids, hashes };
}

const TITLE_STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "when", "then", "than", "are", "was", "not", "but", "its", "via", "per", "add", "fix"]);

/** Rule 18 / P9: a normalised token set for title matching. Tokens, not the title, are stored. */
export function titleTokens(title: string | null | undefined): string[] {
  if (!title) return [];
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/**
 * T0: activity_log → issue/agent/approval/authority events. sourceVersion = the activity row id.
 *
 * Status changes are logged in three shapes by different emitters and all are
 * recognised as `issue.transition`: the PATCH route (`{status, _previous:{status}}`),
 * the comment/wake reopen paths (`{status, reopened:true, reopenedFrom}`), and
 * the recovery service (`{status, previousStatus}`). Assignment changes likewise
 * with or without `_previous`. Approval events inherit scope through issue_approvals.
 */
export async function readActivityLog(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, activityLog.createdAt, activityLog.id, (predicate, take, direction) =>
    tx
      .select(withCursorTime(activityLog, activityLog.createdAt))
      .from(activityLog)
      .where(predicate ? and(eq(activityLog.companyId, companyId), predicate) : eq(activityLog.companyId, companyId))
      .orderBy(...ordered(direction, activityLog.createdAt, activityLog.id))
      .limit(take),
    (r) => r.id,
  );
  const issueIds = rows.filter((r) => r.entityType === "issue" && r.entityId).map((r) => r.entityId as string);
  const approvalIds = [...new Set(rows.filter((r) => r.entityType === "approval" && r.entityId).map((r) => r.entityId as string))];
  const approvalIssue = new Map<string, string>();
  if (approvalIds.length > 0) {
    const links = await tx
      .select({ approvalId: issueApprovals.approvalId, issueId: issueApprovals.issueId })
      .from(issueApprovals)
      .where(and(eq(issueApprovals.companyId, companyId), inArray(issueApprovals.approvalId, approvalIds)));
    for (const l of links) if (!approvalIssue.has(l.approvalId)) approvalIssue.set(l.approvalId, l.issueId);
  }
  const scope = await resolveIssueScope(tx, companyId, [...issueIds, ...approvalIssue.values()]);
  const events: EvaluationEventInput[] = [];
  for (const r of rows) {
    // Rules 9/12: the evaluator's own audit rows (operator actions) never enter the ledger.
    if (r.action.startsWith("evaluation.")) continue;
    const details = (r.details ?? {}) as Record<string, unknown>;
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const actor = actorFrom(r.actorType, r.actorId);
    const isIssue = r.entityType === "issue" && !!r.entityId;
    const linkedIssueId = isIssue
      ? (r.entityId as string)
      : r.entityType === "approval" && r.entityId
        ? (approvalIssue.get(r.entityId) ?? null)
        : null;
    const sc = linkedIssueId ? scope.get(linkedIssueId) : undefined;
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
    const issueRef = linkedIssueId ? { issueId: linkedIssueId, identifier: sc?.identifier ?? details.identifier ?? null } : {};
    let eventType: EvaluationEventType = "activity.other";
    let payload: Record<string, unknown> = { action: r.action, entityType: r.entityType, entityId: r.entityId, ...issueRef };
    if (r.action === "issue.created") {
      eventType = "issue.created";
    } else if (r.action === "issue.updated" && isIssue) {
      const toStatus = typeof details.status === "string" ? details.status : null;
      const fromStatus =
        typeof previous.status === "string"
          ? previous.status
          : typeof details.previousStatus === "string"
            ? details.previousStatus
            : typeof details.reopenedFrom === "string"
              ? details.reopenedFrom
              : null;
      // The PATCH route echoes every submitted field into details but records only changed ones in _previous,
      // so with _previous present an assignee key must be there to count as a change; emitters without
      // _previous (recovery service) are judged on presence.
      const assignmentTouched =
        "_previous" in details ? "assigneeAgentId" in previous || "assigneeUserId" in previous : "assigneeAgentId" in details || "assigneeUserId" in details;
      const assignmentPayload = {
        ...issueRef,
        fromAgentId: previous.assigneeAgentId ?? null,
        toAgentId: details.assigneeAgentId ?? null,
        fromUserId: previous.assigneeUserId ?? null,
        toUserId: details.assigneeUserId ?? null,
        previousUnknown: !("assigneeAgentId" in previous) && !("assigneeUserId" in previous),
      };
      if (toStatus && assignmentTouched) {
        // One PATCH may move status and reassign at once: both facts are minted from the one row (distinct event types).
        events.push({ ...base, eventType: "issue.assignment_changed", payload: boundedPayload(assignmentPayload) });
      }
      if (toStatus) {
        eventType = "issue.transition";
        const terminal = ["done", "cancelled"];
        payload = {
          ...issueRef,
          from: fromStatus,
          fromUnknown: fromStatus === null,
          to: toStatus,
          reopened: details.reopened === true || (fromStatus != null && terminal.includes(fromStatus) && !terminal.includes(toStatus)),
          source: typeof details.source === "string" ? details.source : null,
        };
      } else if (assignmentTouched) {
        eventType = "issue.assignment_changed";
        payload = assignmentPayload;
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
      const prev = details._previous as Record<string, unknown> | null | undefined;
      const digest = criteriaDigest(details.definitionOfDone);
      const prevDigest = prev ? criteriaDigest(prev.definitionOfDone ?? prev) : null;
      payload = {
        ...issueRef,
        hasPrevious: "_previous" in details,
        criteriaCount: countCriteria(details.definitionOfDone),
        previousCriteriaCount: prev ? countCriteria(prev.definitionOfDone ?? prev) : null,
        criteriaIds: digest?.ids ?? null,
        criteriaHashes: digest?.hashes ?? null,
        previousCriteriaIds: prevDigest?.ids ?? null,
        previousCriteriaHashes: prevDigest?.hashes ?? null,
      };
    } else if (r.action === "issue.recovery_budget_exhausted") {
      eventType = "issue.recovery_budget_exhausted";
      payload = { ...issueRef, ...pick(details, ["reason", "runId", "attempts"]) };
    } else if (AGENT_LIFECYCLE_ACTIONS.has(r.action)) {
      eventType = "agent.lifecycle";
      payload = { action: r.action, agentId: r.agentId ?? r.entityId ?? null };
    } else if (r.action === "approval.created") {
      eventType = "approval.created";
      payload = { ...issueRef, approvalId: r.entityId, type: details.type ?? null };
    } else if (APPROVAL_DECIDED_ACTIONS.has(r.action)) {
      eventType = "approval.decided";
      payload = { ...issueRef, approvalId: r.entityId, decision: r.action.replace("approval.", ""), type: details.type ?? null };
    } else if (r.action === "authz.refused") {
      eventType = "authz.refused";
      payload = { ...issueRef, ...pick(details, ["method", "routePath", "reasonCode"]), entityType: r.entityType, entityId: r.entityId };
    }
    events.push({ ...base, eventType, payload: boundedPayload(payload) });
  }
  return { events, scanned, nextCursor };
}

/** T0: terminal heartbeat runs → run.finished. sourceVersion = status + finish time, so a retried run is a new fact. */
export async function readHeartbeatRuns(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, heartbeatRuns.updatedAt, heartbeatRuns.id, (predicate, take, direction) =>
    tx
      .select(withCursorTime(heartbeatRuns, heartbeatRuns.updatedAt))
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]), ...(predicate ? [predicate] : [])))
      .orderBy(...ordered(direction, heartbeatRuns.updatedAt, heartbeatRuns.id))
      .limit(take),
    (r) => r.id,
  );
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
      // A terminal run without finished_at must not become a new fact on every later touch: no time falls back in.
      sourceVersion: `${r.status}:${r.finishedAt ? r.finishedAt.toISOString() : "none"}`,
      eventType: "run.finished",
      eventTime: finished,
      // Rule 6: the run and its cost events describe one fact.
      correlationId: `run:${r.id}`,
      payload: boundedPayload({
        runId: r.id,
        agentId: r.agentId,
        issueId,
        identifier: sc?.identifier ?? null,
        status: r.status,
        exitCode: r.exitCode,
        errorCode: r.errorCode,
        livenessState: r.livenessState,
        invocationSource: r.invocationSource,
        triggerDetail: typeof r.triggerDetail === "string" ? r.triggerDetail.slice(0, 200) : null,
        retryOfRunId: r.retryOfRunId,
        startedAt: r.startedAt?.toISOString() ?? null,
        durationMs: r.startedAt ? finished.getTime() - r.startedAt.getTime() : null,
        usagePresent: !!usage && Object.keys(usage).length > 0,
        inputTokens: numberOrNull(usage?.inputTokens ?? usage?.input_tokens),
        outputTokens: numberOrNull(usage?.outputTokens ?? usage?.output_tokens),
      }),
    };
  });
  return { events, scanned, nextCursor };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** T0: verdicts are insert-only → verdict.recorded. Justification prose (T3) is not copied; its length is. */
export async function readVerdicts(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, verdicts.createdAt, verdicts.id, (predicate, take, direction) =>
    tx
      .select(withCursorTime(verdicts, verdicts.createdAt))
      .from(verdicts)
      .where(predicate ? and(eq(verdicts.companyId, companyId), predicate) : eq(verdicts.companyId, companyId))
      .orderBy(...ordered(direction, verdicts.createdAt, verdicts.id))
      .limit(take),
    (r) => r.id,
  );
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
      payload: boundedPayload({
        verdictId: r.id,
        entityType: r.entityType,
        issueId: r.issueId,
        identifier: sc?.identifier ?? null,
        outcome: r.outcome,
        rubricScores: r.rubricScores ?? null,
        justificationLength: r.justification?.length ?? 0,
        reviewerAgentId: r.reviewerAgentId,
        reviewerUserId: r.reviewerUserId,
      }),
    };
  });
  return { events, scanned, nextCursor };
}

/** T0: ask_user_questions and other interactions → interaction.changed, one event per status. */
export async function readInteractions(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, issueThreadInteractions.updatedAt, issueThreadInteractions.id, (predicate, take, direction) =>
    tx
      .select(withCursorTime(issueThreadInteractions, issueThreadInteractions.updatedAt))
      .from(issueThreadInteractions)
      .where(predicate ? and(eq(issueThreadInteractions.companyId, companyId), predicate) : eq(issueThreadInteractions.companyId, companyId))
      .orderBy(...ordered(direction, issueThreadInteractions.updatedAt, issueThreadInteractions.id))
      .limit(take),
    (r) => r.id,
  );
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
      // One event per status: a row touched without a status change (result payload writes) is not a new fact.
      sourceVersion: r.status,
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
  return { events, scanned, nextCursor };
}

/** T0: cost_events → cost.recorded (the one metering source; agent_runs is derived from it). */
export async function readCostEvents(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, costEvents.createdAt, costEvents.id, (predicate, take, direction) =>
    tx
      .select(withCursorTime(costEvents, costEvents.createdAt))
      .from(costEvents)
      .where(predicate ? and(eq(costEvents.companyId, companyId), predicate) : eq(costEvents.companyId, companyId))
      .orderBy(...ordered(direction, costEvents.createdAt, costEvents.id))
      .limit(take),
    (r) => r.id,
  );
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
    correlationId: r.heartbeatRunId ? `run:${r.heartbeatRunId}` : null,
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
  return { events, scanned, nextCursor };
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

/** D4-A: keep only the structured fields the MAW schema defines for the type; record what was dropped. */
export function allowlistHandoffPayload(
  type: EvaluationHandoffType,
  payload: Record<string, unknown>,
): { kept: Record<string, unknown>; droppedKeys: string[] } {
  const allow = new Set<string>(HANDOFF_FIELD_ALLOWLIST[type]);
  const kept: Record<string, unknown> = {};
  const droppedKeys: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k === "type" || k === "handoff_type") continue;
    if (allow.has(k)) kept[k] = v;
    else droppedKeys.push(k);
  }
  return { kept, droppedKeys: droppedKeys.sort() };
}

/**
 * T2: structured self-reports in comments → handoff.<type>. The payload's own
 * timestamp is clamped to the comment's arrival (rule 4); fields are reduced to
 * the schema's structured subset (D4-A); `selfReported` is true when the comment
 * author is the item's assignee, i.e. the payload's subject (rule 7).
 */
export async function readCommentHandoffs(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, issueComments.createdAt, issueComments.id, (predicate, take, direction) =>
    tx
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
          // Cheap prefilter before any parsing (spec §11); the trigram index serves both patterns.
          or(sql`${issueComments.body} LIKE '%"handoff_type"%'`, sql`${issueComments.body} LIKE '%"type"%'`),
          ...(predicate ? [predicate] : []),
        ),
    )
      .orderBy(...ordered(direction, issueComments.createdAt, issueComments.id))
      .limit(take),
    (r) => r.id,
  );
  const scope = await resolveIssueScope(tx, companyId, rows.map((r) => r.issueId));
  const events: EvaluationEventInput[] = [];
  for (const r of rows) {
    const found = extractHandoffPayloads(r.body);
    if (found.length === 0) continue;
    const handoffs = found.slice(0, MAX_HANDOFFS_PER_COMMENT);
    const sc = scope.get(r.issueId);
    const bodyHash = hashCanonical(r.body);
    const actor = r.authorAgentId ? { actorType: "agent" as const, actorId: r.authorAgentId } : { actorType: "user" as const, actorId: r.authorUserId ?? null };
    const selfReported =
      (!!r.authorAgentId && r.authorAgentId === sc?.assigneeAgentId) || (!!r.authorUserId && r.authorUserId === sc?.assigneeUserId);
    for (const [handoffIndex, { type, payload }] of handoffs.entries()) {
      const clamp = clampEventTime((payload.timestamp as string | undefined) ?? null, r.createdAt);
      const { kept, droppedKeys } = allowlistHandoffPayload(type, payload);
      events.push({
        companyId,
        projectId: sc?.projectId ?? null,
        goalId: sc?.goalId ?? null,
        ...actor,
        sourceTable: "issue_comments",
        sourceId: r.id,
        // The position inside the comment keeps two same-type payloads in one comment as two facts.
        sourceVersion: `${type}:${handoffIndex}:${bodyHash}`,
        sourceRowHash: bodyHash,
        eventType: `handoff.${type}` as EvaluationEventType,
        eventTime: clamp.eventTime,
        payload: boundedPayload({
          commentId: r.id,
          issueId: r.issueId,
          identifier: sc?.identifier ?? null,
          handoffType: type,
          handoffIndex,
          handoffsInComment: found.length,
          handoffsDropped: found.length - handoffs.length,
          selfReported,
          claimedTimestamp: typeof payload.timestamp === "string" ? payload.timestamp : null,
          timestampClamped: clamp.clamped,
          timestampSuspicious: clamp.suspicious,
          claimedEarlierByMs: clamp.claimedEarlierByMs,
          droppedKeys,
          payload: kept,
        }),
      });
    }
  }
  return { events, scanned, nextCursor };
}

/**
 * Rule 13: comments the ledger has seen that no longer exist → evidence.withdrawn
 * (one event per comment), carrying the scope of the original handoff event so
 * E13 reaches the milestone card.
 */
export async function detectWithdrawnComments(
  tx: Tx,
  companyId: string,
  known: Map<string, { projectId: string | null; goalId: string | null }>,
  detectedAt: Date,
): Promise<EvaluationEventInput[]> {
  if (known.size === 0) return [];
  const ids = [...known.keys()];
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
      projectId: known.get(id)?.projectId ?? null,
      goalId: known.get(id)?.goalId ?? null,
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

/** The most recent stored snapshot hash per source id, so a row touch that changes nothing hashed mints nothing. */
async function latestSnapshotHashes(tx: Tx, companyId: string, sourceTable: string, eventType: EvaluationEventType, sourceIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sourceIds.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([evaluationEvents.sourceId], { sourceId: evaluationEvents.sourceId, hash: evaluationEvents.sourceRowHash })
    .from(evaluationEvents)
    .where(
      and(
        eq(evaluationEvents.companyId, companyId),
        eq(evaluationEvents.sourceTable, sourceTable),
        eq(evaluationEvents.eventType, eventType),
        inArray(evaluationEvents.sourceId, sourceIds),
      ),
    )
    .orderBy(evaluationEvents.sourceId, desc(evaluationEvents.seq));
  for (const r of rows) if (r.hash) out.set(r.sourceId, r.hash);
  return out;
}

/**
 * Rule 13: a content hash per issue on every change, so a rewrite inside the
 * ingest window is visible even when no activity row explains it. A snapshot
 * is minted only when the hash differs from the latest stored one (the run
 * lifecycle touches `updated_at` on every claim and release without changing
 * anything hashed); the version is the hash plus the row's updated time, so an
 * A→B→A revert is still three events. Prose stays out of the ledger; only the
 * hash and structural fields are stored.
 */
export async function readIssueSnapshots(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, issues.updatedAt, issues.id, (predicate, take, direction) =>
    tx
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        definitionOfDone: issues.definitionOfDone,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        originKind: issues.originKind,
        originFingerprint: issues.originFingerprint,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        createdAt: issues.createdAt,
        startedAt: issues.startedAt,
        updatedAt: issues.updatedAt,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        cursorTime: sql<string>`${issues.updatedAt}::text`,
      })
      .from(issues)
      .where(predicate ? and(eq(issues.companyId, companyId), predicate) : eq(issues.companyId, companyId))
      .orderBy(...ordered(direction, issues.updatedAt, issues.id))
      .limit(take),
    (r) => r.id,
  );
  const scope = await resolveIssueScope(tx, companyId, rows.map((r) => r.id));
  const labelNames = await labelsFor(tx, companyId, rows.map((r) => r.id));
  const latest = await latestSnapshotHashes(tx, companyId, "issues", "issue.snapshot", rows.map((r) => r.id));
  const events: EvaluationEventInput[] = rows.flatMap((r) => {
    const issueLabelNames = labelNames.get(r.id) ?? [];
    const hash = hashCanonical({
      title: r.title,
      description: r.description,
      definitionOfDone: r.definitionOfDone,
      status: r.status,
      priority: r.priority,
      assigneeAgentId: r.assigneeAgentId,
      assigneeUserId: r.assigneeUserId,
      projectId: r.projectId,
      goalId: r.goalId,
      parentId: r.parentId,
      labels: issueLabelNames,
    });
    if (latest.get(r.id) === hash) return [];
    const sc = scope.get(r.id);
    const criteria = countCriteria(r.definitionOfDone);
    const digest = criteriaDigest(r.definitionOfDone);
    const event: EvaluationEventInput = {
      companyId,
      projectId: sc?.projectId ?? r.projectId ?? null,
      goalId: sc?.goalId ?? r.goalId ?? null,
      actorType: "system",
      actorId: null,
      sourceTable: "issues",
      sourceId: r.id,
      sourceVersion: `${hash}:${r.cursorTime}`,
      sourceRowHash: hash,
      eventType: "issue.snapshot",
      eventTime: r.updatedAt,
      payload: {
        issueId: r.id,
        identifier: r.identifier,
        status: r.status,
        priority: r.priority,
        hasDod: criteria != null && criteria > 0,
        dodCriteria: criteria,
        dodCriteriaIds: digest?.ids ?? null,
        dodCriteriaHashes: digest?.hashes ?? null,
        assigneeAgentId: r.assigneeAgentId,
        assigneeUserId: r.assigneeUserId,
        createdByAgentId: r.createdByAgentId,
        createdByUserId: r.createdByUserId,
        projectId: r.projectId,
        goalId: r.goalId,
        inheritedProjectId: !r.projectId && sc?.projectId ? sc.projectId : null,
        parentId: r.parentId,
        labels: issueLabelNames,
        titleTokens: titleTokens(r.title),
        originKind: r.originKind,
        originFingerprint: r.originFingerprint,
        checkoutRunId: r.checkoutRunId,
        executionRunId: r.executionRunId,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        contentHash: hash,
      },
    };
    return [event];
  });
  return { events, scanned, nextCursor };
}

/** Label names per issue for a page of issues (sorted, so the snapshot hash is stable). */
async function labelsFor(tx: Tx, companyId: string, issueIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ issueId: issueLabels.issueId, name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(and(eq(issueLabels.companyId, companyId), inArray(issueLabels.issueId, ids)));
  for (const r of rows) {
    const list = out.get(r.issueId) ?? [];
    list.push(r.name);
    out.set(r.issueId, list);
  }
  for (const [k, v] of out) out.set(k, [...new Set(v)].sort());
  return out;
}

/**
 * T0: label additions → issue.label_added. Adding a label does not touch the
 * issue row, so the snapshot reader would not see it until the next issue
 * change; this reader does. Removals are visible only through the next snapshot.
 */
export async function readIssueLabels(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(
    cursor,
    limit,
    issueLabels.createdAt,
    issueLabels.issueId,
    (predicate, take) =>
      tx
        .select({
          issueId: issueLabels.issueId,
          labelId: issueLabels.labelId,
          name: labels.name,
          createdAt: issueLabels.createdAt,
          cursorTime: sql<string>`${issueLabels.createdAt}::text`,
        })
        .from(issueLabels)
        .innerJoin(labels, eq(issueLabels.labelId, labels.id))
        .where(predicate ? and(eq(issueLabels.companyId, companyId), predicate) : eq(issueLabels.companyId, companyId))
        .orderBy(asc(issueLabels.createdAt), asc(issueLabels.issueId), asc(issueLabels.labelId))
        .limit(take),
    (r) => r.issueId,
    (r) => `${r.issueId}:${r.labelId}`,
  );
  const scope = await resolveIssueScope(tx, companyId, rows.map((r) => r.issueId));
  const events: EvaluationEventInput[] = rows.map((r) => {
    const sc = scope.get(r.issueId);
    return {
      companyId,
      projectId: sc?.projectId ?? null,
      goalId: sc?.goalId ?? null,
      actorType: "system",
      actorId: null,
      sourceTable: "issue_labels",
      sourceId: `${r.issueId}:${r.labelId}`,
      sourceVersion: "added",
      eventType: "issue.label_added",
      eventTime: r.createdAt,
      payload: { issueId: r.issueId, identifier: sc?.identifier ?? null, label: r.name },
    };
  });
  return { events, scanned, nextCursor };
}

/**
 * T0 roster: agents → agent.snapshot. Routing (manager := reportsTo → accountable
 * human) and independence need these facts inside the window, so a card is a
 * function of the ledger alone. Version = hash of the facts: a heartbeat touch
 * that changes nothing mints nothing.
 */
export async function readAgentSnapshots(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, agents.updatedAt, agents.id, (predicate, take) =>
    tx
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        reportsTo: agents.reportsTo,
        accountableUserId: agents.accountableUserId,
        autonomy: agents.autonomy,
        createdByUserId: agents.createdByUserId,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
        cursorTime: sql<string>`${agents.updatedAt}::text`,
      })
      .from(agents)
      .where(predicate ? and(eq(agents.companyId, companyId), predicate) : eq(agents.companyId, companyId))
      .orderBy(asc(agents.updatedAt), asc(agents.id))
      .limit(take),
    (r) => r.id,
  );
  const events: EvaluationEventInput[] = rows.map((r) => {
    const facts = { name: r.name, role: r.role, status: r.status, reportsTo: r.reportsTo, accountableUserId: r.accountableUserId, autonomy: r.autonomy };
    const hash = hashCanonical(facts);
    return {
      companyId,
      actorType: "system",
      actorId: null,
      sourceTable: "agents",
      sourceId: r.id,
      sourceVersion: hash,
      sourceRowHash: hash,
      eventType: "agent.snapshot",
      eventTime: r.updatedAt,
      payload: { agentId: r.id, ...facts, createdByUserId: r.createdByUserId, createdAt: r.createdAt.toISOString() },
    };
  });
  return { events, scanned, nextCursor };
}

/** T0 roster: projects → project.snapshot (status timeline, lead, target date, DoD). Version = hash + updated time so A→B→A is visible. */
export async function readProjectSnapshots(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, projects.updatedAt, projects.id, (predicate, take) =>
    tx
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        goalId: projects.goalId,
        leadAgentId: projects.leadAgentId,
        targetDate: projects.targetDate,
        definitionOfDone: projects.definitionOfDone,
        archivedAt: projects.archivedAt,
        createdByUserId: projects.createdByUserId,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        cursorTime: sql<string>`${projects.updatedAt}::text`,
      })
      .from(projects)
      .where(predicate ? and(eq(projects.companyId, companyId), predicate) : eq(projects.companyId, companyId))
      .orderBy(asc(projects.updatedAt), asc(projects.id))
      .limit(take),
    (r) => r.id,
  );
  const events: EvaluationEventInput[] = rows.map((r) => {
    const digest = criteriaDigest(r.definitionOfDone);
    const facts = {
      name: r.name,
      status: r.status,
      goalId: r.goalId,
      leadAgentId: r.leadAgentId,
      targetDate: r.targetDate ?? null,
      dodCriteria: countCriteria(r.definitionOfDone),
      dodCriteriaHashes: digest?.hashes ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
    };
    const hash = hashCanonical(facts);
    return {
      companyId,
      projectId: r.id,
      goalId: r.goalId ?? null,
      actorType: "system",
      actorId: null,
      sourceTable: "projects",
      sourceId: r.id,
      sourceVersion: `${hash}:${r.cursorTime}`,
      sourceRowHash: hash,
      eventType: "project.snapshot",
      eventTime: r.updatedAt,
      payload: { projectId: r.id, ...facts, createdByUserId: r.createdByUserId, createdAt: r.createdAt.toISOString() },
    };
  });
  return { events, scanned, nextCursor };
}

/** T0 roster: goals → goal.snapshot (status timeline, owner, metric definition shape — never its prose). */
export async function readGoalSnapshots(tx: Tx, companyId: string, cursor: Cursor, limit: number): Promise<SourceReadResult> {
  const { rows, scanned, nextCursor } = await keysetRead(cursor, limit, goals.updatedAt, goals.id, (predicate, take) =>
    tx
      .select({
        id: goals.id,
        title: goals.title,
        level: goals.level,
        status: goals.status,
        parentId: goals.parentId,
        ownerAgentId: goals.ownerAgentId,
        metricDefinition: goals.metricDefinition,
        createdAt: goals.createdAt,
        updatedAt: goals.updatedAt,
        cursorTime: sql<string>`${goals.updatedAt}::text`,
      })
      .from(goals)
      .where(predicate ? and(eq(goals.companyId, companyId), predicate) : eq(goals.companyId, companyId))
      .orderBy(asc(goals.updatedAt), asc(goals.id))
      .limit(take),
    (r) => r.id,
  );
  const events: EvaluationEventInput[] = rows.map((r) => {
    const md = (r.metricDefinition ?? null) as Record<string, unknown> | null;
    const facts = {
      title: r.title,
      level: r.level,
      status: r.status,
      parentId: r.parentId,
      ownerAgentId: r.ownerAgentId,
      metricDefinition: md ? { target: md.target ?? null, unit: md.unit ?? null, source: md.source ?? null, baseline: md.baseline ?? null } : null,
    };
    const hash = hashCanonical(facts);
    return {
      companyId,
      projectId: null,
      goalId: r.id,
      actorType: "system",
      actorId: null,
      sourceTable: "goals",
      sourceId: r.id,
      sourceVersion: `${hash}:${r.cursorTime}`,
      sourceRowHash: hash,
      eventType: "goal.snapshot",
      eventTime: r.updatedAt,
      payload: { goalId: r.id, ...facts, createdAt: r.createdAt.toISOString() },
    };
  });
  return { events, scanned, nextCursor };
}

export const SOURCE_READERS = {
  agents: readAgentSnapshots,
  goals: readGoalSnapshots,
  projects: readProjectSnapshots,
  activity_log: readActivityLog,
  heartbeat_runs: readHeartbeatRuns,
  verdicts: readVerdicts,
  issue_thread_interactions: readInteractions,
  cost_events: readCostEvents,
  issue_comments: readCommentHandoffs,
  issues: readIssueSnapshots,
  issue_labels: readIssueLabels,
} as const;
export type SourceName = keyof typeof SOURCE_READERS;
