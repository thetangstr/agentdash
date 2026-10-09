import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { agentFactRequestService } from "./agent-fact-requests.js";
import { bridgeService } from "./bridge.js";
import {
  connectorSendExecutionService,
  describeConnectorSendOutcome,
  type ConnectorSendExecutionReport,
} from "./connector-send-execution.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { deliverableReviewService } from "./deliverable-review.js";
// Imported from the barrel, exactly as the board route imports them. Not a
// style preference: existing route tests substitute this module, and a
// deeper specifier would silently bypass those doubles and reach the real
// implementation with a stub database.
import {
  agentService,
  approvalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
} from "./index.js";
import { stewardInboxService } from "./steward-inbox.js";
import { workflowRecommendationService } from "./workflow-recommendations.js";

type ApprovalRow = typeof approvals.$inferSelect;

export interface DecisionEffectsContext {
  /** The human the decision is attributed to. */
  actorUserId: string;
  decisionNote: string | null;
  /**
   * AgentDash consolidation PR-A (H2): set when the decision arrived through
   * an assistant grant (`assistant_grant <grant> (<client>)`), so the
   * activity row reads "via assistant", never as a hand-checked record.
   */
  via?: string;
  /**
   * Whether to wake the requesting agent with `approval_approved`. Default
   * true. False only when the decision records an outcome a human already
   * brought about directly — a hire activated from the agent's own page —
   * which never woke the requester before the approval was recorded, and a
   * wake is a full agent run.
   */
  wakeRequester?: boolean;
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
  const accountability = agentAccountabilityService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });

  /**
   * AgentDash-MK: an approved connector_send that did not deliver.
   *
   * Approving one used to be the end of the story for everyone watching: the
   * requester was woken with `approval_approved`, the steward saw a decided
   * card, and the refusal lived only in `connector_send_executions`. So every
   * surface a person or the requester actually reads gets the outcome — the
   * approval thread, each linked issue, the steward inbox — and the requester
   * is woken with a reason that says the send did not go out (see the wake
   * below). Each step is logged, never thrown: the decision is committed.
   */
  async function reportUndeliveredConnectorSend(
    approval: ApprovalRow,
    report: ConnectorSendExecutionReport,
    linkedIssueIds: string[],
  ): Promise<void> {
    const summary = describeConnectorSendOutcome(report);
    const body = [
      "**Approved connector send was not delivered.**",
      "",
      summary,
      "",
      `- Approval: \`${approval.id}\``,
      `- Outcome: \`${report.outcome}\`${report.reason ? ` (reason \`${report.reason}\`)` : ""}`,
      "",
      // One pointer for the requesting agent, who reads this thread too. The
      // agent-facing detail stays out of text written for a person.
      report.outcome === "outcome_unknown"
        ? "Requesting agent: do not refile this request; a steward must reconcile it first."
        : "Requesting agent: do not refile this request as-is; see \"Reaching a person outside AgentDash\" in your mandate.",
    ].join("\n");

    try {
      await approvalService(db).addComment(approval.id, body, {});
    } catch (err) {
      logger.error({ err, approvalId: approval.id }, "connector send outcome comment on approval failed");
    }

    const issues = issueService(db);
    for (const issueId of linkedIssueIds) {
      try {
        await issues.addComment(issueId, body, {});
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id, issueId },
          "connector send outcome comment on linked issue failed",
        );
      }
    }

    let notifiedUserId: string | null = null;
    if (approval.requestedByAgentId) {
      try {
        notifiedUserId = await accountability.escalationUserId(
          approval.companyId,
          approval.requestedByAgentId,
        );
        if (notifiedUserId) {
          const agentName = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, approval.requestedByAgentId))
            .then((rows) => rows[0]?.name ?? null);
          await stewardInbox.appendEvent({
            companyId: approval.companyId,
            stewardUserId: notifiedUserId,
            kind: "connector_send.failed",
            refType: "approval",
            refId: approval.id,
            agentId: approval.requestedByAgentId,
            // One per approval: an execution runs at most once.
            dedupeKey: `connector_send:${approval.id}:undelivered`,
            // Reference and reason only, never the payload that was to be sent.
            payload: {
              approvalId: approval.id,
              agentName,
              outcome: report.outcome,
              reason: report.reason,
              provider: report.provider,
              message: summary,
              issueIds: linkedIssueIds,
            },
          });
        }
      } catch (err) {
        logger.error({ err, approvalId: approval.id }, "connector send outcome inbox event failed");
      }
    }

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "system",
      actorId: "connector-send",
      agentId: approval.requestedByAgentId,
      action: "connector_send.undelivered_reported",
      entityType: "approval",
      entityId: approval.id,
      details: {
        outcome: report.outcome,
        reason: report.reason,
        provider: report.provider,
        linkedIssueIds,
        notifiedUserId,
      },
    });
  }

  async function afterApprove(
    approval: ApprovalRow,
    applied: boolean,
    { actorUserId, decisionNote, via, wakeRequester = true }: DecisionEffectsContext,
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
        ...(via ? { via } : {}),
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

    // AgentDash-MK: run an approved connector_send BEFORE waking the
    // requester, so the one wake it gets carries the real outcome. Waking
    // first told it "approved", which it read as "sent". Executed here rather
    // than inside the approval service, so the service stays the decision
    // boundary and nothing else; the executor swallows every failure
    // internally, so an unreachable provider cannot fail this call.
    let connectorSendReport: ConnectorSendExecutionReport | null = null;
    if (approval.type === "connector_send") {
      connectorSendReport = await connectorSend.executeForApproval(approval.id);
      if (connectorSendReport && connectorSendReport.outcome !== "succeeded") {
        try {
          await reportUndeliveredConnectorSend(approval, connectorSendReport, linkedIssueIds);
        } catch (err) {
          logger.error(
            { err, approvalId: approval.id },
            "connector send outcome was not reported; the requester may believe it was sent",
          );
        }
      }
    }
    const wakeReason =
      connectorSendReport?.outcome === "failed"
        ? "connector_send_failed"
        : connectorSendReport?.outcome === "outcome_unknown"
          ? "connector_send_outcome_unknown"
          : "approval_approved";
    const connectorSendOutcome = connectorSendReport
      ? { outcome: connectorSendReport.outcome, reason: connectorSendReport.reason }
      : null;

    if (approval.requestedByAgentId && wakeRequester) {
      try {
        const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          payload: {
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            ...(connectorSendOutcome ? { connectorSend: connectorSendOutcome } : {}),
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
            wakeReason,
            ...(connectorSendOutcome
              ? {
                  connectorSendOutcome: connectorSendOutcome.outcome,
                  connectorSendReason: connectorSendOutcome.reason,
                }
              : {}),
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
            wakeReason,
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

  }

  async function afterReject(
    approval: ApprovalRow,
    applied: boolean,
    { actorUserId, decisionNote, via }: DecisionEffectsContext,
  ): Promise<void> {
  if (applied) {
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "approval.rejected",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, ...(via ? { via } : {}) },
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

    // AgentDash: wake the requester with the refusal, from every decision
    // surface. Without this a rejected agent learned nothing until something
    // else woke it, and an agent blocked on its own request stayed blocked.
    // Last, so every effect above (a declined bridge task, a discarded fact)
    // is already visible when it reads why. Logged, never thrown: the
    // decision is committed.
    if (approval.requestedByAgentId) {
      let linkedIssueIds: string[] = [];
      try {
        linkedIssueIds = (await issueApprovalsSvc.listIssuesForApproval(approval.id)).map((issue) => issue.id);
      } catch (err) {
        logger.warn({ err, approvalId: approval.id }, "linked issues unavailable for rejection wake");
      }
      const primaryIssueId = linkedIssueIds[0] ?? null;
      try {
        const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_rejected",
          payload: {
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
          },
          requestedByActorType: "user",
          requestedByActorId: actorUserId,
          contextSnapshot: {
            source: "approval.rejected",
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            taskId: primaryIssueId,
            wakeReason: "approval_rejected",
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
            wakeReason: "approval_rejected",
            linkedIssueIds,
          },
        });
      } catch (err) {
        logger.warn(
          { err, approvalId: approval.id, requestedByAgentId: approval.requestedByAgentId },
          "failed to queue requester wakeup after rejection",
        );
      }
    }
  }
  }

  return { afterApprove, afterReject };
}
