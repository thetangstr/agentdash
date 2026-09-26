// AgentDash: UX-3 (#784) — the scoping and ranking rules behind "waiting on
// you", as a leaf module so both the digest and waiting-on-you.ts import it
// without a cycle. See waiting-on-you.ts for the definition in words.
import { APPROVAL_RISK_ORDER, summarizeApprovalRisk } from "./approval-risk.js";

/** Statuses where a human decision is still possible. */
export const WAITING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

/** Human phrasing for an approval kind — one clause, payload stays out. */
export const APPROVAL_KIND_PHRASES: Record<string, string> = {
  hire_agent: "hire a new agent",
  approve_issue: "close out a task",
  send_email: "send an email",
  connector_send: "send a message through a connector",
  environment_provision: "provision an environment",
  budget_override: "change a budget",
};

export type WaitingApprovalLike = {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  requestedByAgentId: string | null;
  createdAt: Date;
};

/**
 * Scope open approvals to the person's audience and rank them. Pure, so the
 * digest (which queries approvals itself) and the pending-decisions list rank
 * and scope identically.
 */
export function scopeAndRankOpenApprovals<T extends WaitingApprovalLike>(rows: T[], audienceAgentIds: Set<string>) {
  return rows
    .filter((row) => (WAITING_APPROVAL_STATUSES as readonly string[]).includes(row.status))
    // Agentless approvals are board-filed — an admin can still decide them,
    // so they belong in the list rather than silently dropped.
    .filter((row) => !row.requestedByAgentId || audienceAgentIds.has(row.requestedByAgentId))
    .map((approval) => ({ approval, risk: summarizeApprovalRisk(approval.type, approval.payload as never) }))
    .sort((a, b) => {
      const byRisk = APPROVAL_RISK_ORDER[a.risk.level] - APPROVAL_RISK_ORDER[b.risk.level];
      if (byRisk !== 0) return byRisk;
      return (a.approval.createdAt?.getTime?.() ?? 0) - (b.approval.createdAt?.getTime?.() ?? 0);
    });
}
