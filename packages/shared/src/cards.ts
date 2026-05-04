// AgentDash: chat substrate typed card payload shapes
import type { AgentAdapterType } from "./constants.js";

export interface ProposalPayload {
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
  role: string;
  name: string;
  adapterType: AgentAdapterType;
  responsibilities: string[];
  kpis: string[];
}

export interface AgentPlanProposalV1Payload {
  rationale: string;
  agents: AgentPlanProposalAgent[];
  alignmentToShortTerm: string;
  alignmentToLongTerm: string;
}
