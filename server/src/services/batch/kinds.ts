import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueLabels, issues } from "@paperclipai/db";
import { BATCH_MAX_RECORDS_UI, BATCH_REASON_CODES, issueUpdateBatchChangeSchema, type IssueUpdateBatchChange } from "@paperclipai/shared";
import { listVisibleIssueIds } from "../../routes/visibility.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../issue-execution-policy.js";

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

export interface BatchKind<Change = unknown, Record extends BatchKindRecord = BatchKindRecord> {
  key: string;
  entityType: string;
  maxPerBatch: number;
  /** Throws a ZodError (400) for a change this kind does not accept. */
  parseChange(input: unknown): Change;
  /** An extra guard at preview, beyond board access to the company (for example admin-only kinds). */
  previewGuard?(ctx: BatchKindContext): Promise<void>;
  /** Only the records the actor can see. Ids it cannot see are simply absent, never named. */
  load(ctx: BatchKindContext, ids: readonly string[]): Promise<Map<string, Record>>;
  /**
   * The touched fields before and after. `before` is also the drift
   * fingerprint: it is hashed at preview and compared with a fresh read
   * before the item is sent.
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
  };
  /** The single-record route's own request, built at apply time from a fresh read. */
  request(record: Record, change: Change): BatchItemRequest;
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
  parseChange: (input) => issueUpdateBatchChangeSchema.parse(input),
  async load({ db, req, companyId }, ids) {
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
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...visible])));
    const labelRows = rows.length === 0 ? [] : await db
      .select({ issueId: issueLabels.issueId, labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(inArray(issueLabels.issueId, rows.map((row) => row.id)));
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
      after.assigneeAgentId = change.assignee && "agentId" in change.assignee ? change.assignee.agentId : null;
      after.assigneeUserId = change.assignee && "userId" in change.assignee ? change.assignee.userId : null;
    }
    const noop = ISSUE_WATCHED_FIELDS.every((field) => JSON.stringify(after[field]) === JSON.stringify(before[field]));
    if (noop) return { before, after, noop };
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
    return { before, after, noop };
  },
  request(record, change) {
    const body: Record<string, unknown> = {};
    if (change.status !== undefined && change.status !== record.status) body.status = change.status;
    if (change.priority !== undefined && change.priority !== record.priority) body.priority = change.priority;
    if (change.assignee !== undefined) {
      body.assigneeAgentId = change.assignee && "agentId" in change.assignee ? change.assignee.agentId : null;
      body.assigneeUserId = change.assignee && "userId" in change.assignee ? change.assignee.userId : null;
      // A person assignee stays with the person, so the record ends exactly
      // as the preview showed (the route would otherwise route work given to
      // a person who stewards an agent to that agent).
      if (body.assigneeUserId) body.assignToPerson = true;
    }
    return { method: "PATCH", path: `/api/issues/${record.entityId}`, body };
  },
};

/** The production registry. Tests pass their own kinds to the service instead of registering here. */
export const BATCH_KINDS: Readonly<Record<string, AnyBatchKind>> = Object.freeze({
  [issueUpdateBatchKind.key]: issueUpdateBatchKind,
});
