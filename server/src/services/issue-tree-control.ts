import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents, executionWorkspaces,
  companies,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  createIssueTreeHoldSchema, releaseIssueTreeHoldSchema,
  type CreateIssueTreeHold, type ReleaseIssueTreeHold,
  ISSUE_STATUSES,
  type IssueStatus,
  type IssueTreeControlMode,
  type IssueTreeControlPreview,
  type IssueTreeHold,
  type IssueTreeHoldMember,
  type IssueTreeHoldReleasePolicy,
  type IssueTreePreviewAgent,
  type IssueTreePreviewIssue,
  type IssueTreePreviewRun,
  type IssueTreePreviewWarning,
} from "@paperclipai/shared";
import { assertActivityAcceptance, type ActivityAcceptance } from "./activity-log.js";
import { insertActivity, publishActivity, logActivity, type ActivityPublication } from "./activity-log.js";
import type { issueTreeCurrentAuthority, TreeAuthorityTarget } from "./issue-current-authority.js";
import type { heartbeatService } from "./heartbeat.js";
import { conflict, notFound, unprocessable } from "../errors.js";

type IssueRow = typeof issues.$inferSelect;
type HoldRow = typeof issueTreeHolds.$inferSelect;
type HoldMemberRow = typeof issueTreeHoldMembers.$inferSelect;
export type ActiveIssueTreePauseHoldGate = {
  holdId: string;
  rootIssueId: string;
  issueId: string;
  isRoot: boolean;
  mode: "pause";
  reason: string | null;
  releasePolicy: IssueTreeHoldReleasePolicy | null;
};
type ActorInput = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};
type TreeIssue = IssueRow & { depth: number };
type ActiveRunRow = {
  id: string;
  issueId: string;
  agentId: string;
  status: "queued" | "running";
  startedAt: Date | null;
  createdAt: Date;
};
type ActiveCancelSnapshot = {
  holdIds: string[];
  member: IssueTreeHoldMember | null;
};
type TreeStatusUpdateResult = {
  updatedIssueIds: string[];
  updatedIssues: Array<{
    id: string;
    status: IssueStatus;
    assigneeAgentId: string | null;
  }>;
};
type RestoreTreeStatusResult = TreeStatusUpdateResult & {
  releasedCancelHoldIds: string[];
  restoreHold: IssueTreeHold | null;
};

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const DEFAULT_RELEASE_POLICY: IssueTreeHoldReleasePolicy = { strategy: "manual" };
const MAX_PAUSE_HOLD_ANCESTOR_DEPTH = 100;
export const ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_comment_mentioned",
] as const);
const ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES: Readonly<Record<string, ReadonlySet<string>>> = {
  issue_commented: new Set(["issue.comment"]),
  issue_reopened_via_comment: new Set(["issue.comment.reopen"]),
  issue_comment_mentioned: new Set(["comment.mention"]),
};

type VerifiedInteractionActor = {
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
};

function readNonEmptyStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readInteractionWakeCommentId(record: unknown) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>).wakeCommentIds;
  if (Array.isArray(value)) {
    const latest = value
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .at(-1);
    if (latest) return latest.trim();
  }
  return readNonEmptyStringFromRecord(record, "wakeCommentId") ?? readNonEmptyStringFromRecord(record, "commentId");
}

function hasVerifiedInteractionSource(wakeReason: string, contextSnapshot: Record<string, unknown>) {
  const source = readNonEmptyStringFromRecord(contextSnapshot, "source");
  if (!source) return false;
  return ISSUE_TREE_CONTROL_INTERACTION_WAKE_SOURCES[wakeReason]?.has(source) ?? false;
}

function actorMatchesComment(
  actor: VerifiedInteractionActor,
  comment: { authorAgentId: string | null; authorUserId: string | null },
) {
  if (!actor.requestedByActorType) return false;
  if (actor.requestedByActorType === "system") return true;
  if (!actor.requestedByActorId) return false;
  if (actor.requestedByActorType === "agent") return comment.authorAgentId === actor.requestedByActorId;
  if (actor.requestedByActorType === "user") return comment.authorUserId === actor.requestedByActorId;
  return false;
}

