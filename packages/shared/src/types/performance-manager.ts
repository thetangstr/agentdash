/**
 * AgentDash: Agent Performance Management gate 4 (P4.1) — the performance
 * manager (overview LLD §4.3; doc/plans/2026-10-29-apm-gate4-5-build-spec.md).
 *
 * The performance manager is advisory only. It reads agent cards (its own
 * per-viewer projection), drafts and proposes profile changes with evidence,
 * and files recommendations. It never approves, applies, changes access or
 * edits an active profile; a "pause" recommendation pauses nothing.
 */

import type { AgentStatus } from "../constants.js";

/** Where the effective manager comes from. */
export const PERFORMANCE_MANAGER_SOURCES = ["designated", "chief_of_staff", "none"] as const;
export type PerformanceManagerSource = (typeof PERFORMANCE_MANAGER_SOURCES)[number];

export interface PerformanceManagerAgentRef {
  agentId: string;
  name: string;
  role: string;
  status: AgentStatus | string;
}

/** `GET /api/companies/:companyId/performance-manager`. */
export interface PerformanceManagerView {
  kind: "performance_manager";
  companyId: string;
  /** `companies.performance_manager_agent_id`; null = the Chief of Staff default. */
  designatedAgentId: string | null;
  designated: PerformanceManagerAgentRef | null;
  /**
   * The agent that acts as performance manager now: the designated agent when
   * it is not terminated; with no designation, the company's earliest-created
   * non-terminated Chief of Staff. A designated agent that was terminated
   * leaves the company with none (never a silent fall-back).
   */
  effective: PerformanceManagerAgentRef | null;
  source: PerformanceManagerSource;
  /** What the caller may do: `PATCH` is company admins only. */
  viewer: { canChange: boolean };
}

/** `PATCH /api/companies/:companyId/performance-manager` result. */
export interface PerformanceManagerUpdateResult extends PerformanceManagerView {
  changed: boolean;
  previousDesignatedAgentId: string | null;
}

// ---------------------------------------------------------------------------
// Recommendations (advisory; ledger event `evaluation.agent_recommendation`)
// ---------------------------------------------------------------------------

export const AGENT_RECOMMENDATION_KINDS = ["continue", "narrow", "repair", "pause", "gather_evidence"] as const;
export type AgentRecommendationKind = (typeof AGENT_RECOMMENDATION_KINDS)[number];

export const AGENT_RECOMMENDATION_EVIDENCE_KINDS = ["card", "event", "case"] as const;
export type AgentRecommendationEvidenceKind = (typeof AGENT_RECOMMENDATION_EVIDENCE_KINDS)[number];

export const AGENT_RECOMMENDATION_DECISIONS = ["accepted", "declined"] as const;
export type AgentRecommendationDecisionValue = (typeof AGENT_RECOMMENDATION_DECISIONS)[number];

/**
 * One cited piece of evidence. `card`: a stored card version of the agent
 * (`"3"`); `event`: a ledger event id the manager can read; `case`: a
 * drill-down case id as the cases route returned it.
 */
export interface AgentRecommendationEvidence {
  kind: AgentRecommendationEvidenceKind;
  ref: string;
}

export interface AgentRecommendationDecision {
  decision: AgentRecommendationDecisionValue;
  note: string | null;
  decidedByUserId: string;
  decidedAt: string;
  eventId: string;
}

export interface AgentRecommendationDto {
  /** Stable id (the ledger events' source id). */
  id: string;
  companyId: string;
  /** The agent the recommendation is about. */
  agentId: string;
  kind: AgentRecommendationKind;
  reason: string;
  evidence: AgentRecommendationEvidence[];
  /** An `agent_profile_change` approval the recommendation goes with, if any. */
  proposalApprovalId: string | null;
  recommendedByAgentId: string;
  recommendedAt: string;
  /** The `evaluation.agent_recommendation` ledger event. */
  eventId: string;
  /** Always true: a recommendation changes nothing by itself. */
  advisory: true;
  decision: AgentRecommendationDecision | null;
}

/** `GET .../evaluation/agents/:agentId/recommendations`, newest first. */
export interface AgentRecommendationList {
  agentId: string;
  recommendations: AgentRecommendationDto[];
  /** True whenever some recommendation could be hidden from this viewer by its access class. */
  restricted: boolean;
  /**
   * What the caller may do, from the decision route's own guard (a person
   * who is the agent's accountable person or a company admin). The route's
   * refusal is still the answer.
   */
  viewer: { canDecide: boolean };
}

