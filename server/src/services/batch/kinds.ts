import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueLabels, issues } from "@paperclipai/db";
import { BATCH_MAX_RECORDS_UI, BATCH_REASON_CODES, issueUpdateBatchChangeSchema, type IssueUpdateBatchChange } from "@paperclipai/shared";
import { listVisibleIssueIds } from "../../routes/visibility.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../issue-execution-policy.js";
import { routePersonAssignee } from "../stewarded-agent-routing.js";
import { approvalApproveBatchKind, approvalRejectBatchKind } from "./approval-kinds.js";
import { agentPauseBatchKind, agentResumeBatchKind, agentSetModelBatchKind, agentTransferStewardBatchKind } from "./agent-kinds.js";
import { labelDeleteBatchKind, labelUpdateBatchKind, routineArchiveBatchKind, routineDeleteBatchKind } from "./routine-label-kinds.js";

/**
 * AgentDash admin powers, part 2: the kinds a batch can be.
 *
 * A kind adds no authority. It only says how to find the records the person
 * can see, what the change does to each (`describe`), and which request the
 * record's own single-record route takes (`request`). The route then decides,
 * per record, with its own guards: the batch engine never re-implements a
 * check. Part 3 adds the product kinds; each one must also join the parity
 * suite (server/src/__tests__/batch-guard-parity.test.ts).
 */

export interface BatchKindRecord {
  entityType: string;
  entityId: string;
  /** What a person calls it, for example "ENG-12 Fix the login page". */
  label: string;
}

export interface BatchItemRequest {
  method: "PATCH" | "POST" | "PUT" | "DELETE";
  /** Absolute API path on this server, for example `/api/issues/<id>`. No query string. */
  path: string;
  body: Record<string, unknown>;
}

export interface BatchKindContext {
  db: Db;
  /** The person's request at preview; at apply, a request-shaped view of the freshly re-read actor. */
  req: Request;
  companyId: string;
}

export interface BatchKindItemRef {
  itemId: string;
  /** What the preview recorded as `before`: requests that carry a revision send the previewed one. */
  before: Record<string, unknown>;
  /** For routes that take an idempotency key: unguessable, stable for this item. */
  idempotencyKey: string;
}

