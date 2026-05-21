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

export type CosPilotAccessMode = "read_only" | "draft_only" | "human_approved";
export type CosPilotAccessStatus = "not_connected" | "requested" | "available";

export interface CosPilotAccessGrant {
  system: string;
  purpose: string;
  mode: CosPilotAccessMode;
  status: CosPilotAccessStatus;
}

export interface CosPilotDelegationContractV1 {
  stakeholders: string[];
  goals: string[];
  preferences: string[];
  access: CosPilotAccessGrant[];
  operatingBoundaries: {
    canDo: string[];
    requiresApproval: string[];
    neverDo: string[];
  };
  telemetry: string[];
}

export interface CosPilotSuccessMetric {
  label: string;
  target: string;
}

export interface CosPilotWorkstream {
  id: string;
  title: string;
  outcome: string;
  weeklySteps: string[];
}

export interface CosPilotPlanV1 {
  durationDays: number;
  projectName: string;
  heartbeatCadence: string;
  successMetrics: CosPilotSuccessMetric[];
  workstreams: CosPilotWorkstream[];
  approvalGates: string[];
}

export interface CosPilotProposalV1Payload {
  rationale: string;
  delegationContract: CosPilotDelegationContractV1;
  pilotPlan: CosPilotPlanV1;
}
