import type { Agent, AgentStewardship } from "@paperclipai/shared";
import { api } from "./client";

export interface MyAgentResponse {
  stewardship: AgentStewardship | null;
  agent: Agent | null;
}

export interface InboxItem {
  approvalId: string;
  type: string;
  status: string;
  /** Must be echoed back on any decision in an agentdash_mk company. */
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decisionChannel: string | null;
  decisionActorRole: string | null;
  requestingAgent: { id: string; name: string; role: string };
  /** True only in the owner/admin override view. */
  requiresOverride: boolean;
}

export interface PersonalInboxResponse {
  stewardedAgent: { id: string; name: string; role: string; status: string } | null;
  items: InboxItem[];
}

export const stewardshipsApi = {
  /** The signed-in user's own agent. The server derives identity from the session. */
  getMyAgent: (companyId: string) => api.get<MyAgentResponse>(`/companies/${companyId}/me/agent`),
  getMyInbox: (companyId: string) =>
    api.get<PersonalInboxResponse>(`/companies/${companyId}/me/inbox`),
  getOverrideInbox: (companyId: string) =>
    api.get<{ items: InboxItem[] }>(`/companies/${companyId}/inbox/override`),
  getAgentStewardship: (companyId: string, agentId: string) =>
    api.get<{ stewardship: AgentStewardship | null }>(
      `/companies/${companyId}/agents/${agentId}/stewardship`,
    ),
  getAgentStewardshipHistory: (companyId: string, agentId: string) =>
    api.get<{ stewardships: AgentStewardship[] }>(
      `/companies/${companyId}/agents/${agentId}/stewardship/history`,
    ),
  assign: (companyId: string, data: { agentId: string; userId: string }) =>
    api.post<{ stewardship: AgentStewardship }>(`/companies/${companyId}/agent-stewardships`, data),
  transfer: (companyId: string, agentId: string, data: { userId: string; transferReason?: string | null }) =>
    api.post<{ stewardship: AgentStewardship }>(
      `/companies/${companyId}/agents/${agentId}/stewardship/transfer`,
      data,
    ),
};