export interface BatchKind<Change = unknown, Record extends BatchKindRecord = BatchKindRecord> {
  key: string;
  entityType: string;
  /** What a person calls one record of this kind, in reasons ("task", "approval"). */
  noun: string;
  maxPerBatch: number;
  /** Throws a ZodError (400) for a change this kind does not accept. */
  parseChange(input: unknown): Change;
  /**
   * An extra guard beyond board access to the company (for example
   * admin-only kinds). The engine runs it at preview and again at confirm.
   */
  previewGuard?(ctx: BatchKindContext): Promise<void>;
  /**
   * Only the records the actor can see (or may act on). Ids it cannot see are
   * simply absent, never named. The change is passed so a kind can resolve
   * what the route will do (for example a person who stewards an agent).
   */
  load(ctx: BatchKindContext, ids: readonly string[], change: Change): Promise<Map<string, Record>>;
  /**
   * `before` and `after` of the record. `before` is also the drift
   * fingerprint: it is hashed at preview and compared with a fresh read
   * before the item is sent; at apply the freshly described `after` must
   * also still equal the previewed one.
   */
  describe(record: Record, change: Change): {
    before: { [key: string]: unknown };
    after: { [key: string]: unknown };
    noop: boolean;
    /**
     * Set when the record's own rules, not the batch, would decide the
     * outcome (for example an issue whose review step takes a "done"). The
     * record is left out of the batch and the reason is shown at preview.
     */
    notDecidable?: { reasonCode: string; reason: string };
    /** Plain consequences shown at preview ("Moving it out of done reopens it."). */
    notes?: string[];
  };
  /**
   * The fields compared after the route answered 2xx, against the same keys
   * of the previewed `after`. Defaults to `describe(record).before`.
   */
  observe?(record: Record): { [key: string]: unknown };
  /**
   * For kinds that remove the record (deletes): the observed fields when the
   * record no longer exists after a 2xx. Without it a vanished record is
   * reported as "changed, but you can no longer see it".
   */
  observeMissing?: { [key: string]: unknown };
  /**
   * A 2xx can still say the change was not this batch's (an approval already
   * decided by someone else answers 200). Return a plain reason in that case.
   */
  checkResponse?(body: unknown, context: { actorUserId: string | null; request: BatchItemRequest }): string | null;
  /** The single-record route's own request, built at apply time from a fresh read. */
  request(record: Record, change: Change, item: BatchKindItemRef): BatchItemRequest;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBatchKind = BatchKind<any, any>;

type IssueRecord = BatchKindRecord & {
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  labelIds: string[];
  /** A review or approval step has not been completed, so a "done" or "in review" starts it. */
  reviewStepOpen?: boolean;
  /** A review or approval step is under way now, so its workflow decides status and assignee. */
  reviewStepActive?: boolean;
  /** The issue carries a review or approval record (execution state). */
  hasReviewRecord?: boolean;
  /** For a change that assigns a person: the agent the route will hand it to, when that person stewards one. */
  routedAgentId?: string | null;
};

/**
 * Every field `issue.update` can touch. Each item's `before` and `after` hold
 * all of them, not only the ones the change names: the route can change the
 * others as a side effect (an execution policy hands the issue to its
 * reviewer), and the post-apply check compares all of them.
 */
const ISSUE_WATCHED_FIELDS = ["status", "priority", "assigneeAgentId", "assigneeUserId", "projectId", "labelIds"] as const;

/** Statuses the execution policy treats as "start the review or approval workflow" (issue-execution-policy.ts). */
const WORKFLOW_STARTING_STATUSES = new Set(["done", "in_review"]);

/**
 * The issue's review or approval steps. Conservative: an unreadable policy, or
 * a stage with no completed record, counts as open.
 */
function reviewSteps(executionPolicy: unknown, executionState: unknown): { open: boolean; active: boolean } {
  if (executionPolicy == null) return { open: false, active: false };
  let policy: ReturnType<typeof normalizeIssueExecutionPolicy>;
  try {
    policy = normalizeIssueExecutionPolicy(executionPolicy);
  } catch {
    return { open: true, active: true };
  }
  if (!policy || policy.stages.length === 0) return { open: false, active: false };
  const state = parseIssueExecutionState(executionState);
  const completed = new Set(state?.completedStageIds ?? []);
  return {
    open: policy.stages.some((stage) => !completed.has(stage.id)),
    active: Boolean(state?.currentStageId) && (state?.status === "pending" || state?.status === "changes_requested"),
  };
}

function issueLabel(row: { identifier: string | null; title: string }): string {
  const title = row.title.length > 120 ? `${row.title.slice(0, 117)}...` : row.title;
  return row.identifier ? `${row.identifier} ${title}` : title;
}

/**
 * `issue.update`: status, priority or the agent assignee of many issues,
 * through `PATCH /api/issues/:id` — the route's own visibility hook,
 * `assertCompanyAccess`, `assertIssueWriteTargetsVisible`, the
 * `tasks:assign` rule and the issue authority witnesses all run per issue.
 */
export const issueUpdateBatchKind: BatchKind<IssueUpdateBatchChange, IssueRecord> = {
  key: "issue.update",
  entityType: "issue",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  noun: "task",
  parseChange: (input) => issueUpdateBatchChangeSchema.parse(input),
  async load({ db, req, companyId }, ids, change) {
    const visible = await listVisibleIssueIds(db, req, companyId, ids);
    if (visible.size === 0) return new Map();
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        projectId: issues.projectId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...visible])));
    const labelRows = rows.length === 0 ? [] : await db
      .select({ issueId: issueLabels.issueId, labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(inArray(issueLabels.issueId, rows.map((row) => row.id)));
    // Work given to a person who stewards an agent goes to that agent. The
    // route's own rule decides, per issue (its exceptions for an unchanged
    // assignee and a person named in the review policy, and never an agent
    // the person cannot see), so the preview shows exactly what will happen.
    const routedByIssue = new Map<string, string | null>();
    if (change?.assignee && "userId" in change.assignee) {
      for (const row of rows) {
        const { routed } = await routePersonAssignee(db, req, companyId, { assigneeUserId: change.assignee.userId, assigneeAgentId: null }, {
          assigneeUserId: row.assigneeUserId,
          assigneeAgentId: row.assigneeAgentId,
          createdByUserId: row.createdByUserId,
          executionPolicy: row.executionPolicy,
        });
        routedByIssue.set(row.id, routed?.toAgentId ?? null);
      }
    }
    const labelsByIssue = new Map<string, string[]>();
    for (const row of labelRows) labelsByIssue.set(row.issueId, [...(labelsByIssue.get(row.issueId) ?? []), row.labelId]);
    return new Map(rows.map((row) => {
      const steps = reviewSteps(row.executionPolicy, row.executionState);
      return [row.id, {
        entityType: "issue",
        entityId: row.id,
        label: issueLabel(row),
        status: row.status,
        priority: row.priority,
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
        projectId: row.projectId,
        labelIds: [...(labelsByIssue.get(row.id) ?? [])].sort(),
        reviewStepOpen: steps.open,
        reviewStepActive: steps.active,
        hasReviewRecord: row.executionState != null,
        routedAgentId: routedByIssue.get(row.id) ?? null,
      }];
    }));
  },
  describe(record, change) {
    const before: Record<string, unknown> = {};
    for (const field of ISSUE_WATCHED_FIELDS) before[field] = field === "labelIds" ? [...record.labelIds] : record[field];
    const after: Record<string, unknown> = { ...before, labelIds: [...record.labelIds] };
    if (change.status !== undefined) after.status = change.status;
    if (change.priority !== undefined) after.priority = change.priority;
    if (change.assignee !== undefined) {
      if (change.assignee && "userId" in change.assignee && record.routedAgentId) {
        after.assigneeAgentId = record.routedAgentId;
        after.assigneeUserId = null;
      } else {
        after.assigneeAgentId = change.assignee && "agentId" in change.assignee ? change.assignee.agentId : null;
        after.assigneeUserId = change.assignee && "userId" in change.assignee ? change.assignee.userId : null;
      }
    }
    if (change.projectId !== undefined) after.projectId = change.projectId;
    if (change.addLabelIds?.length || change.removeLabelIds?.length) {
      const next = new Set(record.labelIds);
      for (const id of change.addLabelIds ?? []) next.add(id);
      for (const id of change.removeLabelIds ?? []) next.delete(id);
      after.labelIds = [...next].sort();
    }
    const notes: string[] = [];
    if (change.assignee && "userId" in change.assignee && record.routedAgentId) {
      notes.push("This person looks after an agent, so the task goes to that agent.");
    }
    if (record.status === "done" && change.status !== undefined && change.status !== "done") {
      notes.push(record.hasReviewRecord
        ? "Moving it out of done reopens it and clears its review record."
        : "Moving it out of done reopens it.");
    }
    const noop = ISSUE_WATCHED_FIELDS.every((field) => JSON.stringify(after[field]) === JSON.stringify(before[field]));
    if (noop) return { before, after, noop };
    const withNotes = notes.length > 0 ? { notes } : {};
    // The issue's review or approval workflow, not the batch, would decide
    // these: the route sends a "done" or "in review" to the reviewer and
    // reassigns it, and while a step is under way it controls status and
    // assignee. Leave the issue out, plainly, so a batch never surprises anyone.
    const touchesWorkflow = change.status !== undefined || change.assignee !== undefined;
    if (touchesWorkflow && record.reviewStepActive) {
      return {
        before, after, noop,
        notDecidable: { reasonCode: BATCH_REASON_CODES.inReviewNow, reason: `${record.label} is in review now, so its reviewer decides; it was left out.` },
      };
    }
    if (change.status !== undefined && WORKFLOW_STARTING_STATUSES.has(change.status) && record.reviewStepOpen) {
      return {
        before, after, noop,
        notDecidable: { reasonCode: BATCH_REASON_CODES.goesToReviewFirst, reason: `${record.label} goes to review first, so it was left out.` },
      };
    }
    return { before, after, noop, ...withNotes };
  },
  request(record, change) {
    const body: Record<string, unknown> = {};
    if (change.status !== undefined && change.status !== record.status) body.status = change.status;
    if (change.priority !== undefined && change.priority !== record.priority) body.priority = change.priority;
    if (change.assignee !== undefined) {
      // The person's id is sent as is: the route itself hands work given to a
      // person who stewards an agent to that agent, as the preview said.
      body.assigneeAgentId = change.assignee && "agentId" in change.assignee ? change.assignee.agentId : null;
      body.assigneeUserId = change.assignee && "userId" in change.assignee ? change.assignee.userId : null;
    }
    if (change.projectId !== undefined && change.projectId !== record.projectId) body.projectId = change.projectId;
    if (change.addLabelIds?.length || change.removeLabelIds?.length) {
      const next = new Set(record.labelIds);
      for (const id of change.addLabelIds ?? []) next.add(id);
      for (const id of change.removeLabelIds ?? []) next.delete(id);
      body.labelIds = [...next].sort();
    }
    return { method: "PATCH", path: `/api/issues/${record.entityId}`, body };
  },
};

/** The production registry. Tests pass their own kinds to the service instead of registering here. */
export const BATCH_KINDS: Readonly<Record<string, AnyBatchKind>> = Object.freeze({
  [issueUpdateBatchKind.key]: issueUpdateBatchKind,
  [approvalApproveBatchKind.key]: approvalApproveBatchKind,
  [approvalRejectBatchKind.key]: approvalRejectBatchKind,
  [agentPauseBatchKind.key]: agentPauseBatchKind,
  [agentResumeBatchKind.key]: agentResumeBatchKind,
  [agentSetModelBatchKind.key]: agentSetModelBatchKind,
  [agentTransferStewardBatchKind.key]: agentTransferStewardBatchKind,
  [routineArchiveBatchKind.key]: routineArchiveBatchKind,
  [routineDeleteBatchKind.key]: routineDeleteBatchKind,
  [labelUpdateBatchKind.key]: labelUpdateBatchKind,
  [labelDeleteBatchKind.key]: labelDeleteBatchKind,
});
