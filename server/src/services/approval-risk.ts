/**
 * AgentDash-MK: the coarse risk band that orders a human's attention.
 *
 * Extracted from the MK inbox route so the board's decision surface and the
 * steward inbox digest rank the same approval the same way. Two copies of a
 * ranking drift silently: nobody notices until the two surfaces disagree about
 * what is urgent, and by then each has its own users who trust it.
 *
 * This is NOT an authorization input, and must never become one. It decides
 * what a person sees first, and nothing about what they may do —
 * `approvalAuthorityService` is the only thing that answers that.
 */
export type ApprovalRiskLevel = "high" | "medium" | "low";

export interface ApprovalRisk {
  level: ApprovalRiskLevel;
  reason: string;
}

/** Ranking order for the digest: high first, then medium, then low. */
export const APPROVAL_RISK_ORDER: Record<ApprovalRiskLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function summarizeApprovalRisk(type: string, payload: unknown): ApprovalRisk {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (type === "hire_agent") {
    return { level: "high", reason: "Creates or changes an agent" };
  }
  if (type === "budget_override_required") {
    return { level: "high", reason: "Raises a spend limit" };
  }
  if (type === "mandate_violation") {
    return { level: "high", reason: "Mandate violation" };
  }
  if (typeof record.destructive === "boolean" && record.destructive) {
    return { level: "high", reason: "Destructive action" };
  }
  return { level: "medium", reason: "Governed action" };
}