/** `POST .../recommendations/:id/decision` result. */
export interface AgentRecommendationDecisionResult {
  recommendation: AgentRecommendationDto;
  /** Recording a decision changes nothing else: an accepted "pause" does not pause the agent. */
  effect: "none";
  next: string;
}

// ---------------------------------------------------------------------------
// The manager's own record (descriptive; no causal claim, no score)
// ---------------------------------------------------------------------------

export type PerformanceManagerProposalOutcome = "pending" | "approved" | "rejected" | "withdrawn" | "applied" | "application_failed" | "refused_stale";

export interface PerformanceManagerProposalItem {
  approvalId: string;
  agentId: string;
  agentName: string | null;
  revisionId: string;
  revisionNumber: number;
  filedAt: string;
  /** The approval's status (`pending`, `approved`, `rejected`, `cancelled`, `revision_requested`). */
  approvalStatus: string;
  outcome: PerformanceManagerProposalOutcome;
  /** A person saved the draft before it was proposed, so the decision was on an owner-edited version. */
  editedByOwnerBeforeDeciding: boolean;
  decidedAt: string | null;
  affectedResponsibilities: string[];
}

/** One responsibility's card sections at one stored version, as the viewer may read them. */
export interface PerformanceManagerSectionSnapshot {
  cardVersion: number;
  storedAt: string;
  obligations:
    | { visibility: "visible" | "partial"; rows: Array<{ profileRevisionId: string | null; owed: number | null; byEndState: Record<string, number>; deliveredItemCount: number }> }
    | { visibility: "not_visible"; note: string };
  quality:
    | { visibility: "visible" | "partial"; criteria: Array<{ criterionId: string; text: string; items: number; byJudge: Record<string, { pass: number; fail: number; unknown: number }> }> }
    | { visibility: "not_visible"; note: string };
  delivered: { visibility: "visible" | "partial"; items: number } | { visibility: "not_visible"; note: string };
}

export interface PerformanceManagerAppliedItem {
  approvalId: string;
  agentId: string;
  agentName: string | null;
  revisionId: string;
  appliedAt: string;
  affectedResponsibilities: string[];
  /** The last stored card version before application and the first after; null when none was stored. */
  before: { version: number; storedAt: string } | null;
  after: { version: number; storedAt: string } | null;
  sections: Array<{
    responsibilityKey: string;
    before: PerformanceManagerSectionSnapshot | null;
    after: PerformanceManagerSectionSnapshot | null;
  }>;
}

export interface PerformanceManagerRecommendationTally {
  total: number;
  accepted: number;
  declined: number;
  undecided: number;
}

/** One recommendation the manager filed, as the viewer may read it. */
export interface PerformanceManagerRecommendationItem {
  /** The recommendation id (as on the agent's recommendations list). */
  id: string;
  /** The agent it is about. */
  agentId: string;
  agentName: string | null;
  kind: AgentRecommendationKind;
  /** When it was filed. */
  at: string;
  decision: AgentRecommendationDecisionValue | null;
  decidedAt: string | null;
}

/** `GET /api/companies/:companyId/evaluation/performance-manager/record`. */
export interface PerformanceManagerRecord {
  kind: "performance_manager_record";
  companyId: string;
  /** The agent whose record this is (the effective manager unless `?agentId=` named another). */
  managerAgentId: string | null;
  managerName: string | null;
  /** Whether that agent is the effective performance manager now. */
  isEffectiveManager: boolean;
  generatedAt: string;
  proposals: {
    filed: number;
    pending: number;
    approved: number;
    rejected: number;
    withdrawn: number;
    editedByOwnerBeforeDeciding: number;
    applied: number;
    items: PerformanceManagerProposalItem[];
  };
  recommendations: {
    total: number;
    byKind: Record<AgentRecommendationKind, PerformanceManagerRecommendationTally>;
    /** Each one, oldest first (the tallies count these). */
    items: PerformanceManagerRecommendationItem[];
  };
  applied: PerformanceManagerAppliedItem[];
  /** True whenever something could be hidden from this viewer (agent visibility or access class). */
  restricted: boolean;
  /** Plain words: the before/after is descriptive only. */
  note: string;
}
