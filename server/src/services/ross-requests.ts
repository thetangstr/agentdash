import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, documents, heartbeatRuns, issueComments, issueDocuments } from "@paperclipai/db";
import {
  anchoredRossRequestQuestion,
  readIssueRecoveryBudget,
  rossRequestMarker,
  ROSS_REVIEW_DOCUMENT_KEY,
  ROSS_REVIEW_FRESH_MS,
  type RossRequestReadStatus,
} from "@paperclipai/shared";
import { redactRunLogText } from "./run-log-redaction.js";

/**
 * AgentDash (Ross launch M2): server-side reads behind the governed
 * question-to-Ross request (routes/ross-requests.ts).
 *
 * Ownership of a request key is decided from server-written columns only:
 * a comment is the actor's own request when its body OPENS with the key's
 * marker AND its `author_user_id` equals the authenticated person (agents
 * never qualify). Any other comment carrying the key — another author's
 * marker, an agent echo, a mid-body quote — contests the key. A contest can
 * deny a request; it can never suppress one into a spoofed receipt.
 */

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface RossRequestComment {
  id: string;
  body: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: Date;
}

export interface RossRequestClassification {
  own: (RossRequestComment & { question: string }) | null;
  contested: boolean;
}

/** Every comment on the issue that carries this key's marker anywhere in its body. */
export async function findRossRequestComments(
  executor: DbOrTx,
  input: { companyId: string; issueId: string; requestKey: string },
): Promise<RossRequestComment[]> {
  // The key is [a-z0-9-] only (validated upstream), so it carries no LIKE
  // metacharacters; the brackets are literal in LIKE.
  const rows = await executor
    .select({
      id: issueComments.id,
      body: issueComments.body,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        like(issueComments.body, `%${rossRequestMarker(input.requestKey)}%`),
      ),
    )
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  // AgentDash (GH #992): request bodies are parsed and copied into review
  // documents — apply the read pass before they leave the comments table.
  return rows.map((row) => ({ ...row, body: redactRunLogText(row.body) }));
}

export function classifyRossRequestComments(
  rows: RossRequestComment[],
  input: { requestKey: string; actorUserId: string },
): RossRequestClassification {
  let own: RossRequestClassification["own"] = null;
  let contested = false;
  for (const row of rows) {
    const question = anchoredRossRequestQuestion(row.body, input.requestKey);
    const isOwn = question !== null && row.authorAgentId === null && row.authorUserId === input.actorUserId;
    if (isOwn) {
      // The earliest own anchored comment is the request; a later duplicate
      // (impossible through the route, possible by hand) changes nothing.
      if (!own) own = { ...row, question };
      continue;
    }
    contested = true;
  }
  return { own, contested };
}

export interface RossReviewRow {
  documentId: string;
  revisionId: string | null;
  revisionNumber: number;
  body: string;
  updatedAt: Date;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
}

