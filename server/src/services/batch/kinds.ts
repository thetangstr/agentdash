import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
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
  /** True when a review or approval step is still open, so a "done" goes there first. */
  reviewStepOpen?: boolean;
};

/**
 * Would moving this issue to done be taken by its execution policy (a review
 * or approval step) instead? Conservative: an unreadable policy, or a stage
 * with no completed record, counts as open.
 */
function reviewStepOpen(executionPolicy: unknown, executionState: unknown): boolean {
  if (executionPolicy == null) return false;
  let policy: ReturnType<typeof normalizeIssueExecutionPolicy>;
  try {
    policy = normalizeIssueExecutionPolicy(executionPolicy);
  } catch {
    return true;
  }
  if (!policy || policy.stages.length === 0) return false;
  const completed = new Set(parseIssueExecutionState(executionState)?.completedStageIds ?? []);
  return policy.stages.some((stage) => !completed.has(stage.id));
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
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...visible])));
    return new Map(rows.map((row) => [row.id, {
      entityType: "issue",
      entityId: row.id,
      label: issueLabel(row),
      status: row.status,
      priority: row.priority,
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
      reviewStepOpen: reviewStepOpen(row.executionPolicy, row.executionState),
    }]));
  },
  describe(record, change) {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (change.status !== undefined) {
      before.status = record.status;
      after.status = change.status;
    }
    if (change.priority !== undefined) {
      before.priority = record.priority;
      after.priority = change.priority;
    }
    if (change.assignee !== undefined) {
      before.assigneeAgentId = record.assigneeAgentId;
      before.assigneeUserId = record.assigneeUserId;
      after.assigneeAgentId = change.assignee && "agentId" in change.assignee ? change.assignee.agentId : null;
      after.assigneeUserId = change.assignee && "userId" in change.assignee ? change.assignee.userId : null;
    }
    const noop = Object.keys(after).every((key) => after[key] === before[key]);
    // A "done" on an issue with an open review or approval step is taken by
    // that step (the route moves it to review and hands it to the reviewer),
    // so the batch would not do what it says. Leave it out, plainly.
    if (!noop && change.status === "done" && record.reviewStepOpen) {
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
