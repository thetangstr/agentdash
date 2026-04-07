import { api } from "./client";

export interface InboxItem {
  id: string;
  type: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface InboxCount {
  count: number;
}

export const inboxApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      agentId?: string;
      limit?: number;
      offset?: number;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return api.get<InboxItem[]>(
      `/companies/${companyId}/inbox${qs ? `?${qs}` : ""}`,
    );
  },
  count: (companyId: string) =>
    api.get<InboxCount>(`/companies/${companyId}/inbox/count`),
  detail: (companyId: string, actionId: string) =>
    api.get<InboxItem>(`/companies/${companyId}/inbox/${actionId}`),
  approve: (companyId: string, actionId: string, decisionNote?: string) =>
    api.post(`/companies/${companyId}/inbox/${actionId}/approve`, {
      decisionNote,
    }),
  reject: (companyId: string, actionId: string, reason: string) =>
    api.post(`/companies/${companyId}/inbox/${actionId}/reject`, { reason }),
};
