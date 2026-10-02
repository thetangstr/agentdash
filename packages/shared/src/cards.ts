// AgentDash: chat substrate typed card payload shapes
import type { AgentAdapterType } from "./constants.js";

export interface ProposalPayload {
  workforceTemplateId?: "marketing-content" | "sales-support";
  name: string;
  role: string;
  oneLineOkr: string;
  rationale: string;
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
}
