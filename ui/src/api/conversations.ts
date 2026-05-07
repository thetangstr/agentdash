// AgentDash: chat substrate API client
import { api } from "./client";

export interface Conversation {
  id: string;
  companyId: string;
  userId: string;
  assistantAgentId?: string | null;
  title?: string | null;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  authorKind?: "user" | "agent";
  role?: "user" | "agent"; // upstream column name
  authorId?: string;
  body?: string;
  content?: string; // upstream column name
  cardKind?: string | null;
  cardPayload?: Record<string, unknown> | null;
  createdAt: string;
}

export const conversationsApi = {
  companyInbox: (companyId: string) =>
    api.get<Conversation>(`/conversations/companies/${companyId}/inbox`),
  paginate: (id: string, opts: { before?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<Message[]>(`/conversations/${id}/messages${qs ? `?${qs}` : ""}`);
  },
  post: (id: string, body: string, companyId: string) =>
    api.post<Message>(`/conversations/${id}/messages`, { body, companyId }),
  read: (id: string, lastReadMessageId: string) =>
    api.patch(`/conversations/${id}/read`, { lastReadMessageId }),
  participants: (id: string) => api.get(`/conversations/${id}/participants`),
};