async function hasVerifiedInteractionWakeRequest(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId?: string | null;
    runId?: string | null;
    wakeupRequestId?: string | null;
    issueId: string;
    commentId: string;
    comment: { authorAgentId: string | null; authorUserId: string | null };
  },
) {
  if (!input.runId && !input.wakeupRequestId) return false;
  const predicates = [
    eq(agentWakeupRequests.companyId, input.companyId),
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload} ->> 'commentId' = ${input.commentId}`,
  ];
  if (input.agentId) predicates.push(eq(agentWakeupRequests.agentId, input.agentId));
  if (input.runId && input.wakeupRequestId) {
    const requestScope = or(
      eq(agentWakeupRequests.runId, input.runId),
      eq(agentWakeupRequests.id, input.wakeupRequestId),
    );
    if (requestScope) predicates.push(requestScope);
  } else if (input.runId) {
    predicates.push(eq(agentWakeupRequests.runId, input.runId));
  } else if (input.wakeupRequestId) {
    predicates.push(eq(agentWakeupRequests.id, input.wakeupRequestId));
  }

  const requests = await dbOrTx
    .select({
      requestedByActorType: agentWakeupRequests.requestedByActorType,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    })
    .from(agentWakeupRequests)
    .where(and(...predicates));

  return requests.some((request) => actorMatchesComment(request, input.comment));
}

export async function isVerifiedIssueTreeControlInteractionWake(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    agentId?: string | null;
    contextSnapshot: Record<string, unknown> | null | undefined;
    requestedByActorType?: "user" | "agent" | "system" | string | null;
    requestedByActorId?: string | null;
    runId?: string | null;
    wakeupRequestId?: string | null;
  },
) {
  const contextSnapshot = input.contextSnapshot ?? null;
  const wakeReason =
    readNonEmptyStringFromRecord(contextSnapshot, "wakeReason") ??
    readNonEmptyStringFromRecord(contextSnapshot, "reason");
  if (!wakeReason || !ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason)) return false;
  if (!contextSnapshot || !hasVerifiedInteractionSource(wakeReason, contextSnapshot)) return false;

  const commentId = readInteractionWakeCommentId(contextSnapshot);
  if (!commentId) return false;

  const comment = await dbOrTx
    .select({
      id: issueComments.id,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.id, commentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!comment) return false;

  const directActor = {
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId,
  };
  if (actorMatchesComment(directActor, comment)) return true;

  return hasVerifiedInteractionWakeRequest(dbOrTx, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    wakeupRequestId: input.wakeupRequestId,
    issueId: input.issueId,
    commentId,
    comment,
  });
}

function normalizeReleasePolicy(
  releasePolicy: IssueTreeHoldReleasePolicy | null | undefined,
): IssueTreeHoldReleasePolicy {
  return releasePolicy ?? DEFAULT_RELEASE_POLICY;
}

function coerceIssueStatus(status: string): IssueStatus {
  return ISSUE_STATUSES.includes(status as IssueStatus) ? (status as IssueStatus) : "backlog";
}

function isTerminalIssue(status: string): status is IssueStatus {
  return TERMINAL_ISSUE_STATUSES.has(coerceIssueStatus(status));
}

function toPreviewRun(row: ActiveRunRow): IssueTreePreviewRun {
  return {
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

function toHold(row: HoldRow, members?: HoldMemberRow[]): IssueTreeHold {
  return {
    id: row.id,
    companyId: row.companyId,
    rootIssueId: row.rootIssueId,
    mode: row.mode as IssueTreeControlMode,
    status: row.status as IssueTreeHold["status"],
    reason: row.reason,
    releasePolicy: (row.releasePolicy as IssueTreeHoldReleasePolicy | null) ?? null,
    createdByActorType: row.createdByActorType as IssueTreeHold["createdByActorType"],
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    releasedAt: row.releasedAt,
    releasedByActorType: row.releasedByActorType as IssueTreeHold["releasedByActorType"],
    releasedByAgentId: row.releasedByAgentId,
    releasedByUserId: row.releasedByUserId,
    releasedByRunId: row.releasedByRunId,
    releaseReason: row.releaseReason,
    releaseMetadata: row.releaseMetadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(members ? { members: members.map(toHoldMember) } : {}),
  };
}

function toHoldMember(row: HoldMemberRow): IssueTreeHoldMember {
  return {
    id: row.id,
    companyId: row.companyId,
    holdId: row.holdId,
    issueId: row.issueId,
    parentIssueId: row.parentIssueId,
    depth: row.depth,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    issueStatus: coerceIssueStatus(row.issueStatus),
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    activeRunId: row.activeRunId,
    activeRunStatus: row.activeRunStatus,
    skipped: row.skipped,
    skipReason: row.skipReason,
    createdAt: row.createdAt,
  };
}

function issueSkipReason(input: {
  mode: IssueTreeControlMode;
  issue: TreeIssue;
  activePauseHoldIds: string[];
  activeCancelSnapshot?: ActiveCancelSnapshot | null;
}): string | null {
  const status = coerceIssueStatus(input.issue.status);
  if (input.mode === "restore") {
    if (input.activeCancelSnapshot?.member && status !== "cancelled") {
      return "changed_after_cancel";
    }
    if (status !== "cancelled") return "not_cancelled";
    if (!input.activeCancelSnapshot?.member) return "not_cancelled_by_tree_control";
    const snapshotStatus = coerceIssueStatus(input.activeCancelSnapshot.member.issueStatus);
    return isTerminalIssue(snapshotStatus) ? "terminal_status" : null;
  }
  if (isTerminalIssue(status)) {
    return "terminal_status";
  }
  if (input.mode === "pause" && input.activePauseHoldIds.length > 0) {
    return "already_held";
  }
  if (input.mode === "resume" && input.activePauseHoldIds.length === 0) {
    return "not_held";
  }
  return null;
}

function buildAffectedAgents(issuesToPreview: IssueTreePreviewIssue[]): IssueTreePreviewAgent[] {
  const byAgentId = new Map<string, IssueTreePreviewAgent>();
  for (const issue of issuesToPreview) {
    if (issue.skipped) continue;
    const agentIds = new Set<string>();
    if (issue.assigneeAgentId) agentIds.add(issue.assigneeAgentId);
    if (issue.activeRun) agentIds.add(issue.activeRun.agentId);
    for (const agentId of agentIds) {
      const current = byAgentId.get(agentId) ?? { agentId, issueCount: 0, activeRunCount: 0 };
      current.issueCount += 1;
      if (issue.activeRun?.agentId === agentId) current.activeRunCount += 1;
      byAgentId.set(agentId, current);
    }
  }
  return [...byAgentId.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function buildWarnings(input: {
  mode: IssueTreeControlMode;
  issuesToPreview: IssueTreePreviewIssue[];
  activeRuns: IssueTreePreviewRun[];
}): IssueTreePreviewWarning[] {
  const affectedIssues = input.issuesToPreview.filter((issue) => !issue.skipped);
  const affectedIssueIds = new Set(affectedIssues.map((issue) => issue.id));
  const affectedRuns = input.activeRuns.filter((run) => affectedIssueIds.has(run.issueId));
  const warnings: IssueTreePreviewWarning[] = [];

  if (affectedIssues.length === 0) {
    warnings.push({
      code: "no_affected_issues",
      message: "No issues in this subtree match the requested control action.",
    });
  }

  const runningRunIssueIds = affectedRuns
    .filter((run) => run.status === "running")
    .map((run) => run.issueId);
  if ((input.mode === "pause" || input.mode === "cancel") && runningRunIssueIds.length > 0) {
    warnings.push({
      code: "running_runs_present",
      message: "Some affected issues have running heartbeat runs.",
      issueIds: [...new Set(runningRunIssueIds)].sort(),
    });
  }

  const queuedRunIssueIds = affectedRuns
    .filter((run) => run.status === "queued")
    .map((run) => run.issueId);
  if ((input.mode === "pause" || input.mode === "cancel") && queuedRunIssueIds.length > 0) {
    warnings.push({
      code: "queued_runs_present",
      message: "Some affected issues have queued heartbeat runs.",
      issueIds: [...new Set(queuedRunIssueIds)].sort(),
    });
  }

  if (input.mode === "resume" && affectedIssues.length === 0) {
    warnings.push({
      code: "no_active_pause_holds",
      message: "No active pause holds were found in this subtree.",
    });
  }

  if (input.mode === "restore") {
    const changedIssueIds = input.issuesToPreview
      .filter((issue) => issue.skipReason === "changed_after_cancel")
      .map((issue) => issue.id);
    if (changedIssueIds.length > 0) {
      warnings.push({
        code: "restore_conflicts_present",
        message: "Some issues changed after subtree cancellation and will be skipped.",
        issueIds: changedIssueIds,
      });
    }
  }

  return warnings;
}

function restoreStatusFromCancelSnapshot(status: IssueStatus): IssueStatus | null {
  if (status === "in_progress") return "todo";
  if (isTerminalIssue(status)) return null;
  return status;
}

type TreeReader = Pick<Db, "select">;
const uniqueIds = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((id): id is string => !!id))].sort();
const treeUnavailable = () => notFound("Issue tree source not found");

// ID-only legacy references are never company or project visibility grants.
async function validateSources(reader: TreeReader, companyId: string, current: IssueRow[],
  holds: HoldRow[] = [], members: HoldMemberRow[] = [], actor?: ActorInput) {
  const holdById = new Map(holds.map(hold => [hold.id, hold]));
  if (holds.some(hold => hold.companyId !== companyId) || members.some(member =>
    member.companyId !== companyId || holdById.get(member.holdId)?.companyId !== companyId)) throw treeUnavailable();
  const ids = uniqueIds([...current.map(row => row.id), ...current.map(row => row.parentId), ...holds.map(row => row.rootIssueId),
    ...members.flatMap(row => [row.issueId, row.parentIssueId])]);
  const sources = ids.length ? await reader.select().from(issues).where(inArray(issues.id, ids)) : [];
  if (sources.length !== ids.length || sources.some(row => row.companyId !== companyId)) throw treeUnavailable();
  const runIds = uniqueIds([...sources.flatMap(row => [row.executionRunId, row.checkoutRunId]), ...members.map(row => row.activeRunId),
    ...holds.flatMap(row => [row.createdByRunId, row.releasedByRunId]), actor?.runId]);
  const runs = runIds.length ? await reader.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds)) : [];
  if (runs.length !== runIds.length || runs.some(row => row.companyId !== companyId)) throw treeUnavailable();
  const contextIds = uniqueIds(runs.map(row => readNonEmptyStringFromRecord(row.contextSnapshot, "issueId")));
  const contextSources = contextIds.length ? await reader.select().from(issues).where(inArray(issues.id, contextIds)) : [];
  if (contextSources.length !== contextIds.length || contextSources.some(row => row.companyId !== companyId)) throw treeUnavailable();
  const agentIds = uniqueIds([...sources.map(row => row.assigneeAgentId), ...members.map(row => row.assigneeAgentId),
    ...holds.flatMap(row => [row.createdByAgentId, row.releasedByAgentId]), ...runs.map(row => row.agentId), actor?.agentId]);
  const agentRows = agentIds.length ? await reader.select().from(agents).where(inArray(agents.id, agentIds)) : [];
  if (agentRows.length !== agentIds.length || agentRows.some(row => row.companyId !== companyId)) throw treeUnavailable();
  return [...new Map([...sources, ...contextSources].map(row => [row.id, row])).values()].sort((a,b) => a.id.localeCompare(b.id));
}

type HoldCreateInput = {
  mode: IssueTreeControlMode;
  reason?: string | null;
  releasePolicy?: IssueTreeHoldReleasePolicy | null;
  actor: ActorInput;
};
type HoldReleaseInput = {
  reason?: string | null;
  releasePolicy?: IssueTreeHoldReleasePolicy | null;
  metadata?: Record<string, unknown> | null;
  actor: ActorInput;
};

// Shared synchronous payloads preserve the final authority → first write boundary.
function holdInsertValues(companyId: string, rootIssueId: string, input: HoldCreateInput): typeof issueTreeHolds.$inferInsert {
  return {
    companyId,
    rootIssueId,
    mode: input.mode,
    status: "active",
    reason: input.reason ?? null,
    releasePolicy: normalizeReleasePolicy(input.releasePolicy) as unknown as Record<string, unknown>,
    createdByActorType: input.actor.actorType,
    createdByAgentId: input.actor.agentId ?? null,
    createdByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
    createdByRunId: input.actor.runId ?? null,
  };
}

function memberInsertValues(companyId: string, holdId: string, projected: IssueTreePreviewIssue[]): Array<typeof issueTreeHoldMembers.$inferInsert> {
  return projected.map(issue => ({
    companyId,
    holdId,
    issueId: issue.id,
    parentIssueId: issue.parentId,
    depth: issue.depth,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueStatus: issue.status,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    activeRunId: issue.activeRun?.id ?? null,
    activeRunStatus: issue.activeRun?.status ?? null,
    skipped: issue.skipped,
    skipReason: issue.skipReason,
  }));
}

function holdReleaseValues(existingPolicy: HoldRow["releasePolicy"], input: HoldReleaseInput) {
  const now = new Date();
  return {
    status: "released",
    releasedAt: now,
    releasedByActorType: input.actor.actorType,
    releasedByAgentId: input.actor.agentId ?? null,
    releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
    releasedByRunId: input.actor.runId ?? null,
    releaseReason: input.reason ?? null,
    releasePolicy: input.releasePolicy
      ? normalizeReleasePolicy(input.releasePolicy) as unknown as Record<string, unknown>
      : existingPolicy,
    releaseMetadata: input.metadata ?? null,
    updatedAt: now,
  };
}

function unclaimedWakeupPredicate(companyId: string, issueIds: string[], requestIds?: string[]) {
  return and(
    eq(agentWakeupRequests.companyId, companyId),
    inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
    isNull(agentWakeupRequests.runId),
    inArray(sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`, issueIds),
    requestIds ? inArray(agentWakeupRequests.id, requestIds) : undefined,
  );
}

