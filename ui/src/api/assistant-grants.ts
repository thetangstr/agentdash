import { api } from "./client";

/**
 * AgentDash assistant MCP (GH #677): a person's OAuth connections to
 * assistant clients — what they consented to, in this company, revocable here.
 * Mirrors the bridge endpoints API shape (`me/` = own connections only).
 */
export interface AssistantGrant {
  id: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
}

export const assistantGrantsApi = {
  listMine: (companyId: string) =>
    api.get<{ grants: AssistantGrant[] }>(`/companies/${companyId}/me/assistant-grants`),

  revoke: (companyId: string, grantId: string) =>
    api.post<{ revoked: boolean; grantId: string }>(
      `/companies/${companyId}/me/assistant-grants/${grantId}/revoke`,
      {},
    ),
};
