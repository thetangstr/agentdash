import type { AgentMemory, AgentMemoryHistory } from "@paperclipai/shared";
import { api } from "./client";

/**
 * An agent's durable memory. Readable only by the agent itself, its steward
 * and company/instance admins; everyone else gets 404.
 */
export const agentMemoryApi = {
  get: (companyId: string, agentId: string) =>
    api.get<{ memory: AgentMemory | null }>(`/companies/${companyId}/agents/${agentId}/memory`),
  history: (companyId: string, agentId: string) =>
    api.get<AgentMemoryHistory>(`/companies/${companyId}/agents/${agentId}/memory/history`),
};