async function cancelExactUnclaimedWakeups(executor: Db, companyId: string, issueIds: string[], reason: string, requestIds?: string[]) {
  if (!issueIds.length || requestIds?.length === 0) return [];
  const now = new Date();
  return executor.update(agentWakeupRequests)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now, error: reason })
    .where(unclaimedWakeupPredicate(companyId, issueIds, requestIds))
    .returning({
      id: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      reason: agentWakeupRequests.reason,
      payload: agentWakeupRequests.payload,
    });
}

export type TreeActionContext = { companyId: string; rootIssueId: string; actor: ActorInput; authority: ReturnType<typeof issueTreeCurrentAuthority> };
export type TreeIntent = { kind: "create"; input: CreateIssueTreeHold } | { kind: "release"; holdId: string; input: ReleaseIssueTreeHold };
export type TreeActionPin = { version: 1; companyId: string; rootIssueId: string; intentDigest: string; stateDigest: string };
type CreateResult = { hold: IssueTreeHold; preview: IssueTreeControlPreview; resumedPauseHoldIds?: string[] };
export type TreeEffect = { kind: "cancelRun"; runId: string; issueId: string; holdId: string }
  | { kind: "wake"; agentId: string; issueId: string; holdId: string; options: Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1] };
export type AcceptedTreeAction = { kind: TreeIntent["kind"]; result: CreateResult | IssueTreeHold | { preview: IssueTreeControlPreview }; companyId: string; rootIssueId: string; actor: ActorInput;
  acceptedIssueIds: string[]; authorizedIssueIds: string[]; updatedIssueIds: string[]; releasedHoldIds: string[]; cancelledWakeupIds: string[]; effects: TreeEffect[] };
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const canonicalIntent = (intent: TreeIntent): TreeIntent => intent.kind === "create"
  ? { kind: "create", input: createIssueTreeHoldSchema.parse(intent.input) }
  : { kind: "release", holdId: intent.holdId, input: releaseIssueTreeHoldSchema.parse(intent.input) };

