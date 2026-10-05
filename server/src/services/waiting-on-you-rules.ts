// AgentDash: UX-3 (#784) — the scoping and ranking rules behind "waiting on
// you", as a leaf module so both the digest and waiting-on-you.ts import it
// without a cycle. See waiting-on-you.ts for the definition in words.
import { APPROVAL_RISK_ORDER, summarizeApprovalRisk } from "./approval-risk.js";

export type AssistantDecision = "approve" | "reject" | "request_changes";

/** Statuses where a human decision is still possible. */
export const WAITING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

export function hireApprovalCreatesAgent(approval: {
  type: string;
  status?: string | null;
  payload: unknown;
}): boolean {
  if (approval.type !== "hire_agent") return false;
  // WAITING_APPROVAL_STATUSES is the same pending/revision_requested set the
  // gated-actions service checks against DECIDABLE_STATUSES — kept local so
  // this module stays a leaf.
  if (!(WAITING_APPROVAL_STATUSES as readonly string[]).includes(approval.status ?? "")) return false;
  const payload =
    typeof approval.payload === "object" && approval.payload !== null
      ? (approval.payload as Record<string, unknown>)
      : {};
  return typeof payload.agentId !== "string";
}

/**
 * The one source of truth for "what does yes/no do" wording — the assistant's
 * confirm read-back and the Decisions page row both render these strings, so
 * a consequence can never be described two ways. Lives in this leaf module so
 * consumers do not import the whole gated-actions service for it.
 */
export function effectsFor(
  approval: { type: string; status?: string | null; payload: unknown },
  decision: AssistantDecision,
): string[] {
  if (decision === "request_changes") {
    return ["The request goes back to whoever asked, with your note — nothing is approved."];
  }
  if (decision === "reject") {
    return approval.type === "hire_agent" && !hireApprovalCreatesAgent(approval)
      ? ["The hire is refused and the proposed agent is terminated."]
      : ["The request is rejected and does not proceed."];
  }
  if (approval.type === "hire_agent") {
    return hireApprovalCreatesAgent(approval)
      ? ["The hire is approved and the new agent is created on the requested adapter."]
      : ["The hire is approved and the agent becomes active."];
  }
  return ["The request is approved and whatever it was gating proceeds."];
}

/** Human phrasing for an approval kind — one clause, payload stays out. */
export const APPROVAL_KIND_PHRASES: Record<string, string> = {
  hire_agent: "hire a new agent",
  approve_issue: "close out a task",
  send_email: "send an email",
  connector_send: "send a message through a connector",
  environment_provision: "provision an environment",
  // The type budgets.ts actually files; "budget_override" was a dead key.
  budget_override_required: "approve spending past a budget limit",
};

/**
 * AgentDash (c4-hire-ux): the ask clause for a Decisions row. A hire whose
 * payload names the hire reads "hire Bea as Bookkeeper" — the human title,
 * never the role slug — instead of the generic "hire a new agent". Every
 * other kind keeps the one-clause phrase above.
 */
export function approvalAskPhrase(approval: { type: string; payload: unknown }): string {
  const payload =
    typeof approval.payload === "object" && approval.payload !== null
      ? (approval.payload as Record<string, unknown>)
      : {};
  if (approval.type === "hire_agent") {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    if (name) return title ? `hire ${name} as ${title}` : `hire ${name}`;
  }
  return APPROVAL_KIND_PHRASES[approval.type] ?? `act on "${approval.type}"`;
}

export type WaitingApprovalLike = {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  createdAt: Date;
};

/**
 * AgentDash: UX-7 (#788) — what a yes and a no do, in person words, for the
 * Decisions page row. The wording is `effectsFor` from the gated-actions
 * service (GH #679 / #780): the assistant's confirm read-back and this row
 * must describe the same consequence, so there is exactly one function. A
 * wrong consequence invented here would be decided on as fact.
 */
export function decisionConsequences(approval: {
  type: string;
  status?: string | null;
  payload: unknown;
}): { approve: string; reject: string } {
  return {
    approve: effectsFor(approval, "approve")[0]!,
    reject: effectsFor(approval, "reject")[0]!,
  };
}

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
