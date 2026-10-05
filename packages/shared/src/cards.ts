// AgentDash: chat substrate typed card payload shapes
import type { AgentAdapterType } from "./constants.js";

export interface ProposalPayload {
  workforceTemplateId?: "marketing-content" | "sales-support";
  name: string;
  role: string;
  oneLineOkr: string;
  rationale: string;
  /**
   * AgentDash (c4-model-tiers): stamped server-side on the echoed hire card
   * so the UI can show the hire's model tier in plain words. Absent on
   * payloads generated before the tier feature.
   */
  adapterType?: AgentAdapterType;
  /**
   * AgentDash (review-1028): stamped server-side with the resolved tier and
   * model this instance would apply (`enabled` tiers only), so the card
   * renders what the server computed — env overrides included — rather than
   * re-deriving it from the shipped defaults. Absent when the tiers are
   * off, and the card then looks exactly like a pre-tier card.
   */
  modelTier?: "high" | "low";
  model?: string;
}

export interface InvitePromptPayload {
  companyId: string;
  conversationId: string;
}

export interface AgentStatusPayload {
  agentId: string;
  agentName: string;
  summary: string;
  severity: "info" | "warn" | "blocked";
}

export interface InterviewQuestionPayload {
  question: string;
  fixedIndex?: number;
}

// CoS-led onboarding (Phase C) — concrete plan card emitted after goals capture.
// See docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md.
export interface AgentPlanProposalAgent {
  workforceTemplateId?: "marketing-content" | "sales-support";
  role: string;
  name: string;
  /**
   * AgentDash (scan 4, lane N): the role title exactly as the CoS wrote it
   * ("Month-End Close Coordinator", "Client Onboarding & Process Builder").
   * `role` stays the slug that maps onto AGENT_ROLES; this is what people see.
   */
  title?: string;
  adapterType: AgentAdapterType;
  /**
   * AgentDash (review-1028): stamped server-side with the resolved tier and
   * model this instance would apply, like `ProposalPayload.modelTier` —
   * present only while the tiers are enabled on the instance that wrote
   * the card.
   */
  modelTier?: "high" | "low";
  model?: string;
  responsibilities: string[];
  kpis: string[];
}

export interface AgentPlanProposalV1Payload {
  rationale: string;
  agents: AgentPlanProposalAgent[];
  alignmentToShortTerm: string;
  alignmentToLongTerm: string;
  /**
   * AgentDash (scan 4, lane N): set by /onboarding/confirm-plan once the team
   * is hired, so the card shows "Team hired" instead of a live "Set it up".
   */
  confirmedAt?: string;
  confirmedAgentIds?: string[];
  /**
   * AgentDash (review-1025 item 2): set by /onboarding/confirm-plan alongside
   * confirmedAt when the hires were filed for board approval instead of
   * activated — the card says "Sent for approval", not "Team hired", even
   * after a reload. The approval service clears it once every hire approval
   * has been decided.
   */
  pendingApproval?: boolean;
  /**
   * AgentDash (cos-followups-2 item 4): set by the approval service when a
   * hire approval on this plan is rejected — the card says "Not approved"
   * instead of going back to "Team hired".
   */
  approvalRejected?: boolean;
  /**
   * AgentDash (review-1019): steady-state hire cards stamp who asked for the
   * team; /confirm-plan refuses anyone else, matching task-card behaviour.
   * Absent on onboarding cards, which stay confirmable by any member.
   */
  requesterUserId?: string;
}