export async function readRossReview(
  executor: DbOrTx,
  input: { companyId: string; issueId: string },
): Promise<RossReviewRow | null> {
  const rows = await executor
    .select({
      documentId: documents.id,
      revisionId: documents.latestRevisionId,
      revisionNumber: documents.latestRevisionNumber,
      body: documents.latestBody,
      updatedAt: documents.updatedAt,
      updatedByAgentId: documents.updatedByAgentId,
      updatedByUserId: documents.updatedByUserId,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(
      and(
        eq(issueDocuments.companyId, input.companyId),
        eq(issueDocuments.issueId, input.issueId),
        eq(issueDocuments.key, ROSS_REVIEW_DOCUMENT_KEY),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The named-human remediation permit (#890) on an exhausted issue, when one
 * is live. Its bound run is the only run that can pass the exhausted gate.
 */
export function authorizedRemediationRunId(executionState: unknown): string | null {
  const remediation = record(record(record(executionState)?.recoveryBudget)?.remediation);
  if (!remediation || remediation.status !== "authorized") return null;
  return typeof remediation.runId === "string" ? remediation.runId : null;
}

const REVIEW_BODY_LIMIT = 6000;

export interface RossRequestStatusInput {
  issue: { id: string; companyId: string; assigneeAgentId: string | null; executionState: unknown };
  requestKey: string;
  actorUserId: string;
  now?: Date;
}

/**
 * One honest read of a request's state. `answered` only when the issue's
 * CURRENT assignee agent published a `ross-review` at or after the request
 * and it is still fresh; a review by anyone else is reported as present but
 * never as the answer. Nothing here starts, wakes or claims a run.
 */
export async function readRossRequestStatus(db: DbOrTx, input: RossRequestStatusInput) {
  const { issue, requestKey, actorUserId } = input;
  const now = input.now ?? new Date();
  const base = { requestKey, issueId: issue.id, companyId: issue.companyId, observedAt: now.toISOString() };
  const rows = await findRossRequestComments(db, { companyId: issue.companyId, issueId: issue.id, requestKey });
  const { own, contested } = classifyRossRequestComments(rows, { requestKey, actorUserId });
  if (!own) {
    const status: RossRequestReadStatus = contested ? "conflict" : "not_found";
    return {
      ...base,
      status,
      reason: contested ? "request-key-contested-by-foreign-comment" : "no-request-with-this-key-by-you",
    };
  }

  const request = { commentId: own.id, requestedAt: own.createdAt.toISOString(), question: own.question, contested };
  const review = await readRossReview(db, { companyId: issue.companyId, issueId: issue.id });
  const reviewAfterRequest = review ? review.updatedAt.getTime() >= own.createdAt.getTime() : false;
  const attributed = Boolean(review && issue.assigneeAgentId && review.updatedByAgentId === issue.assigneeAgentId);
  const ageMs = review ? now.getTime() - review.updatedAt.getTime() : null;
  const reviewMeta = review
    ? {
        documentKey: ROSS_REVIEW_DOCUMENT_KEY,
        documentId: review.documentId,
        revisionId: review.revisionId,
        revisionNumber: review.revisionNumber,
        recordedAt: review.updatedAt.toISOString(),
        ageMinutes: ageMs === null ? null : Math.max(0, Math.floor(ageMs / 60_000)),
        authorAgentId: review.updatedByAgentId,
        authorUserId: review.updatedByUserId,
        attributedToAssignee: attributed,
        newerThanRequest: reviewAfterRequest,
      }
    : null;
  const qualification = {
    sourceKind: "untrusted-source-content" as const,
    businessOutcomeVerified: false,
    independentlyRechecked: false,
    note: "A stored ross-review is attributed source content. This read makes no model call, does not recheck its claims and grants no capability.",
  };

  if (review && attributed && reviewAfterRequest) {
    const fresh = ageMs !== null && ageMs >= 0 && ageMs <= ROSS_REVIEW_FRESH_MS;
    const truncated = review.body.length > REVIEW_BODY_LIMIT;
    return {
      ...base,
      status: (fresh ? "answered" : "stale") as RossRequestReadStatus,
      reason: fresh ? null : "stored-assessment-stale",
      request,
      review: { ...reviewMeta, body: review.body.slice(0, REVIEW_BODY_LIMIT), truncated },
      ...qualification,
    };
  }

  // Not answered. An exhausted recovery budget refuses every ordinary wake
  // (#890); only a live named-human permit's bound run can pass, so pending
  // is honest only while such a permit is authorized.
  if (readIssueRecoveryBudget(issue.executionState)) {
    const permitRunId = authorizedRemediationRunId(issue.executionState);
    if (!permitRunId) {
      return {
        ...base,
        status: "refused" as RossRequestReadStatus,
        reason: "recovery-exhausted",
        request,
        review: reviewMeta,
        gate: { state: "recovery-budget-exhausted" },
        ...qualification,
      };
    }
    return {
      ...base,
      status: "pending" as RossRequestReadStatus,
      reason: "assessment-not-yet-published",
      request,
      review: reviewMeta,
      gate: { state: "remediation-permit-authorized", runId: permitRunId },
      ...qualification,
    };
  }

  // The wake this request's comment queued, when one was recorded for it.
  // A wake can coalesce into one already queued for the assignee, so an
  // absent row is reported as such — never as "no run will happen".
  const [wake] = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, issue.companyId),
        sql`${agentWakeupRequests.payload} ->> 'commentId' = ${own.id}`,
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);
  let run: { id: string; status: string; errorCode: string | null; finishedAt: string | null } | null = null;
  if (wake?.runId) {
    const [row] = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, wake.runId), eq(heartbeatRuns.companyId, issue.companyId)))
      .limit(1);
    if (row) run = { id: row.id, status: row.status, errorCode: row.errorCode, finishedAt: row.finishedAt?.toISOString() ?? null };
  }
  return {
    ...base,
    status: "pending" as RossRequestReadStatus,
    reason: review && !attributed && reviewAfterRequest ? "review-author-not-assigned-agent" : "assessment-not-yet-published",
    request,
    review: reviewMeta,
    gate: wake
      ? { state: "wake-recorded", wakeStatus: wake.status, run }
      : { state: "no-wake-row-for-this-request", run: null },
    ...qualification,
  };
}