export function issueTreeControlService(db: Db) {
  async function accept<T>(companyId: string, supplied: ActivityAcceptance | undefined, work: (tx: Db, accepted: ActivityAcceptance) => Promise<T>) {
    const run = async (accepted: ActivityAcceptance) => {
      const tx = accepted.executor;
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
      return work(tx, accepted);
    };
    if (supplied !== undefined) { assertActivityAcceptance(supplied); return run(supplied); }
    const publications: ActivityPublication[] = [];
    let completed = false;
    let result: T;
    try { result = await db.transaction(async tx => { const value = await run({ executor: tx as unknown as Db, publications }); completed = true; return value; }); }
    catch (error) { if (completed) throw conflict("Issue tree acceptance acknowledgment is unknown; read current state", { persistenceOutcome: "unknown" }); throw error; }
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function listTreeIssues(companyId: string, rootIssueId: string): Promise<TreeIssue[]> {
    const root = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, rootIssueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!root) {
      throw notFound("Root issue not found");
    }

    const result: TreeIssue[] = [{ ...root, depth: 0 }];
    const visited = new Set<string>([root.id]);
    let frontier = [{ id: root.id, depth: 0 }];

    while (frontier.length > 0) {
      const parentIds = frontier.map((item) => item.id);
      const depthByParentId = new Map(frontier.map((item) => [item.id, item.depth]));
      const children = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, parentIds)))
        .orderBy(asc(issues.createdAt), asc(issues.id));

      const nextFrontier: typeof frontier = [];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        const depth = (depthByParentId.get(child.parentId ?? "") ?? 0) + 1;
        visited.add(child.id);
        result.push({ ...child, depth });
        nextFrontier.push({ id: child.id, depth });
      }
      frontier = nextFrontier;
    }

    return result;
  }

  async function activeRunsForTree(companyId: string, treeIssues: TreeIssue[]) {
    const issueIds = treeIssues.map((issue) => issue.id);
    if (issueIds.length === 0) return [];
    const runIds = treeIssues
      .map((issue) => issue.executionRunId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const uniqueRunIds = [...new Set(runIds)];
    const issueIdFromContext = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const issueIdSet = new Set(issueIds);

    const rows = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        issueIdFromContext,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
          uniqueRunIds.length > 0
            ? or(inArray(heartbeatRuns.id, uniqueRunIds), inArray(issueIdFromContext, issueIds))
            : inArray(issueIdFromContext, issueIds),
        ),
      );

    const issueIdByExecutionRunId = new Map(
      treeIssues
        .filter((issue) => issue.executionRunId)
        .map((issue) => [issue.executionRunId as string, issue.id]),
    );
    return rows
      .map((run) => {
        if (run.status !== "queued" && run.status !== "running") return null;
        const issueId = run.issueIdFromContext && issueIdSet.has(run.issueIdFromContext)
          ? run.issueIdFromContext
          : issueIdByExecutionRunId.get(run.id) ?? null;
        if (!issueId) return null;
        return {
          id: run.id,
          issueId,
          agentId: run.agentId,
          status: run.status,
          startedAt: run.startedAt,
          createdAt: run.createdAt,
        } satisfies ActiveRunRow;
      })
      .filter((run): run is ActiveRunRow => run !== null)
      .sort((a, b) => a.issueId.localeCompare(b.issueId) || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async function activeHoldsByIssueId(companyId: string, issueIds: string[]) {
    const byIssueId = new Map<string, { all: string[]; pause: string[] }>();
    if (issueIds.length === 0) return byIssueId;
    const rows = await db
      .select({
        issueId: issueTreeHoldMembers.issueId,
        holdId: issueTreeHolds.id,
        mode: issueTreeHolds.mode,
      })
      .from(issueTreeHoldMembers)
      .innerJoin(issueTreeHolds, eq(issueTreeHoldMembers.holdId, issueTreeHolds.id))
      .where(
        and(
          eq(issueTreeHoldMembers.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          inArray(issueTreeHoldMembers.issueId, issueIds),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));

    for (const row of rows) {
      const current = byIssueId.get(row.issueId) ?? { all: [], pause: [] };
      current.all.push(row.holdId);
      if (row.mode === "pause") current.pause.push(row.holdId);
      byIssueId.set(row.issueId, current);
    }
    return byIssueId;
  }

  async function activeCancelSnapshotsByIssueId(companyId: string, rootIssueId: string) {
    const activeCancelHolds = await listHolds(companyId, rootIssueId, {
      status: "active",
      mode: "cancel",
      includeMembers: true,
    });
    const byIssueId = new Map<string, ActiveCancelSnapshot>();
    for (const hold of [...activeCancelHolds].reverse()) {
      for (const member of hold.members ?? []) {
        const current = byIssueId.get(member.issueId) ?? { holdIds: [], member: null };
        if (!current.holdIds.includes(hold.id)) current.holdIds.push(hold.id);
        if (!current.member && !member.skipped) current.member = member;
        byIssueId.set(member.issueId, current);
      }
    }
    return byIssueId;
  }

  async function activePauseHoldsForIssueIds(companyId: string, issueIds: string[], connection: Db = db) {
    if (issueIds.length === 0) return [];
    return connection
      .select()
      .from(issueTreeHolds)
      .where(
        and(
          eq(issueTreeHolds.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
          inArray(issueTreeHolds.rootIssueId, issueIds),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
  }

  async function getActivePauseHoldGate(
    companyId: string,
    issueId: string,
    reader: Pick<Db, "select"> = db,
  ): Promise<ActiveIssueTreePauseHoldGate | null> {
    const activePauseHolds = await reader
      .select({
        id: issueTreeHolds.id,
        rootIssueId: issueTreeHolds.rootIssueId,
        reason: issueTreeHolds.reason,
        releasePolicy: issueTreeHolds.releasePolicy,
      })
      .from(issueTreeHolds)
      .where(
        and(
          eq(issueTreeHolds.companyId, companyId),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
        ),
      )
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (activePauseHolds.length === 0) return null;

    const holdByRootIssueId = new Map(activePauseHolds.map((hold) => [hold.rootIssueId, hold]));
    let currentIssueId: string | null = issueId;
    const visited = new Set<string>();

    while (
      currentIssueId
      && !visited.has(currentIssueId)
      && visited.size < MAX_PAUSE_HOLD_ANCESTOR_DEPTH
    ) {
      visited.add(currentIssueId);
      const parent: { parentId: string | null } | null = await reader
        .select({ parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      const hold = holdByRootIssueId.get(currentIssueId);
      if (hold) {
        if (!parent) throw treeUnavailable();
        return {
          holdId: hold.id,
          rootIssueId: hold.rootIssueId,
          issueId,
          isRoot: hold.rootIssueId === issueId,
          mode: "pause",
          reason: hold.reason,
          releasePolicy: (hold.releasePolicy as IssueTreeHoldReleasePolicy | null) ?? null,
        };
      }

      currentIssueId = parent?.parentId ?? null;
    }

    return null;
  }

  async function preview(
    companyId: string,
    rootIssueId: string,
    input: {
      mode: IssueTreeControlMode;
      releasePolicy?: IssueTreeHoldReleasePolicy | null;
    },
  ): Promise<IssueTreeControlPreview> {
    const treeIssues = await listTreeIssues(companyId, rootIssueId);
    const issueIds = treeIssues.map((issue) => issue.id);
    const [activeRunRows, holdsByIssueId, activeCancelSnapshots] = await Promise.all([
      activeRunsForTree(companyId, treeIssues),
      activeHoldsByIssueId(companyId, issueIds),
      input.mode === "restore"
        ? activeCancelSnapshotsByIssueId(companyId, rootIssueId)
        : Promise.resolve(new Map<string, ActiveCancelSnapshot>()),
    ]);
    await historySources(db, companyId, treeIssues, uniqueIds([...holdsByIssueId.values()].flatMap(value => value.all)));
    for (const run of activeRunRows) await validateSources(db, companyId, [], [], [], { actorType: 'system', actorId: 'system', runId: run.id, agentId: run.agentId });
    const runsByIssueId = new Map<string, ActiveRunRow>();
    for (const run of activeRunRows) {
      if (!runsByIssueId.has(run.issueId)) runsByIssueId.set(run.issueId, run);
    }
    const countsByStatus: Partial<Record<IssueStatus, number>> = {};

    const issuesToPreview = treeIssues.map((issue) => {
      const status = coerceIssueStatus(issue.status);
      countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;
      const holdState = holdsByIssueId.get(issue.id) ?? { all: [], pause: [] };
      const skipReason = issueSkipReason({
        mode: input.mode,
        issue,
        activePauseHoldIds: holdState.pause,
        activeCancelSnapshot: activeCancelSnapshots.get(issue.id) ?? null,
      });
      const run = runsByIssueId.get(issue.id);
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status,
        parentId: issue.parentId,
        depth: issue.depth,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        activeRun: run ? toPreviewRun(run) : null,
        activeHoldIds: holdState.all,
        action: input.mode,
        skipped: skipReason !== null,
        skipReason,
      } satisfies IssueTreePreviewIssue;
    });
    const skippedIssues = issuesToPreview.filter((issue) => issue.skipped);
    const activeRuns = activeRunRows
      .map(toPreviewRun)
      .sort((a, b) => a.issueId.localeCompare(b.issueId) || a.id.localeCompare(b.id));
    const affectedAgents = buildAffectedAgents(issuesToPreview);

    return {
      companyId,
      rootIssueId,
      mode: input.mode,
      generatedAt: new Date(),
      releasePolicy: normalizeReleasePolicy(input.releasePolicy),
      totals: {
        totalIssues: issuesToPreview.length,
        affectedIssues: issuesToPreview.length - skippedIssues.length,
        skippedIssues: skippedIssues.length,
        activeRuns: activeRuns.filter((run) => run.status === "running").length,
        queuedRuns: activeRuns.filter((run) => run.status === "queued").length,
        affectedAgents: affectedAgents.length,
      },
      countsByStatus,
      issues: issuesToPreview,
      skippedIssues,
      activeRuns,
      affectedAgents,
      warnings: buildWarnings({ mode: input.mode, issuesToPreview, activeRuns }),
    };
  }

  async function createHold(
    companyId: string,
    rootIssueId: string,
    input: HoldCreateInput,
    acceptance?: ActivityAcceptance,
  ): Promise<CreateResult> {
    return accept(companyId, acceptance, async (tx, accepted) => {
      const reader = issueTreeControlService(tx);
      const holdReleasePolicy = normalizeReleasePolicy(input.releasePolicy);
      const holdPreview = await reader.preview(companyId, rootIssueId, {
        mode: input.mode,
        releasePolicy: holdReleasePolicy,
      });
      await validateSources(tx, companyId, await reader.listTreeIssues(companyId, rootIssueId), [], [], input.actor);
      const activePauseHolds = input.mode === "resume"
        ? await activePauseHoldsForIssueIds(companyId, uniqueIds(holdPreview.issues.map(issue => issue.id)), tx)
        : [];
      for (const hold of activePauseHolds) await getHold(companyId, hold.id, tx);

      const [createdHold] = await tx.insert(issueTreeHolds)
        .values(holdInsertValues(companyId, rootIssueId, input)).returning();
      const memberRows = memberInsertValues(companyId, createdHold.id, holdPreview.issues);
      const createdMembers = memberRows.length
        ? await tx.insert(issueTreeHoldMembers).values(memberRows).returning()
        : [];
      const hold = toHold(createdHold, createdMembers);
      if (input.mode !== "resume") return { hold, preview: holdPreview };

      const releaseReason = input.reason ?? "Subtree resume applied.";
      const resumedPauseHoldIds = activePauseHolds.map(selected => selected.id);
      await Promise.all(activePauseHolds.map(selected =>
        releaseHold(companyId, selected.rootIssueId, selected.id, {
          reason: releaseReason,
          metadata: {
            resumedByResumeHoldId: hold.id,
            resumeHoldMode: "tree_resume",
            resumedPauseHoldId: selected.id,
          },
          actor: input.actor,
        }, accepted),
      ));
      const releasedResumeHold = await releaseHold(companyId, rootIssueId, hold.id, {
        reason: releaseReason,
        metadata: {
          resumedPauseHoldIds,
          resumeMode: "subtree",
          ...(input.releasePolicy ? { releasePolicy: holdReleasePolicy } : {}),
        },
        actor: input.actor,
      }, accepted);
      return { hold: releasedResumeHold, preview: holdPreview, resumedPauseHoldIds };
    });
  }

  async function cancelIssueStatusesForHold(
    companyId: string,
    rootIssueId: string,
    holdId: string,
    acceptance?: ActivityAcceptance,
  ): Promise<TreeStatusUpdateResult> {
    return accept(companyId, acceptance, async tx => {
      const hold = await getHold(companyId, holdId, tx);
      if (!hold) throw notFound("Issue tree hold not found");
      if (hold.rootIssueId !== rootIssueId) {
        throw unprocessable("Issue tree hold does not belong to the requested root issue");
      }
      if (hold.mode !== "cancel") {
        throw unprocessable("Issue tree hold is not a cancel operation");
      }

      const issueIds = [...new Set((hold.members ?? [])
        .filter((member) => !member.skipped)
        .map((member) => member.issueId))];
      if (issueIds.length === 0) return { updatedIssueIds: [], updatedIssues: [] };

      const now = new Date();
      const updated = await tx
        .update(issues)
        .set({
          status: "cancelled",
          cancelledAt: now,
          completedAt: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.id, issueIds),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        )
        .returning({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        });

      return {
        updatedIssueIds: updated.map((issue) => issue.id),
        updatedIssues: updated.map((issue) => ({
          id: issue.id,
          status: coerceIssueStatus(issue.status),
          assigneeAgentId: issue.assigneeAgentId,
        })),
      };
    });
  }

  async function restoreIssueStatusesForHold(
    companyId: string,
    rootIssueId: string,
    restoreHoldId: string,
    input: {
      reason?: string | null;
      actor: ActorInput;
    },
    acceptance?: ActivityAcceptance,
  ): Promise<RestoreTreeStatusResult> {
    return accept(companyId, acceptance, async tx => {
      const reader = issueTreeControlService(tx as unknown as Db);
      const restoreHold = await getHold(companyId, restoreHoldId, tx as unknown as Db);
      if (!restoreHold) throw notFound("Issue tree hold not found");
      await validateSources(tx, companyId, [], [], [], input.actor);
      if (restoreHold.rootIssueId !== rootIssueId) {
        throw unprocessable("Issue tree hold does not belong to the requested root issue");
      }
      if (restoreHold.mode !== "restore") {
        throw unprocessable("Issue tree hold is not a restore operation");
      }

      const activeCancelHolds = await reader.listHolds(companyId, rootIssueId, {
        status: "active",
        mode: "cancel",
        includeMembers: true,
      });
      const cancelSnapshotByIssueId = new Map<string, IssueTreeHoldMember>();
      for (const hold of [...activeCancelHolds].reverse()) {
        for (const member of hold.members ?? []) {
          if (!member.skipped && !cancelSnapshotByIssueId.has(member.issueId)) {
            cancelSnapshotByIssueId.set(member.issueId, member);
          }
        }
      }

      const restoreIssueIds = [...new Set((restoreHold.members ?? [])
        .filter((member) => !member.skipped)
        .map((member) => member.issueId))];
      if (restoreIssueIds.length) await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, restoreIssueIds))).orderBy(asc(issues.id)).for("update");
      const restoreStatusByIssueId = new Map<string, IssueStatus>();
      for (const issueId of restoreIssueIds) {
        const snapshot = cancelSnapshotByIssueId.get(issueId);
        if (!snapshot) continue;
        const restoredStatus = restoreStatusFromCancelSnapshot(coerceIssueStatus(snapshot.issueStatus));
        if (restoredStatus) restoreStatusByIssueId.set(issueId, restoredStatus);
      }

      const issueIdsByStatus = new Map<IssueStatus, string[]>();
      for (const [issueId, status] of restoreStatusByIssueId) {
        const current = issueIdsByStatus.get(status) ?? [];
        current.push(issueId);
        issueIdsByStatus.set(status, current);
      }

      const now = new Date();
      const releasedCancelHoldIds = activeCancelHolds.map((hold) => hold.id);
      const restored: TreeStatusUpdateResult["updatedIssues"] = [];
      for (const [status, issueIdsForStatus] of issueIdsByStatus) {
        if (issueIdsForStatus.length === 0) continue;
        const rows = await tx
          .update(issues)
          .set({
            status,
            cancelledAt: null,
            completedAt: null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.id, issueIdsForStatus),
              eq(issues.status, "cancelled"),
            ),
          )
          .returning({
            id: issues.id,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          });
        restored.push(...rows.map((issue) => ({
          id: issue.id,
          status: coerceIssueStatus(issue.status),
          assigneeAgentId: issue.assigneeAgentId,
        })));
      }

      if (releasedCancelHoldIds.length > 0) {
        await tx
          .update(issueTreeHolds)
          .set({
            status: "released",
            releasedAt: now,
            releasedByActorType: input.actor.actorType,
            releasedByAgentId: input.actor.agentId ?? null,
            releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
            releasedByRunId: input.actor.runId ?? null,
            releaseReason: input.reason ?? "Restored by subtree restore operation",
            releaseMetadata: {
              restoreHoldId,
              restoredIssueIds: restored.map((issue) => issue.id),
            },
            updatedAt: now,
          })
          .where(and(eq(issueTreeHolds.companyId, companyId), inArray(issueTreeHolds.id, releasedCancelHoldIds)));
      }

      await tx
        .update(issueTreeHolds)
        .set({
          status: "released",
          releasedAt: now,
          releasedByActorType: input.actor.actorType,
          releasedByAgentId: input.actor.agentId ?? null,
          releasedByUserId: input.actor.userId ?? (input.actor.actorType === "user" ? input.actor.actorId : null),
          releasedByRunId: input.actor.runId ?? null,
          releaseReason: input.reason ?? "Restore operation applied",
          releaseMetadata: {
            restoredIssueIds: restored.map((issue) => issue.id),
            releasedCancelHoldIds,
          },
          updatedAt: now,
        })
        .where(and(eq(issueTreeHolds.companyId, companyId), eq(issueTreeHolds.id, restoreHoldId)));


      return {
        updatedIssueIds: restored.map((issue) => issue.id),
        updatedIssues: restored,
        releasedCancelHoldIds,
        restoreHold: await getHold(companyId, restoreHoldId, tx as unknown as Db),
      };
    });
  }

  async function getHold(companyId: string, holdId: string, connection: Pick<Db, "select"> = db) {
    const hold = await connection
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!hold) return null;
    const members = await connection
      .select()
      .from(issueTreeHoldMembers)
      .where(eq(issueTreeHoldMembers.holdId, holdId))
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));
    await validateSources(connection, companyId, [], [hold], members);
    return toHold(hold, members);
  }

  async function listHolds(
    companyId: string,
    rootIssueId: string,
    input?: {
      status?: IssueTreeHold["status"];
      mode?: IssueTreeControlMode;
      includeMembers?: boolean;
    },
  ) {
    const whereClauses = [
      eq(issueTreeHolds.companyId, companyId),
      eq(issueTreeHolds.rootIssueId, rootIssueId),
    ];
    if (input?.status) whereClauses.push(eq(issueTreeHolds.status, input.status));
    if (input?.mode) whereClauses.push(eq(issueTreeHolds.mode, input.mode));

    const holds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(...whereClauses))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    if (holds.length === 0) return [];

    const holdIds = holds.map((hold) => hold.id);
    const members = await db
      .select()
      .from(issueTreeHoldMembers)
      .where(inArray(issueTreeHoldMembers.holdId, holdIds))
      .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));

    await validateSources(db, companyId, [], holds, members);
    const membersByHoldId = new Map<string, HoldMemberRow[]>();
    for (const member of members) {
      const existing = membersByHoldId.get(member.holdId) ?? [];
      existing.push(member);
      membersByHoldId.set(member.holdId, existing);
    }

    return holds.map((hold) => toHold(hold, input?.includeMembers ? membersByHoldId.get(hold.id) ?? [] : undefined));
  }

  async function releaseHold(
    companyId: string,
    rootIssueId: string,
    holdId: string,
    input: HoldReleaseInput,
    acceptance?: ActivityAcceptance,
  ) {
    return accept(companyId, acceptance, async tx => {
      const existing = await tx
        .select()
        .from(issueTreeHolds)
        .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Issue tree hold not found");
      if (existing.rootIssueId !== rootIssueId) {
        throw unprocessable("Issue tree hold does not belong to the requested root issue");
      }
      await getHold(companyId, holdId, tx);
      await validateSources(tx, companyId, [], [], [], input.actor);
      if (existing.status === "released") {
        throw conflict("Issue tree hold is already released");
      }

      const [updated] = await tx
        .update(issueTreeHolds)
        .set(holdReleaseValues(existing.releasePolicy, input))
        .where(and(eq(issueTreeHolds.id, holdId), eq(issueTreeHolds.companyId, companyId)))
        .returning();

      const members = await tx
        .select()
        .from(issueTreeHoldMembers)
        .where(eq(issueTreeHoldMembers.holdId, holdId))
        .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt), asc(issueTreeHoldMembers.issueId));

      return toHold(updated, members);
    });
  }

  async function cancelUnclaimedWakeupsForTree(companyId: string, rootIssueId: string, reason: string, acceptance?: ActivityAcceptance, exactIssueIds?: string[]) {
    return accept(companyId, acceptance, async tx => {
      const issueIds = exactIssueIds ?? (await issueTreeControlService(tx).listTreeIssues(companyId, rootIssueId)).map(issue => issue.id);
      return cancelExactUnclaimedWakeups(tx, companyId, issueIds, reason);
    });
  }

  async function historySources(reader: TreeReader, companyId: string, current: IssueRow[], holdIds: string[]) {
    const holds = holdIds.length ? await reader.select().from(issueTreeHolds).where(inArray(issueTreeHolds.id, uniqueIds(holdIds))).orderBy(asc(issueTreeHolds.id)) : [];
    if (holds.length !== uniqueIds(holdIds).length) throw treeUnavailable();
    const members = holds.length ? await reader.select().from(issueTreeHoldMembers).where(inArray(issueTreeHoldMembers.holdId, holds.map(row => row.id))).orderBy(asc(issueTreeHoldMembers.id)) : [];
    const sources = await validateSources(reader, companyId, current, holds, members);
    return { holds, members, sources };
  }

  async function actionSnapshot(context: TreeActionContext, intent: TreeIntent, reader: TreeReader) {
    // The bound reader is SELECT-only; no helper here can initialize, expire or audit.
    const view = issueTreeControlService(reader as Db);
    const tree = await view.listTreeIssues(context.companyId, context.rootIssueId);
    const preview = await view.preview(context.companyId, context.rootIssueId, intent.kind === 'create' ? intent.input : { mode: 'resume' });
    let selected: HoldRow[] = [];
    if (intent.kind === 'release') {
      selected = await reader.select().from(issueTreeHolds).where(and(eq(issueTreeHolds.id, intent.holdId), eq(issueTreeHolds.companyId, context.companyId), eq(issueTreeHolds.rootIssueId, context.rootIssueId)));
      if (!selected.length) throw notFound('Issue tree hold not found');
      if (selected[0].status !== 'active') throw conflict('Issue tree hold is already released');
    } else if (intent.input.mode === 'resume') {
      selected = await activePauseHoldsForIssueIds(context.companyId, tree.map(row => row.id), reader as Db);
    } else if (intent.input.mode === 'restore') {
      selected = await reader.select().from(issueTreeHolds).where(and(eq(issueTreeHolds.companyId, context.companyId), eq(issueTreeHolds.rootIssueId, context.rootIssueId), eq(issueTreeHolds.mode, 'cancel'), eq(issueTreeHolds.status, 'active'))).orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    }
    const history = await historySources(reader, context.companyId, tree, uniqueIds([...selected.map(row => row.id), ...preview.issues.flatMap(row => row.activeHoldIds)]));
    const runIds = uniqueIds([...preview.activeRuns.map(row => row.id), ...history.sources.flatMap(row => [row.executionRunId, row.checkoutRunId]),
      ...history.members.map(row => row.activeRunId), ...history.holds.flatMap(row => [row.createdByRunId, row.releasedByRunId]), context.actor.runId]);
    const runs = runIds.length ? await reader.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds)).orderBy(asc(heartbeatRuns.id)) : [];
    const queue = await reader.select().from(agentWakeupRequests)
      .where(unclaimedWakeupPredicate(context.companyId, tree.map(row => row.id)))
      .orderBy(asc(agentWakeupRequests.id));
    const runSources = await validateSources(reader, context.companyId, history.sources, [], [], context.actor);
    const runContextIds = uniqueIds(runs.map(row => readNonEmptyStringFromRecord(row.contextSnapshot, 'issueId')));
    const runContextSources = runContextIds.length ? await reader.select().from(issues).where(inArray(issues.id, runContextIds)) : [];
    if (runContextSources.length !== runContextIds.length || runContextSources.some(row => row.companyId !== context.companyId) || runs.some(row => row.companyId !== context.companyId)) throw treeUnavailable();
    const agentIds = uniqueIds([...runs.map(row => row.agentId), ...queue.map(row => row.agentId)]);
    const agentRows = agentIds.length ? await reader.select().from(agents).where(inArray(agents.id, agentIds)) : [];
    if (agentRows.length !== agentIds.length || agentRows.some(row => row.companyId !== context.companyId)) throw treeUnavailable();
    const sources = [...new Map([...history.sources, ...runSources, ...runContextSources].map(row => [row.id,row])).values()].sort((a,b) => a.id.localeCompare(b.id));
    const workspaceIds = uniqueIds(sources.map(row => row.executionWorkspaceId));
    const workspaces = workspaceIds.length ? await reader.select().from(executionWorkspaces).where(inArray(executionWorkspaces.id, workspaceIds)).orderBy(asc(executionWorkspaces.id)) : [];
    if (workspaces.length !== workspaceIds.length || workspaces.some(row => row.companyId !== context.companyId)) throw treeUnavailable();
    const decisions = new Map(preview.issues.map(row => [row.id, row]));
    const restoreSnapshots = new Map<string, HoldMemberRow>();
    for (const hold of [...selected].reverse()) for (const member of history.members) {
      if (member.holdId === hold.id && !member.skipped && !restoreSnapshots.has(member.issueId)) restoreSnapshots.set(member.issueId, member);
    }
    const targets: TreeAuthorityTarget[] = sources.map(issue => {
      const decision = decisions.get(issue.id);
      let status: IssueStatus | null = null;
      if (intent.kind === 'create' && decision && !decision.skipped) {
        if (intent.input.mode === 'cancel') status = 'cancelled';
        if (intent.input.mode === 'restore' && issue.status === 'cancelled') {
          const snapshot = restoreSnapshots.get(issue.id);
          if (snapshot) status = restoreStatusFromCancelSnapshot(coerceIssueStatus(snapshot.issueStatus));
        }
      }
      return { issue, effectivePatch: status ? { status, checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null } : {} };
    });
    // References require positive witnesses, never a synthetic reassignment.
    const allAgentIds = uniqueIds([...agentIds, ...history.members.map(row => row.assigneeAgentId), ...history.holds.flatMap(row => [row.createdByAgentId, row.releasedByAgentId]), context.actor.agentId]);
    targets.find(target => target.issue.id === context.rootIssueId)!.referencedAgentIds = allAgentIds;
    const state = {
      tree: tree.map(row => [row.id,row.parentId,row.depth]).sort(),
      sources: sources.map(row => ({ id: row.id, companyId: row.companyId, parentId: row.parentId, projectId: row.projectId, goalId: row.goalId,
        projectWorkspaceId: row.projectWorkspaceId, executionWorkspaceId: row.executionWorkspaceId, executionWorkspaceSettings: row.executionWorkspaceSettings,
        title: row.title, identifier: row.identifier, status: row.status, assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId,
        checkoutRunId: row.checkoutRunId, executionRunId: row.executionRunId, executionAgentNameKey: row.executionAgentNameKey, executionLockedAt: row.executionLockedAt })),
      workspaces: workspaces.map(row => ({ id: row.id, companyId: row.companyId, projectId: row.projectId, sourceIssueId: row.sourceIssueId, status: row.status, metadata: row.metadata })),
      selected: selected.map(row => row.id),
      holds: history.holds.map(({ updatedAt: _updated, ...row }) => row),
      members: history.members,
      decisions: preview.issues.map(row => ({ id: row.id, skipped: row.skipped, skipReason: row.skipReason, activeHoldIds: row.activeHoldIds })),
      runs: runs.map(row => ({ id: row.id, companyId: row.companyId, agentId: row.agentId, status: row.status, startedAt: row.startedAt, createdAt: row.createdAt, contextSnapshot: row.contextSnapshot, wakeupRequestId: row.wakeupRequestId })),
      queue: queue.map(row => ({ id: row.id, companyId: row.companyId, agentId: row.agentId, status: row.status, runId: row.runId, reason: row.reason, payload: row.payload })),
    };
    return { tree, preview, selected, ...history, sources, targets, runs, queue, state };
  }

  async function planAction(context: TreeActionContext, rawIntent: TreeIntent, reader: TreeReader = db) {
    const intent = canonicalIntent(rawIntent), snapshot = await actionSnapshot(context, intent, reader);
    await context.authority.read(reader, snapshot.targets);
    const pin: TreeActionPin = { version: 1, companyId: context.companyId, rootIssueId: context.rootIssueId, intentDigest: digest(intent), stateDigest: digest(snapshot.state) };
    return { pin, safeReadback: snapshot.preview };
  }

  // SELECT-only authority for the sources read now. Serialization of a separate
  // earlier projection must use readAction or retain its own company coordination.
  async function authorizeRead(context: TreeActionContext, holdIds: string[] = [], reader: TreeReader = db) {
    const view = issueTreeControlService(reader as Db);
    const tree = await view.listTreeIssues(context.companyId, context.rootIssueId);
    const history = await historySources(reader, context.companyId, tree, holdIds);
    await context.authority.read(reader, history.sources.map(issue => ({ issue, effectivePatch: {} })));
  }

  // Canonical readback projects and authorizes from one consistent snapshot
  // (REPEATABLE READ, read only). Reads take no row locks (#881 review P2):
  // the checked source union and the returned projection come from the same
  // snapshot, so a concurrent writer cannot make them disagree.
  async function readAction(context: TreeActionContext, selection:
    | { kind: "state" }
    | { kind: "detail"; holdId: string }
    | { kind: "list"; status?: IssueTreeHold["status"]; mode?: IssueTreeControlMode; includeMembers?: boolean }) {
    return db.transaction(async tx => {
      const reader = issueTreeControlService(tx as unknown as Db);
      if (selection.kind === "state") {
        const activePauseHold = await reader.getActivePauseHoldGate(context.companyId, context.rootIssueId);
        await authorizeRead(context, activePauseHold ? [activePauseHold.holdId] : [], tx);
        return { activePauseHold };
      }
      if (selection.kind === "detail") {
        const hold = await reader.getHold(context.companyId, selection.holdId);
        if (!hold || hold.rootIssueId !== context.rootIssueId) throw notFound("Issue tree hold not found");
        await authorizeRead(context, [hold.id], tx);
        return hold;
      }
      const holds = await reader.listHolds(context.companyId, context.rootIssueId, selection);
      await authorizeRead(context, holds.map(hold => hold.id), tx);
      return holds;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function acceptAction(context: TreeActionContext, rawIntent: TreeIntent,
    options: { expected?: TreeActionPin; acceptance?: ActivityAcceptance; previewOnly?: boolean } = {}): Promise<AcceptedTreeAction> {
    const intent = canonicalIntent(rawIntent);
    let acceptedResult: AcceptedTreeAction | undefined;
    const work = async (accepted: ActivityAcceptance) => {
      assertActivityAcceptance(accepted);
      const tx = accepted.executor;
      if (typeof tx.execute !== 'function') throw new TypeError('Tree acceptance requires an actual SQL executor');
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, context.companyId)).for("no key update");
      const initial = await actionSnapshot(context, intent, tx);
      const authority = await context.authority.stage(tx, initial.targets);
      // Fixed order: complete positive witness union, sorted issue union, exact
      // active runs, selected/projected holds, their members, eligible queue rows.
      await tx.select({ id: issues.id }).from(issues).where(inArray(issues.id, initial.sources.map(row => row.id))).orderBy(asc(issues.id)).for('update');
      if (initial.runs.length) await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.id, initial.runs.map(row => row.id))).orderBy(asc(heartbeatRuns.id)).for('update');
      if (initial.holds.length) await tx.select({ id: issueTreeHolds.id }).from(issueTreeHolds).where(inArray(issueTreeHolds.id, initial.holds.map(row => row.id))).orderBy(asc(issueTreeHolds.id)).for('update');
      if (initial.members.length) await tx.select({ id: issueTreeHoldMembers.id }).from(issueTreeHoldMembers).where(inArray(issueTreeHoldMembers.id, initial.members.map(row => row.id))).orderBy(asc(issueTreeHoldMembers.id)).for('update');
      if (initial.queue.length) await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, initial.queue.map(row => row.id))).orderBy(asc(agentWakeupRequests.id)).for('update');
      const current = await actionSnapshot(context, intent, tx);
      if (digest(initial.state) !== digest(current.state)) throw conflict('Issue tree changed during acceptance');
      const pin: TreeActionPin = { version: 1, companyId: context.companyId, rootIssueId: context.rootIssueId, intentDigest: digest(intent), stateDigest: digest(current.state) };
      if (options.expected && digest(options.expected) !== digest(pin)) throw conflict('Issue tree changed since preparation');
      const audit = async (action: string, details: Record<string, unknown>, entityType = 'issue', entityId = context.rootIssueId) => {
        accepted.publications.push(await insertActivity(tx, { companyId: context.companyId, ...context.actor, action, entityType, entityId, details }, options.previewOnly ? authority.checkTime : undefined));
      };
      const result: AcceptedTreeAction = { kind: intent.kind, result: {} as IssueTreeHold, companyId: context.companyId, rootIssueId: context.rootIssueId, actor: context.actor,
        acceptedIssueIds: current.tree.map(row => row.id), authorizedIssueIds: current.sources.map(row => row.id), updatedIssueIds: [], releasedHoldIds: [], cancelledWakeupIds: [], effects: [] };
      await authority.beforeWrite(current.targets);
      authority.checkTime();
      // Nothing asynchronous may intervene between the final time/lease check
      // above and the first write below (including another helper's reads).
      if (options.previewOnly) {
        await audit('issue.tree_control_previewed', { mode: current.preview.mode, totals: current.preview.totals, warningCodes: current.preview.warnings.map(row => row.code) });
        result.result = { preview: current.preview };
      } else if (intent.kind === 'release') {
        const [released] = await tx.update(issueTreeHolds)
          .set(holdReleaseValues(current.selected[0].releasePolicy, { ...intent.input, actor: context.actor }))
          .where(eq(issueTreeHolds.id, intent.holdId)).returning();
        result.result = toHold(released, current.members.filter(row => row.holdId === released.id)); result.releasedHoldIds = [released.id];
        await audit('issue.tree_hold_released', { holdId: released.id, mode: released.mode, reason: released.releaseReason, memberCount: (result.result as IssueTreeHold).members?.length ?? 0 });
      } else {
        const [hold] = await tx.insert(issueTreeHolds)
          .values(holdInsertValues(context.companyId, context.rootIssueId, { ...intent.input, actor: context.actor })).returning();
        const members = await tx.insert(issueTreeHoldMembers)
          .values(memberInsertValues(context.companyId, hold.id, current.preview.issues)).returning();
        let projectedHold = toHold(hold, members);
        await audit('issue.tree_hold_created', { holdId: hold.id, mode: hold.mode, reason: hold.reason, totals: current.preview.totals, warningCodes: current.preview.warnings.map(row => row.code) });
        if (hold.mode === 'pause' || hold.mode === 'cancel') {
          result.effects = current.preview.activeRuns.map(run => ({ kind: 'cancelRun', runId: run.id, issueId: run.issueId, holdId: hold.id }));
          if (current.queue.length) {
            const reason = hold.mode === "pause"
              ? "Cancelled because an active subtree pause hold was created"
              : "Cancelled because a subtree cancel operation was applied";
            const matched = await cancelExactUnclaimedWakeups(
              tx, context.companyId, result.acceptedIssueIds, reason, current.queue.map(row => row.id),
            );
            result.cancelledWakeupIds = matched.map(row => row.id);
            for (const row of matched) await audit('issue.tree_hold_wakeup_deferred', { holdId: hold.id, rootIssueId: context.rootIssueId, agentId: row.agentId, previousReason: row.reason }, 'agent_wakeup_request', row.id);
          }
        }
        if (hold.mode === 'cancel') {
          const changed = await cancelIssueStatusesForHold(context.companyId, context.rootIssueId, hold.id, accepted);
          result.updatedIssueIds = changed.updatedIssueIds;
          await audit('issue.tree_cancel_status_updated', { holdId: hold.id, cancelledIssueIds: changed.updatedIssueIds, cancelledIssueCount: changed.updatedIssueIds.length });
        } else if (hold.mode === 'resume') {
          const reason = intent.input.reason ?? 'Subtree resume applied.';
          for (const selected of current.selected) await releaseHold(context.companyId, selected.rootIssueId, selected.id, { reason, metadata: { resumedByResumeHoldId: hold.id, resumeHoldMode: 'tree_resume', resumedPauseHoldId: selected.id }, actor: context.actor }, accepted);
          result.releasedHoldIds = current.selected.map(row => row.id);
          projectedHold = await releaseHold(context.companyId, context.rootIssueId, hold.id, { reason, metadata: { resumedPauseHoldIds: result.releasedHoldIds, resumeMode: 'subtree', ...(intent.input.releasePolicy ? { releasePolicy: normalizeReleasePolicy(intent.input.releasePolicy) } : {}) }, actor: context.actor }, accepted);
          result.releasedHoldIds.push(hold.id);
        } else if (hold.mode === 'restore') {
          const changed = await restoreIssueStatusesForHold(context.companyId, context.rootIssueId, hold.id, { reason: hold.reason, actor: context.actor }, accepted);
          result.updatedIssueIds = changed.updatedIssueIds; result.releasedHoldIds = [...changed.releasedCancelHoldIds, hold.id]; projectedHold = changed.restoreHold!;
          await audit('issue.tree_restore_status_updated', { holdId: hold.id, restoredIssueIds: changed.updatedIssueIds, restoredIssueCount: changed.updatedIssueIds.length, releasedCancelHoldIds: changed.releasedCancelHoldIds });
          if (intent.input.metadata?.wakeAgents === true) for (const issue of changed.updatedIssues) if (issue.assigneeAgentId) result.effects.push({ kind: 'wake', agentId: issue.assigneeAgentId, issueId: issue.id, holdId: hold.id,
            options: { source: 'assignment', triggerDetail: 'system', reason: 'issue_tree_restored', payload: { issueId: issue.id, rootIssueId: context.rootIssueId, restoreHoldId: hold.id }, requestedByActorType: context.actor.actorType, requestedByActorId: context.actor.actorId,
              contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: 'issue_tree_restored', source: 'issue.tree_restore', rootIssueId: context.rootIssueId, restoreHoldId: hold.id } } });
        }
        result.result = { hold: projectedHold, preview: current.preview, ...(hold.mode === 'resume' ? { resumedPauseHoldIds: current.selected.map(row => row.id) } : {}) };
      }
      acceptedResult = result;
      return result;
    };
    if (options.acceptance) return work(options.acceptance);
    const publications: ActivityPublication[] = [];
    let result: AcceptedTreeAction;
    try { result = await db.transaction(tx => work({ executor: tx as unknown as Db, publications })); }
    catch (error) {
      if (acceptedResult) throw conflict('Issue tree acceptance acknowledgment is unknown; read current state', { persistenceOutcome: 'unknown', rootIssueId: context.rootIssueId,
        holdId: intent.kind === 'release' ? intent.holdId : (acceptedResult.result as CreateResult).hold?.id });
      throw error;
    }
    try { for (const publication of publications) publishActivity(publication); }
    catch { throw conflict('Issue tree was accepted but publication is unresolved; read current state', { persistenceOutcome: 'accepted', rootIssueId: context.rootIssueId,
      holdId: intent.kind === 'release' ? intent.holdId : (result.result as CreateResult).hold?.id }); }
    return result;
  }

  async function dispatchTreeEffects(accepted: AcceptedTreeAction, runtime: Pick<ReturnType<typeof heartbeatService>, 'cancelRun' | 'wakeup'>) {
    const pending = new Set(accepted.effects);
    const record = async (effect: TreeEffect, outcome: string, runtimeId: string | null) => {
      await logActivity(db, { companyId: accepted.companyId, ...accepted.actor,
        action: effect.kind === 'cancelRun' && outcome === 'cancelled' ? 'issue.tree_hold_run_interrupted' : effect.kind === 'wake' && runtimeId ? 'issue.tree_restore_wakeup_requested' : 'issue.tree_hold_effect_unresolved',
        entityType: runtimeId ? 'heartbeat_run' : 'issue', entityId: runtimeId ?? effect.issueId,
        details: { holdId: effect.holdId, rootIssueId: accepted.rootIssueId, issueId: effect.issueId, outcome } }).catch(() => undefined);
    };
    const tasks = accepted.effects.map(async effect => {
      let outcome: string, runtimeId: string | null = null;
      try {
        if (effect.kind === 'cancelRun') {
          const run = await runtime.cancelRun(effect.runId, "Interrupted: the issue was held by a subtree pause");
          outcome = run && run.id !== effect.runId ? 'unconfirmed' : run?.status ?? 'null'; runtimeId = effect.runId;
        } else {
          const run = await runtime.wakeup(effect.agentId, effect.options);
          const persisted = run ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, accepted.companyId), eq(heartbeatRuns.agentId, effect.agentId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${effect.issueId}`)).then(rows => rows[0] ?? null) : null;
          outcome = persisted ? `wake_${persisted.status}` : run ? 'unconfirmed' : 'null'; runtimeId = persisted?.id ?? null;
        }
      } catch { outcome = 'thrown'; }
      pending.delete(effect);
      await record(effect, outcome, runtimeId);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(tasks), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
      for (const effect of pending) await record(effect, 'pending', effect.kind === 'cancelRun' ? effect.runId : null);
    } finally { if (timer) clearTimeout(timer); }
  }

  return {
    planAction, acceptAction, authorizeRead, readAction, dispatchTreeEffects,
    listTreeIssues,
    preview,
    createHold,
    cancelIssueStatusesForHold,
    restoreIssueStatusesForHold,
    getHold,
    listHolds,
    getActivePauseHoldGate,
    releaseHold,
    cancelUnclaimedWakeupsForTree,
  };
}
