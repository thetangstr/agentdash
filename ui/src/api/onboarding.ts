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
  /** Absent for an autonomous hire, which gets no key a person could carry (scan 3, lane H). */
  apiKey?: { id: string; name: string; token: string; createdAt: string };
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

export interface CompleteInitialAssessmentResponse {
  companyId: string;
  cosAgentId: string;
  conversationId: string;
  redirectUrl: string;
}

export interface MemberOnboardingSession {
  id: string;
  companyId: string;
  companyName: string;
  issuePrefix: string;
  status: "in_progress" | "completed";
  currentStep: "welcome" | "workspace";
  completedAt: string | null;
  updatedAt: string;
}

// AgentDash (#725): the Hermes provider step on a hosted box.
export type HermesProviderId = "zai" | "openrouter" | "anthropic" | "openai";

export interface HermesProviderOption {
  provider: HermesProviderId;
  label: string;
  defaultModel: string;
  keyHint: string;
}

export interface AdapterStatusResponse {
  status: { adapter: string; ready: boolean; preset: string; reason: string | null };
  hermesProvider?: {
    required: boolean;
    configured: boolean;
    provider: HermesProviderId | null;
    model: string | null;
    configuredAt: string | null;
    canConfigure: boolean;
    options: HermesProviderOption[];
  };
}

// AgentDash (one onboarding path): the keyless local runtimes a self-hosted
// founder picks at /setup. The server's preset menu also has key-bearing
// entries; the first run offers only the local runtimes.
export type LocalRuntimePreset = "claude_code" | "codex" | "hermes";

export interface SetupAdapterResponse {
  status: AdapterStatusResponse["status"];
  applied: string[];
  persisted: boolean;
  persistError: string | null;
}

export interface SetupHermesProviderResponse {
  hermesProvider: { configured: true; provider: HermesProviderId; label: string; model: string };
  profilesUpdated: number;
}

// AgentDash (GH #794, UX-13): who can fix a missing model key. The server
// deliberately omits emails — members only need names; the notification
// itself is sent by the request-model-key route.
export interface ModelKeyAdmin {
  userId: string;
  name: string | null;
  membershipRole: string | null;
  /** Instance admin — the person the setup route actually lets through. */
  canFix: boolean;
}

export interface ModelKeyRequestResult {
  name: string | null;
  status: "sent" | "skipped" | "failed" | string;
}

export const onboardingApi = {
  adapterStatus: () => api.get<AdapterStatusResponse>("/onboarding/adapter-status"),
  setupHermesProvider: (input: {
    companyId: string;
    provider: HermesProviderId;
    apiKey: string;
    model?: string;
  }) =>
    api.post<SetupHermesProviderResponse>("/onboarding/setup-adapter", { preset: "hermes", ...input }),
  setupAdapter: (preset: LocalRuntimePreset) =>
    api.post<SetupAdapterResponse>("/onboarding/setup-adapter", { preset }),
  modelKeyAdmins: (companyId: string) =>
    api.get<{ admins: ModelKeyAdmin[] }>(
      `/onboarding/model-key-admins?companyId=${encodeURIComponent(companyId)}`,
    ),
  requestModelKey: (companyId: string) =>
    api.post<{ results: ModelKeyRequestResult[] }>("/onboarding/request-model-key", { companyId }),
  listMemberSessions: () =>
    api.get<MemberOnboardingSession[]>("/onboarding/member-sessions"),
  advanceMemberSession: (
    companyId: string,
    currentStep: MemberOnboardingSession["currentStep"],
  ) =>
    api.patch<MemberOnboardingSession>(
      `/onboarding/member-sessions/${companyId}`,
      { currentStep },
    ),
  completeMemberSession: (companyId: string) =>
    api.post<MemberOnboardingSession>(
      `/onboarding/member-sessions/${companyId}/complete`,
      {},
    ),
  // companyId: the selected workspace; the server uses it only when the user is
  // an active member (a second workspace made by "New Company").
  bootstrap: (companyId?: string | null) =>
    api.post<BootstrapResponse>("/onboarding/bootstrap", companyId ? { companyId } : {}),
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
  completeInitialAssessment: (input: {
    companyId: string;
    assessmentMarkdown: string;
    assessmentInput: Record<string, unknown>;
  }) =>
    api.post<CompleteInitialAssessmentResponse>(
      "/onboarding/complete-initial-assessment",
      input,
    ),
};
