// AgentDash: onboarding v2 API client
import { api } from "./client";
import type { ProposalPayload } from "@paperclipai/shared";

export interface BootstrapResponse {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
  firstMessage: string;
}

export interface InterviewTurnResponse {
  assistantMessage: string | null;
  state: {
    fixedQuestionsAsked: number;
    followUpsAsked: number;
    status: "in_progress" | "ready_to_propose" | "exceeded_max";
  };
}

export interface ConfirmResponse {
  agent: { id: string; name: string; title: string };
  apiKey: { id: string; name: string; token: string; createdAt: string };
  proposal: ProposalPayload;
}

export interface InvitesResponse {
  inviteIds: string[];
  errors: Array<{ email: string; reason: string }>;
}

export const onboardingApi = {
  bootstrap: () => api.post<BootstrapResponse>("/onboarding/bootstrap", {}),
  interviewTurn: (input: {
    conversationId: string;
    userMessage: string;
    companyId: string;
    cosAgentId: string;
  }) => api.post<InterviewTurnResponse>("/onboarding/interview/turn", input),
  confirmAgent: (input: {
    conversationId: string;
    reportsToAgentId: string;
    companyId: string;
  }) => api.post<ConfirmResponse>("/onboarding/agent/confirm", input),
  sendInvites: (input: {
    conversationId: string;
    companyId: string;
    emails: string[];
  }) => api.post<InvitesResponse>("/onboarding/invites", input),
  rejectAgent: (input: {
    conversationId: string;
    cosAgentId: string;
    reason?: string;
  }) => api.post<{ ok: true }>("/onboarding/agent/reject", input),
};
