// AgentDash: Assistant API client
import { api } from "./client";

export interface Conversation {
  id: string;
  companyId: string;
  userId: string;
  title: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  createdAt: string;
}

export const assistantApi = {
  chat: (companyId: string, message: string, conversationId?: string) => {
    return fetch(`/api/companies/${companyId}/assistant/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ message, conversationId }),
    });
  },

  listConversations: (companyId: string) =>
    api.get<Conversation[]>(`/companies/${companyId}/assistant/conversations`),

  getMessages: (companyId: string, conversationId: string) =>
    api.get<ChatMessage[]>(`/companies/${companyId}/assistant/conversations/${conversationId}/messages`),
};
