import type { AgentProfileRevisionSummary, AgentRecommendationKind, PerformanceManagerProposalOutcome } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

// AgentDash: Agent Performance Management gate 4 (P4.2) — wording and small
// pieces the performance-manager surfaces share: the settings control, the
// Performance tab's recommendations, the "proposed by the performance
// manager" marks in revision history and the approval renderer, and the
// manager's record. The manager is advisory: every sentence here says what it
// may do (read cards, recommend, propose) and what it never does.

/** The one explanation of the role, used wherever the manager is named. */
export const PERFORMANCE_MANAGER_ADVISORY_TEXT =
  "The performance manager only recommends and proposes. It never approves, applies, changes an agent's access or edits an active profile. A person decides every proposal.";

export const PROPOSED_BY_MANAGER_TEXT = "Proposed by the performance manager";

/** How each recommendation kind reads. A recommendation changes nothing by itself. */
export const RECOMMENDATION_KIND_TEXT: Record<AgentRecommendationKind, string> = {
  continue: "Recommends continuing as it is",
  narrow: "Recommends narrowing its work",
  repair: "Recommends a repair",
  pause: "Recommends pausing — the agent keeps running until you pause it",
  gather_evidence: "Recommends gathering more evidence",
};

/** A short name for a kind, for tallies. */
export const RECOMMENDATION_KIND_SHORT_TEXT: Record<AgentRecommendationKind, string> = {
  continue: "Continue",
  narrow: "Narrow",
  repair: "Repair",
  pause: "Pause (advisory)",
  gather_evidence: "Gather evidence",
};

export const PROPOSAL_OUTCOME_TEXT: Record<PerformanceManagerProposalOutcome, string> = {
  pending: "Waiting for a decision",
  approved: "Approved, not applied yet",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  applied: "Approved and applied",
  application_failed: "Approved; applying it failed",
  refused_stale: "Approved; out of date when applied",
};

/** True when an `agent_profile_change` payload says the company's performance manager filed it. */
export function isManagerFiledPayload(payload: unknown): boolean {
  const proposedBy = (payload as { proposedBy?: { kind?: unknown; capacity?: unknown } } | null | undefined)?.proposedBy;
  return proposedBy?.kind === "agent" && proposedBy.capacity === "performance_manager";
}

/** The text mark. Always words, never colour alone. */
export function ManagerFiledBadge({ testId = "agent-pm-manager-filed" }: { testId?: string }) {
  return (
    <Badge variant="secondary" className="whitespace-normal text-left" data-testid={testId}>
      {PROPOSED_BY_MANAGER_TEXT}
    </Badge>
  );
}

/**
 * True when the server says the company's performance manager filed this
 * revision's proposal (`proposedByCapacity`, read from its approval's
 * payload), so no approval is fetched to mark it.
 */
export function isManagerFiledRevision(revision: Pick<AgentProfileRevisionSummary, "proposedByCapacity">): boolean {
  return revision.proposedByCapacity === "performance_manager";
}
