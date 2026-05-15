// AgentDash: onboarding v2 API client
import { api } from "./client";
import type { ProposalPayload } from "@paperclipai/shared";

export interface BootstrapResponse {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
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

export interface CreatedInvite {
  id: string;
  email: string;
  invitePath: string;
  inviteUrl: string;
  expiresAt: string;
  /** Result of the optional Resend send. "skipped" when RESEND_API_KEY is unset. */
  emailStatus: "sent" | "skipped" | "failed";
}

export interface InvitesResponse {
  inviteIds: string[];
  invites: CreatedInvite[];
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
  // Phase D: read the latest agent_plan_proposal_v1 card and materialize the
  // agents server-side. Returns the new company-id + new agent ids.
  confirmPlan: (input: { conversationId: string }) =>
    api.post<{ companyId: string; createdAgentIds: string[] }>(
      "/onboarding/confirm-plan",
      input,
    ),
  // #210: Phase F revision loop — server posts the revised plan card via
  // postMessage (clients receive it over WS) and returns the new card's
  // payload + message ID for the caller's convenience.
  revisePlan: (input: { conversationId: string; revisionText: string }) =>
    api.post<{ cardMessageId: string | null; plan: unknown }>(
      "/onboarding/revise-plan",
      input,
    ),
  // AgentDash (Phase F): the SPA calls this when the deep-interview engine
  // emits its `[deep-interview-ready]` marker on `/assess?onboarding=1`. The
  // server crystallizes the spec, advances the CoS phase, and returns the
  // URL the SPA should redirect to. Idempotent on `stateId`.
  finalizeAssessment: (stateId: string) =>
    api.post<{ specId: string; conversationId: string; redirectUrl: string }>(
      "/onboarding/finalize-assessment",
      { stateId },
    ),
};
