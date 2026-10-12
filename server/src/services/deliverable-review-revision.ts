import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues } from "@paperclipai/db";
import { insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueService } from "./issues.js";

// AgentDash: moved out of routes/issues.ts so the bridge send-back
// (services/steward-work-reply.ts) runs the same step after a document
// revision as the web document route does.

/**
 * AgentDash (batch 2 review lane): a new revision written to the document of
 * a deliverable sends that deliverable back to review. An accepted
 * deliverable whose document changed after the accepted revision returns to
 * ready_for_review — and reopens a done issue to in_review so the review
 * actually surfaces again; a sent-back deliverable on an issue already in
 * review becomes reviewable once the revision it was asked for lands.
 *
 * AgentDash (review #1003): a board user's own write or restore does not
 * reopen what they accepted — the new revision is recorded as the accepted
 * one instead. The issue status is re-read under the row lock so a
 * concurrent PATCH cannot move the issue between the route's stale read and
 * this hook, and the reopen goes through the issue service rather than a raw
 * update.
 */
export async function applyDeliverableReviewAfterDocumentRevision(input: {
  db: Db;
  issue: { id: string; companyId: string; identifier?: string | null };
  key: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  actor: { actorType: "agent" | "plugin" | "system" | "user"; actorId: string; agentId: string | null; runId: string | null; source?: string | null };
  onIssueStatusChanged: (issueId: string, before: string, after: string) => Promise<unknown>;
}) {
  const { db, issue, key, latestRevisionId, latestRevisionNumber, actor, onIssueStatusChanged } = input;
  const publications: ActivityPublication[] = [];
  let reopenedDoneIssue = false;
  await db.transaction(async (tx) => {
    const freshIssue = await tx
      .select({ status: issues.status, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!freshIssue) return;
    const identifier = freshIssue.identifier ?? issue.identifier ?? null;
    const candidates = await tx
      .select({ id: issueWorkProducts.id, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        inArray(issueWorkProducts.status, ["approved", "changes_requested"]),
        sql`${issueWorkProducts.metadata} ->> 'documentKey' = ${key}`,
      ));
    if (candidates.length === 0) return;
    const now = new Date();
    let reopenedAccepted = false;
    for (const product of candidates) {
      const meta = (product.metadata ?? null) as Record<string, unknown> | null;
      if (product.status === "approved") {
        const acceptance = meta?.acceptance as Record<string, unknown> | undefined;
        const acceptedRevision =
          typeof acceptance?.acceptedRevisionNumber === "number" ? acceptance.acceptedRevisionNumber : null;
        // The revision the person accepted already covers this write.
        if (acceptedRevision !== null && acceptedRevision >= latestRevisionNumber) continue;
        // A board user's own edit or restore accepts what they just wrote —
        // reopening their own change would churn the review queue. Writes by
        // an agent, plugin or assistant grant are not the reviewer.
        const boardUserWrite = actor.actorType === "user" && actor.source !== "assistant_grant";
        if (boardUserWrite) {
          await tx.update(issueWorkProducts)
            .set({
              metadata: sql`${issueWorkProducts.metadata} || jsonb_build_object('acceptance',
                coalesce(${issueWorkProducts.metadata} -> 'acceptance', '{}'::jsonb) || jsonb_build_object(
                  'acceptedRevisionId', ${latestRevisionId}::text,
                  'acceptedRevisionNumber', ${latestRevisionNumber}::int,
                  'acceptedAt', ${now.toISOString()}::text,
                  'acceptedByUserId', ${actor.actorId}::text))`,
              updatedAt: now,
            })
            .where(eq(issueWorkProducts.id, product.id));
          publications.push(await insertActivity(tx, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.work_product_updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier,
              workProductId: product.id,
              changedKeys: ["metadata"],
              reason: "accepted_revision_updated",
              key,
              revisionNumber: latestRevisionNumber,
            },
          }));
          continue;
        }
        await tx.update(issueWorkProducts)
          .set({
            status: "ready_for_review",
            reviewState: "needs_board_review",
            metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object(
              'reviewReopenedAt', ${now.toISOString()}::text,
              'reviewReopenReason', 'document_revised_after_acceptance')`,
            updatedAt: now,
          })
          .where(eq(issueWorkProducts.id, product.id));
        reopenedAccepted = true;
        publications.push(await insertActivity(tx, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.work_product_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier,
            workProductId: product.id,
            changedKeys: ["metadata", "reviewState", "status"],
            status: "ready_for_review",
            reviewState: "needs_board_review",
            reason: "document_revised_after_acceptance",
            key,
            revisionNumber: latestRevisionNumber,
          },
        }));
      } else if (product.status === "changes_requested") {
        // A sent-back deliverable is resubmitted by the new revision only
        // while the issue sits in review — and only when this revision is
        // newer than the one the changes request was made against.
        if (freshIssue.status !== "in_review") continue;
        const requestedRevision =
          typeof meta?.changesRequestedAtRevision === "number" ? meta.changesRequestedAtRevision : null;
        if (requestedRevision !== null && latestRevisionNumber <= requestedRevision) continue;
        await tx.update(issueWorkProducts)
          .set({
            status: "ready_for_review",
            reviewState: "needs_board_review",
            metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object('resubmittedAt', ${now.toISOString()}::text)`,
            updatedAt: now,
          })
          .where(eq(issueWorkProducts.id, product.id));
        publications.push(await insertActivity(tx, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.work_product_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier,
            workProductId: product.id,
            changedKeys: ["metadata", "reviewState", "status"],
            status: "ready_for_review",
            reviewState: "needs_board_review",
            reason: "resubmitted_for_review",
            key,
            revisionNumber: latestRevisionNumber,
          },
        }));
      }
    }
    if (reopenedAccepted && freshIssue.status === "done") {
      reopenedDoneIssue = true;
      await issueService(tx as unknown as Db).update(issue.id, { status: "in_review" }, tx as unknown as Db);
      publications.push(await insertActivity(tx, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier,
          status: "in_review",
          _previous: { status: "done" },
          reason: "document_revised_after_acceptance",
          key,
        },
      }));
    }
  });
  for (const publication of publications) publishActivity(publication);
  if (reopenedDoneIssue) {
    await onIssueStatusChanged(issue.id, "done", "in_review");
  }
}
