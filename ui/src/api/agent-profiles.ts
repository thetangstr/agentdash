import type {
  AgentAccessEnforcementMode,
  AgentAccessEnforcementUpdateResult,
  AgentAccessEnforcementView,
  AgentProfileApplicationDto,
  AgentProfileChangePayload,
  AgentProfileDiffEntry,
  AgentProfileRevisionDto,
  AgentProfileRevisionSummary,
  CreateAgentProfileDraft,
  CreateUnboundAgentProfile,
  IssueResponsibilityDto,
  MapIssueResponsibility,
  ProposeAgentProfileRevision,
  ProposeUnboundAgentProfile,
  UnboundAgentProfileProposalResult,
  UnboundAgentProfileSummary,
  UnboundAgentProfileView,
  UpdateAgentProfileDraft,
  WithdrawAgentProfileRevision,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash: Agent Performance Management gate 2 ("people define it").
 *
 * Operating-profile writes, kept apart on purpose:
 * - a draft save writes the draft and nothing else (no approval, no application);
 * - proposing freezes the draft and files an `agent_profile_change` approval;
 * - only an approved, applied revision changes the agent. The UI never applies;
 *   it can only ask the server to resume an application that stopped.
 * The server decides who may do each of these; the UI shows its refusals.
 */

function agentBase(companyId: string, agentId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/profile`;
}

function revisionBase(companyId: string, agentId: string, revisionId: string): string {
  return `${agentBase(companyId, agentId)}/revisions/${encodeURIComponent(revisionId)}`;
}

export const agentProfileQueryKeys = {
  revisions: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "profile", "revisions"] as const,
  diff: (companyId: string, agentId: string, revisionId: string, against: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "profile", "diff", revisionId, against] as const,
  applications: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "profile", "applications"] as const,
  enforcement: (companyId: string) => ["companies", companyId, "agent-access-enforcement"] as const,
};

export interface ProposeAgentProfileResult {
  revision: AgentProfileRevisionDto;
  approvalId: string;
  payload: AgentProfileChangePayload;
}

export interface ResumeAgentProfileApplicationResult {
  application: AgentProfileApplicationDto;
  activated: boolean;
}

export const agentProfilesApi = {
  revisions: (companyId: string, agentId: string) =>
    api.get<AgentProfileRevisionSummary[]>(`${agentBase(companyId, agentId)}/revisions`),
  revision: (companyId: string, agentId: string, revisionId: string) =>
    api.get<AgentProfileRevisionDto>(revisionBase(companyId, agentId, revisionId)),
  /** `against` is `"active"` (the active revision, or derived revision 0) or another revision id. */
  diff: (companyId: string, agentId: string, revisionId: string, against: "active" | string = "active") =>
    api.get<{ against: string; diff: AgentProfileDiffEntry[] }>(
      `${revisionBase(companyId, agentId, revisionId)}/diff?against=${encodeURIComponent(against)}`,
    ),
  /** A plain link target: the browser downloads the Markdown with the session cookie. */
  exportMarkdownUrl: (companyId: string, agentId: string, revisionId: string) =>
    `/api${revisionBase(companyId, agentId, revisionId)}/export.md`,
  /** Create the draft. With no body the server seeds it from the active revision or derived revision 0. */
  createDraft: (companyId: string, agentId: string, input: CreateAgentProfileDraft = {}) =>
    api.post<AgentProfileRevisionDto>(`${agentBase(companyId, agentId)}/revisions`, input),
  /** Save a draft. `ifMatch` is the body hash the editor loaded; a stale one answers 409 with the current draft. */
  saveDraft: (
    companyId: string,
    agentId: string,
    revisionId: string,
    ifMatch: string,
    input: UpdateAgentProfileDraft,
  ) =>
    api.patch<AgentProfileRevisionDto>(revisionBase(companyId, agentId, revisionId), input, {
      "If-Match": `"${ifMatch}"`,
    }),
  propose: (companyId: string, agentId: string, revisionId: string, input: ProposeAgentProfileRevision = {}) =>
    api.post<ProposeAgentProfileResult>(`${revisionBase(companyId, agentId, revisionId)}/propose`, input),
  withdraw: (companyId: string, agentId: string, revisionId: string, input: WithdrawAgentProfileRevision = {}) =>
    api.post<AgentProfileRevisionDto>(`${revisionBase(companyId, agentId, revisionId)}/withdraw`, input),
  applications: (companyId: string, agentId: string) =>
    api.get<AgentProfileApplicationDto[]>(`${agentBase(companyId, agentId)}/applications`),
  /** The approver or an admin; anyone else gets the server's 403. */
  resumeApplication: (companyId: string, agentId: string, applicationId: string) =>
    api.post<ResumeAgentProfileApplicationResult>(
      `${agentBase(companyId, agentId)}/applications/${encodeURIComponent(applicationId)}/resume`,
      {},
    ),
};

/**
 * AgentDash: Agent Performance Management gate 5 (P5.2) — unbound drafts: a
 * profile for a role nobody holds yet (`agentId` null). Board users read
 * them; writing needs `agents:create` (or the performance manager, which is
 * an agent and never uses this UI). The same three separate records as a
 * bound draft:
 * - a save writes the draft and nothing else;
 * - proposing freezes it and files a `hire_agent` approval carrying the
 *   revision. The new agent stays `pending_approval` and never runs;
 * - only a person approving the hire creates the agent and applies the profile.
 */
function unboundBase(companyId: string, profileId?: string): string {
  const base = `/companies/${encodeURIComponent(companyId)}/agent-profiles`;
  return profileId ? `${base}/${encodeURIComponent(profileId)}` : base;
}

function unboundRevisionBase(companyId: string, profileId: string, revisionId: string): string {
  return `${unboundBase(companyId, profileId)}/revisions/${encodeURIComponent(revisionId)}`;
}

export const unboundAgentProfileQueryKeys = {
  list: (companyId: string) => ["companies", companyId, "agent-profiles", "unbound"] as const,
  view: (companyId: string, profileId: string) => ["companies", companyId, "agent-profiles", profileId] as const,
  revision: (companyId: string, profileId: string, revisionId: string) =>
    ["companies", companyId, "agent-profiles", profileId, "revision", revisionId] as const,
};

export const unboundAgentProfilesApi = {
  list: (companyId: string) => api.get<UnboundAgentProfileSummary[]>(unboundBase(companyId)),
  get: (companyId: string, profileId: string) => api.get<UnboundAgentProfileView>(unboundBase(companyId, profileId)),
  revision: (companyId: string, profileId: string, revisionId: string) =>
    api.get<AgentProfileRevisionDto>(unboundRevisionBase(companyId, profileId, revisionId)),
  /** `against` is `"none"` (an empty profile: everything is new) or another revision id. */
  diff: (companyId: string, profileId: string, revisionId: string, against: "none" | string = "none") =>
    api.get<{ against: string; diff: AgentProfileDiffEntry[] }>(
      `${unboundRevisionBase(companyId, profileId, revisionId)}/diff?against=${encodeURIComponent(against)}`,
    ),
  /** A plain link target: the browser downloads the Markdown with the session cookie. */
  exportMarkdownUrl: (companyId: string, profileId: string, revisionId: string) =>
    `/api${unboundRevisionBase(companyId, profileId, revisionId)}/export.md`,
  /** A new unbound profile and its first draft. Hires nobody. */
  create: (companyId: string, input: CreateUnboundAgentProfile) =>
    api.post<AgentProfileRevisionDto>(unboundBase(companyId), input),
  /** A new draft after a rejection or withdrawal; with no body the server seeds it from the newest revision. */
  createDraft: (companyId: string, profileId: string, input: CreateAgentProfileDraft = {}) =>
    api.post<AgentProfileRevisionDto>(`${unboundBase(companyId, profileId)}/revisions`, input),
  /** Save a draft. `ifMatch` is the body hash the editor loaded; a stale one answers 409 with the current draft. */
  saveDraft: (companyId: string, profileId: string, revisionId: string, ifMatch: string, input: UpdateAgentProfileDraft) =>
    api.patch<AgentProfileRevisionDto>(unboundRevisionBase(companyId, profileId, revisionId), input, {
      "If-Match": `"${ifMatch}"`,
    }),
  /** Request hire: files `hire_agent` with this revision. Nothing is hired or started until a person approves it. */
  propose: (companyId: string, profileId: string, revisionId: string, input: ProposeUnboundAgentProfile = {}) =>
    api.post<UnboundAgentProfileProposalResult>(`${unboundRevisionBase(companyId, profileId, revisionId)}/propose`, input),
  withdraw: (companyId: string, profileId: string, revisionId: string, input: WithdrawAgentProfileRevision = {}) =>
    api.post<AgentProfileRevisionDto>(`${unboundRevisionBase(companyId, profileId, revisionId)}/withdraw`, input),
};

/**
 * `GET/PATCH /api/companies/:companyId/agent-access-enforcement` — members
 * read, admins set one of `selectableModes` (`off` or `shadow` in gate 2).
 * Both answer `{ companyId, mode, selectableModes }`; the PATCH adds
 * `changed` and `previousMode`.
 */
export const agentAccessEnforcementApi = {
  get: (companyId: string) =>
    api.get<AgentAccessEnforcementView>(`/companies/${encodeURIComponent(companyId)}/agent-access-enforcement`),
  set: (companyId: string, mode: AgentAccessEnforcementMode) =>
    api.patch<AgentAccessEnforcementUpdateResult>(
      `/companies/${encodeURIComponent(companyId)}/agent-access-enforcement`,
      { mode },
    ),
};

/** Responsibility mapping (evaluation LLD §5.2): which responsibility an issue's work belongs to. */
export const issueResponsibilityApi = {
  get: (companyId: string, issueId: string) =>
    api.get<{ current: IssueResponsibilityDto | null; history: IssueResponsibilityDto[] }>(
      `/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/responsibility`,
    ),
  map: (companyId: string, issueId: string, input: MapIssueResponsibility) =>
    api.post<IssueResponsibilityDto>(
      `/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/responsibility`,
      input,
    ),
};
