import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { agentFactRequestService } from "./agent-fact-requests.js";
import { bridgeService } from "./bridge.js";
import { connectorSendExecutionService } from "./connector-send-execution.js";
import { deliverableReviewService } from "./deliverable-review.js";
// Imported from the barrel, exactly as the board route imports them. Not a
// style preference: existing route tests substitute this module, and a
// deeper specifier would silently bypass those doubles and reach the real
// implementation with a stub database.
import {
  agentService,
  heartbeatService,
  issueApprovalService,
  logActivity,
} from "./index.js";
import { stewardInboxService } from "./steward-inbox.js";
import { workflowRecommendationService } from "./workflow-recommendations.js";

type ApprovalRow = typeof approvals.$inferSelect;

export interface DecisionEffectsContext {
  /** The human the decision is attributed to. */
  actorUserId: string;
  decisionNote: string | null;
}

/**
 * AgentDash: everything that must happen once an approval decision is applied.
 *
 * This lived inline in the board's approve and reject handlers, which made the
 * board the only surface that produced a COMPLETE decision. Teams already
 * decided approvals through `decideFromCardAction` and fired none of it, so a
 * bridge `act` task approved from Teams stayed `awaiting_approval` for ever, a
 * held fact answer was never released, and a two-seat deliverable sign-off
 * never advanced. Extracting it is what lets a second decision surface exist
 * without inheriting that gap.
 *
 * The decision itself is NOT here. `approvalService` remains the only decision
 * boundary and `approvalAuthorityService` the only thing that checks authority;
 * this runs afterwards, and takes `applied` so that a no-op decision — a
 * repeat, an idempotent replay — fires nothing.
 *
 * Failure policy is unchanged from the original: each step is caught and logged
 * rather than thrown, because the decision is already committed and throwing
 * would tell a steward their approval failed when it did not. Logged at error
 * level, not warning, because a step that fails strands work invisibly.
 */
export function approvalDecisionEffectsService(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    autoDispatchQueuedRuns?: boolean;
  } = {},
) {
  const issueApprovalsSvc = issueApprovalService(db);
  const stewardInbox = stewardInboxService(db);
  const bridge = bridgeService(db);
  const facts = agentFactRequestService(db);
  const deliverableReview = deliverableReviewService(db);
  const recommendations = workflowRecommendationService(db);
  const connectorSend = connectorSendExecutionService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });

  async function afterApprove(
    approval: ApprovalRow,
    applied: boolean,
    { actorUserId, decisionNote }: DecisionEffectsContext,
  ): Promise<void> {
  if (applied) {
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const linkedIssueIds = linkedIssues.map((issue) => issue.id);
    const primaryIssueId = linkedIssueIds[0] ?? null;

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "approval.approved",
      entityType: "approval",
      entityId: approval.id,
      details: {
        type: approval.type,
        requestedByAgentId: approval.requestedByAgentId,
        linkedIssueIds,
      },
    });

    await stewardInbox.recordApprovalEvent(approval.id, "approval.resolved");

    if (approval.type === "mandate_violation" && approval.requestedByAgentId) {
      try {
        await agentService(db).resume(approval.requestedByAgentId);
      } catch {
        /* already resumed/terminated — non-fatal */
      }
    }

    if (approval.requestedByAgentId) {
      try {
        const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_approved",
          payload: {
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
          },
          requestedByActorType: "user",
          requestedByActorId: actorUserId,
          contextSnapshot: {
            source: "approval.approved",
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            taskId: primaryIssueId,
            wakeReason: "approval_approved",
          },
        });

        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "approval.requester_wakeup_queued",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requesterAgentId: approval.requestedByAgentId,
            wakeRunId: wakeRun?.id ?? null,
            linkedIssueIds,
          },
        });
      } catch (err) {
        logger.warn(
          {
            err,
            approvalId: approval.id,
            requestedByAgentId: approval.requestedByAgentId,
          },
          "failed to queue requester wakeup after approval",
        );
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "approval.requester_wakeup_failed",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requesterAgentId: approval.requestedByAgentId,
            linkedIssueIds,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  // AgentDash-MK: an approved bridge `act` task becomes visible to polling.
  // Until this runs the task is `awaiting_approval` and no endpoint can see
  // it, which is what keeps the bridge from having a private path to action.
  if (applied) {
    // Logged rather than thrown: the decision is already committed, so a 500
    // here would tell the client their approval failed when it did not. But
    // this is NOT best-effort the way a notification is — a release that
    // fails strands the task invisibly, so it is an error-level event, not a
    // warning to scroll past.
    try {
      await bridge.releaseApprovedTask(approval.id);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "bridge task release failed after approval; task may be stranded",
      );
    }
    // Released still framed: the decision was that this content may travel,
    // not that it stopped being untrusted.
    try {
      await facts.releaseHeldFactAnswer(approval.id);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "held fact answer release failed after approval; the fact may be stranded",
      );
    }
    // AgentDash-MK: one seat of a deliverable's two-approver sign-off. The
    // first approval opens the second seat; the second ships. Error-level
    // rather than best-effort: a failure here strands a run that two people
    // believe they approved.
    try {
      await deliverableReview.advanceDeliverableApproval(approval.id);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "deliverable approval advance failed; the run may be stranded mid-approval",
      );
    }
    // AgentDash-MK: a recommendation the pipeline owner agreed with. This
    // records the agreement and stops — there is no branch anywhere that
    // acts on one, which is the whole of what "advisory" means here.
    try {
      await recommendations.settleRecommendationApproval(approval.id);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "recommendation settlement failed; it may stay open after being decided",
      );
    }
  }

  if (applied && approval.type === "connector_send") {
    // Executed here rather than inside the approval service, so the service
    // stays the decision boundary and nothing else. Awaited so the response
    // does not outlive its own side effect; the executor swallows every
    // failure internally, so an unreachable provider cannot fail this call.
    await connectorSend.executeForApproval(approval.id);
  }
  }

  async function afterReject(
    approval: ApprovalRow,
    applied: boolean,
    { actorUserId, decisionNote }: DecisionEffectsContext,
  ): Promise<void> {
  if (applied) {
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "approval.rejected",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });

    await stewardInbox.recordApprovalEvent(approval.id, "approval.resolved");
    // A rejected bridge task terminates carrying the steward's reason, so the
    // requesting agent can read WHY rather than watch a request vanish.
    try {
      await bridge.declineRejectedTask(approval.id, decisionNote);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "bridge task decline failed after rejection; task may be stranded",
      );
    }
    // A refused release destroys the content and declines the fact, flagged.
    // Left held it would be a figure nobody can ever obtain and nobody can
    // see is outstanding.
    try {
      await facts.discardHeldFactAnswer(approval.id, decisionNote);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "held fact answer discard failed after rejection; the fact may be stranded",
      );
    }
    // AgentDash-MK: a refused deliverable goes back to collection with its
    // verdict cleared, not to the second approver and not to the bin. A
    // weekly artifact that is wrong on Tuesday should still ship on Wednesday.
    try {
      await deliverableReview.failDeliverableApproval(approval.id, decisionNote);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "deliverable rejection handling failed; the run may be stranded awaiting approval",
      );
    }
    // A declined recommendation. It comes back only if the condition gets
    // worse, never merely because the tick came round again.
    try {
      await recommendations.settleRecommendationApproval(approval.id);
    } catch (err) {
      logger.error(
        { err, approvalId: approval.id },
        "recommendation settlement failed; it may stay open after being declined",
      );
    }
  }
  }

  return { afterApprove, afterReject };
}
