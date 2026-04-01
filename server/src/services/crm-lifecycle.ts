import { and, eq, desc } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  crmAccounts,
  crmActivities,
  crmDeals,
  issues,
} from "@agentdash/db";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

// AgentDash: CRM Lifecycle Service
// Handles automatic CRM updates when agent workflows produce outcomes.
// All hooks are fire-and-forget (void + catch) — CRM updates should never
// block the primary workflow.

export function crmLifecycleService(db: Db) {
  // ---------------------------------------------------------------------------
  // Hook 1: Pipeline stage completed → CRM activity
  // ---------------------------------------------------------------------------

  async function onPipelineStageCompleted(
    companyId: string,
    opts: {
      pipelineName: string;
      stageName: string;
      stageIndex: number;
      totalStages: number;
      issueId: string;
      agentId?: string | null;
      crmAccountId?: string | null;
      pipelineRunId: string;
    },
  ) {
    if (!opts.crmAccountId) return;

    await db.insert(crmActivities).values({
      companyId,
      accountId: opts.crmAccountId,
      activityType: "pipeline_stage_completed",
      subject: `[${opts.pipelineName}] Stage ${opts.stageIndex + 1}/${opts.totalStages}: ${opts.stageName} completed`,
      body: `Agent completed pipeline stage "${opts.stageName}" (${opts.stageIndex + 1} of ${opts.totalStages}). Issue: ${opts.issueId}. Run: ${opts.pipelineRunId}.`,
      performedByAgentId: opts.agentId ?? null,
      occurredAt: new Date(),
      metadata: {
        source: "agentdash_pipeline",
        pipelineRunId: opts.pipelineRunId,
        stageIndex: opts.stageIndex,
        stageName: opts.stageName,
        issueId: opts.issueId,
      },
    });

    logger.info({
      companyId,
      crmAccountId: opts.crmAccountId,
      pipelineName: opts.pipelineName,
      stageName: opts.stageName,
    }, "CRM activity created for pipeline stage completion");
  }

  // ---------------------------------------------------------------------------
  // Hook 2: Pipeline run completed → CRM activity + deal stage advance
  // ---------------------------------------------------------------------------

  async function onPipelineRunCompleted(
    companyId: string,
    opts: {
      pipelineName: string;
      pipelineRunId: string;
      totalStages: number;
      crmAccountId?: string | null;
      triggerIssueId?: string | null;
    },
  ) {
    if (!opts.crmAccountId) return;

    // Log completion activity
    await db.insert(crmActivities).values({
      companyId,
      accountId: opts.crmAccountId,
      activityType: "pipeline_completed",
      subject: `[${opts.pipelineName}] Pipeline completed (${opts.totalStages} stages)`,
      body: `All ${opts.totalStages} stages of pipeline "${opts.pipelineName}" completed successfully. Run: ${opts.pipelineRunId}.`,
      occurredAt: new Date(),
      metadata: {
        source: "agentdash_pipeline",
        pipelineRunId: opts.pipelineRunId,
        totalStages: opts.totalStages,
      },
    });

    logger.info({
      companyId,
      crmAccountId: opts.crmAccountId,
      pipelineName: opts.pipelineName,
    }, "CRM activity created for pipeline run completion");
  }

  // ---------------------------------------------------------------------------
  // Hook 3: Action proposal resolved → CRM activity
  // ---------------------------------------------------------------------------

  async function onActionProposalResolved(
    companyId: string,
    opts: {
      approvalId: string;
      approvalStatus: string; // "approved" | "rejected"
      actionType: string;
      summary: string;
      amountCents?: number;
      agentId?: string | null;
      crmAccountId?: string | null;
      crmContactId?: string | null;
      decisionNote?: string | null;
    },
  ) {
    if (!opts.crmAccountId) return;

    const action = opts.approvalStatus === "approved" ? "approved" : "rejected";
    const amountStr = opts.amountCents != null ? ` ($${(opts.amountCents / 100).toFixed(2)})` : "";

    await db.insert(crmActivities).values({
      companyId,
      accountId: opts.crmAccountId,
      contactId: opts.crmContactId ?? null,
      activityType: `action_${action}`,
      subject: `${opts.actionType}${amountStr} ${action}`,
      body: [
        opts.summary,
        opts.decisionNote ? `Decision: ${opts.decisionNote}` : null,
        `Approval: ${opts.approvalId}`,
      ].filter(Boolean).join("\n"),
      performedByAgentId: opts.agentId ?? null,
      occurredAt: new Date(),
      metadata: {
        source: "agentdash_action_proposal",
        approvalId: opts.approvalId,
        actionType: opts.actionType,
        amountCents: opts.amountCents,
        approvalStatus: opts.approvalStatus,
      },
    });

    logger.info({
      companyId,
      crmAccountId: opts.crmAccountId,
      actionType: opts.actionType,
      approvalStatus: opts.approvalStatus,
    }, "CRM activity created for action proposal resolution");
  }

  // ---------------------------------------------------------------------------
  // Hook 4: Issue completed → advance linked deal stage
  // ---------------------------------------------------------------------------

  // Deal stage progression map (configurable per company in the future)
  const DEAL_STAGE_PROGRESSION: Record<string, string> = {
    "qualification": "proposal",
    "qualificationstage": "propositionstage",
    "proposal": "negotiation",
    "propositionstage": "negotiationfinalevaluation",
    "negotiation": "closed_won",
    "negotiationfinalevaluation": "closedwon",
    // Do not auto-advance from closed stages
  };

  async function onIssueCompleted(
    companyId: string,
    issueId: string,
    opts: {
      agentId?: string | null;
    },
  ) {
    // Check if any deals are linked to this issue
    const linkedDeals = await db.select().from(crmDeals)
      .where(and(
        eq(crmDeals.companyId, companyId),
        eq(crmDeals.linkedIssueId, issueId),
      ));

    if (linkedDeals.length === 0) return;

    for (const deal of linkedDeals) {
      const currentStage = deal.stage ?? "";
      const nextStage = DEAL_STAGE_PROGRESSION[currentStage.toLowerCase()];

      // Log the completion activity on the deal
      await db.insert(crmActivities).values({
        companyId,
        accountId: deal.accountId ?? null,
        dealId: deal.id,
        activityType: "linked_issue_completed",
        subject: `Linked issue completed`,
        body: `Issue ${issueId} linked to deal "${deal.name}" was completed.${nextStage ? ` Deal stage advanced: ${currentStage} → ${nextStage}.` : ""}`,
        performedByAgentId: opts.agentId ?? null,
        occurredAt: new Date(),
        metadata: {
          source: "agentdash_issue_completion",
          issueId,
          dealId: deal.id,
          previousStage: currentStage,
          newStage: nextStage ?? currentStage,
        },
      });

      // Advance the deal stage if there's a next stage
      if (nextStage) {
        await db.update(crmDeals)
          .set({ stage: nextStage, updatedAt: new Date() })
          .where(eq(crmDeals.id, deal.id));

        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "crm-lifecycle",
          action: "crm.deal_stage_advanced",
          entityType: "crm_deal",
          entityId: deal.id,
          details: {
            dealName: deal.name,
            previousStage: currentStage,
            newStage: nextStage,
            triggerIssueId: issueId,
          },
        });

        logger.info({
          companyId,
          dealId: deal.id,
          dealName: deal.name,
          previousStage: currentStage,
          newStage: nextStage,
        }, "Deal stage auto-advanced on linked issue completion");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Hook 5: Issue completed → update account stage (CRM-linked issues)
  // ---------------------------------------------------------------------------

  async function onIssueCompletedForAccount(
    companyId: string,
    issueId: string,
    crmAccountId: string,
    opts: { agentId?: string | null },
  ) {
    // Log activity on the account
    await db.insert(crmActivities).values({
      companyId,
      accountId: crmAccountId,
      activityType: "issue_resolved",
      subject: "Agent resolved customer issue",
      body: `Issue ${issueId} linked to this account was completed by an agent.`,
      performedByAgentId: opts.agentId ?? null,
      occurredAt: new Date(),
      metadata: {
        source: "agentdash_issue_completion",
        issueId,
      },
    });

    // Check if we should update the account lifecycle stage
    // Count recent resolved issues in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const account = await db.select().from(crmAccounts)
      .where(eq(crmAccounts.id, crmAccountId))
      .then((r) => r[0] ?? null);
    if (!account) return;

    // Only auto-advance accounts in early stages
    const currentStage = account.stage?.toLowerCase() ?? "";
    if (["churned", "customer", "champion"].includes(currentStage)) return;

    // Count completed CRM-linked issues for this account
    const completedIssues = await db.select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.crmAccountId, crmAccountId),
        eq(issues.status, "done"),
      ));

    const count = completedIssues.length;

    // Stage progression based on completed issue count
    let newStage: string | null = null;
    if (count >= 10 && currentStage !== "champion") {
      newStage = "champion";
    } else if (count >= 5 && !["champion", "customer"].includes(currentStage)) {
      newStage = "customer";
    } else if (count >= 1 && !["champion", "customer", "active"].includes(currentStage)) {
      newStage = "active";
    }

    if (newStage && newStage !== currentStage) {
      await db.update(crmAccounts)
        .set({ stage: newStage, updatedAt: new Date() })
        .where(eq(crmAccounts.id, crmAccountId));

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "crm-lifecycle",
        action: "crm.account_stage_advanced",
        entityType: "crm_account",
        entityId: crmAccountId,
        details: {
          accountName: account.name,
          previousStage: currentStage,
          newStage,
          completedIssueCount: count,
        },
      });

      logger.info({
        companyId,
        crmAccountId,
        previousStage: currentStage,
        newStage,
        completedIssueCount: count,
      }, "Account stage auto-advanced based on issue completions");
    }
  }

  // ---------------------------------------------------------------------------
  // Hook 6: Auto-create CRM activity (used by auto-approved proposals)
  // ---------------------------------------------------------------------------

  async function onActionAutoApproved(
    companyId: string,
    opts: {
      actionType: string;
      summary: string;
      amountCents?: number;
      agentId?: string | null;
      crmAccountId?: string | null;
      crmContactId?: string | null;
    },
  ) {
    if (!opts.crmAccountId) return;

    const amountStr = opts.amountCents != null ? ` ($${(opts.amountCents / 100).toFixed(2)})` : "";

    await db.insert(crmActivities).values({
      companyId,
      accountId: opts.crmAccountId,
      contactId: opts.crmContactId ?? null,
      activityType: `action_auto_approved`,
      subject: `${opts.actionType}${amountStr} auto-approved`,
      body: opts.summary,
      performedByAgentId: opts.agentId ?? null,
      occurredAt: new Date(),
      metadata: {
        source: "agentdash_action_proposal",
        actionType: opts.actionType,
        amountCents: opts.amountCents,
        autoApproved: true,
      },
    });
  }

  return {
    onPipelineStageCompleted,
    onPipelineRunCompleted,
    onActionProposalResolved,
    onIssueCompleted,
    onIssueCompletedForAccount,
    onActionAutoApproved,
  };
}
