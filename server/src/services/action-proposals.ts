import type { Db } from "@paperclipai/db";
import { policyEngineService } from "./policy-engine.js";
import { approvalService } from "./approvals.js";
import { issueApprovalService } from "./issue-approvals.js";
import { logActivity } from "./activity-log.js";
import { crmLifecycleService } from "./crm-lifecycle.js";

// AgentDash: Action Proposal Service
// Bridges the policy engine → approval system for operational agent actions.
// Uses existing approvals table with type "action_proposal" — no new DB table needed.

export function actionProposalService(db: Db) {
  const policySvc = policyEngineService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);

  return {
    /**
     * Agent proposes an operational action (refund, replacement, etc.).
     * 1. Evaluates against security policies
     * 2. If allowed → auto-approved (no approval record)
     * 3. If escalated/denied → creates approval for human review
     */
    propose: async (
      companyId: string,
      agentId: string,
      data: {
        actionType: string;
        summary: string;
        amountCents?: number;
        currency?: string;
        confidenceScore?: number;
        evidence: Record<string, unknown>;
        issueId?: string;
        crmAccountId?: string;
        crmContactId?: string;
      },
    ) => {
      // Evaluate against security policies
      const policyResult = await policySvc.evaluateProposal(companyId, agentId, {
        actionType: data.actionType,
        amountCents: data.amountCents,
        context: { summary: data.summary, evidence: data.evidence },
      });

      if (policyResult.decision === "allowed") {
        await logActivity(db, {
          companyId,
          actorType: "agent",
          actorId: agentId,
          agentId,
          action: "action_proposal.auto_approved",
          entityType: "policy_evaluation",
          entityId: policyResult.evaluationId ?? "unknown",
          details: {
            actionType: data.actionType,
            summary: data.summary,
            amountCents: data.amountCents,
            policyDecision: "allowed",
          },
        });

        // AgentDash: CRM lifecycle — log auto-approved action as CRM activity
        void crmLifecycleService(db).onActionAutoApproved(companyId, {
          actionType: data.actionType,
          summary: data.summary,
          amountCents: data.amountCents,
          agentId,
          crmAccountId: data.crmAccountId ?? null,
          crmContactId: data.crmContactId ?? null,
        }).catch(() => {});

        return {
          status: "auto_approved" as const,
          policyDecision: "allowed" as const,
          evaluationId: policyResult.evaluationId,
          approvalId: null,
        };
      }

      // Escalated or denied → create approval for human review
      const approval = await approvalsSvc.create(companyId, {
        type: "action_proposal",
        requestedByAgentId: agentId,
        requestedByUserId: null,
        status: "pending",
        payload: {
          actionType: data.actionType,
          summary: data.summary,
          amountCents: data.amountCents,
          currency: data.currency ?? "USD",
          confidenceScore: data.confidenceScore,
          evidence: data.evidence,
          policyDecision: policyResult.decision,
          policyDenialReason: policyResult.denialReason,
          escalationThreshold: policyResult.escalationThreshold,
          evaluationId: policyResult.evaluationId,
          matchedPolicyIds: policyResult.matchedPolicyIds,
          crmAccountId: data.crmAccountId,
          crmContactId: data.crmContactId,
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      // Link to issue if provided
      if (data.issueId) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, [data.issueId], {
          agentId,
        });
      }

      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "action_proposal.created",
        entityType: "approval",
        entityId: approval.id,
        details: {
          actionType: data.actionType,
          summary: data.summary,
          amountCents: data.amountCents,
          policyDecision: policyResult.decision,
          issueId: data.issueId,
        },
      });

      return {
        status: "pending_human" as const,
        policyDecision: policyResult.decision,
        evaluationId: policyResult.evaluationId,
        approvalId: approval.id,
      };
    },

    /**
     * List action proposals (approvals with type "action_proposal")
     */
    list: async (companyId: string, opts?: { status?: string }) => {
      const approvals = await approvalsSvc.list(companyId, opts?.status);
      return approvals.filter((a) => a.type === "action_proposal");
    },
  };
}
