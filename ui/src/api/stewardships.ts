import type { Agent, AgentStewardship, HumanChannelBinding } from "@paperclipai/shared";
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
  expiresAt: string | null;
  /** Null when no agent requested the approval (budget incidents, human-created). */
  requestingAgent: { id: string; name: string; role: string } | null;
  sourceIssues: Array<{ id: string; identifier: string; title: string; status: string }>;
  risk: { level: "high" | "medium" | "low"; reason: string };
  effectiveAuthority: {
    steward: { userId: string; since: string } | null;
    minimumApproval: string | null;
  };
  decisionHistory: {
    decidedAt: string | null;
    decidedByUserId: string | null;
    decisionChannel: string | null;
    decisionActorRole: string | null;
    overrideReason: string | null;
    supersededAt: string | null;
  };
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
  /**
   * Pair a person with an agent they will look after.
   *
   * Refused with 409 when either side already has an active stewardship — one
   * human, one agent, per workspace — so callers should check `getMyAgent`
   * first rather than treating the conflict as an error to swallow.
   */
  pair: (companyId: string, agentId: string, userId: string) =>
    api.post<AgentStewardship>(`/companies/${companyId}/agent-stewardships`, {
      agentId,
      userId,
    }),
  /**
   * `status` defaults to `open` on the server — what a decision surface needs.
   * Pass `all` when the caller has to scope tabs that render decided work;
   * scoping those against an open-only set would erase resolved items rather
   * than scope them.
   */
  getMyInbox: (companyId: string, status?: "open" | "all") =>
    api.get<PersonalInboxResponse>(
      `/companies/${companyId}/me/inbox${status ? `?status=${status}` : ""}`,
    ),
  getOverrideInbox: (companyId: string) =>
    api.get<{ items: InboxItem[] }>(`/companies/${companyId}/inbox/override`),

  /** The caller's own channel bindings. Identity comes from the session. */
  listMyChannels: (companyId: string) =>
    api.get<{ bindings: HumanChannelBinding[] }>(`/companies/${companyId}/me/channels`),

  /**
   * Mint a Telegram pairing link. Returns the deep link only — the raw token is
   * never exposed to the client, so it cannot end up somewhere the link itself
   * would not reach.
   */
  startPairing: (companyId: string, provider: "telegram" | "whatsapp") =>
    api.post<{ deepLink: string; expiresAt: string }>(
      `/companies/${companyId}/me/channels/${provider}/pairing`,
      {},
    ),

  revokeChannel: (companyId: string, bindingId: string) =>
    api.post<{ binding: HumanChannelBinding }>(
      `/companies/${companyId}/channel-bindings/${bindingId}/revoke`,
      {},
    ),
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
