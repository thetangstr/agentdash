import type { AgentGovernancePolicy, AgentPolicyViolation } from "@paperclipai/shared";
import { api } from "./client";

export interface AgentGovernanceRecord {
  id: string | null;
  companyId: string;
  agentId: string;
  ownerCeiling: AgentGovernancePolicy;
  stewardRequest: AgentGovernancePolicy;
  effectivePolicy: AgentGovernancePolicy;
  /** Optimistic-concurrency anchor: send back what was last read. */
  revision: number;
  ownerCeilingUpdatedByUserId: string | null;
  stewardRequestUpdatedByUserId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Shape of a 422 body when a request exceeds the owner ceiling. */
export interface AgentPolicyCeilingErrorBody {
  error: string;
  details?: { code?: string; violations?: AgentPolicyViolation[] };
}

export const agentGovernanceApi = {
  get: (companyId: string, agentId: string) =>
    api.get<{ policy: AgentGovernanceRecord }>(
      `/companies/${companyId}/agents/${agentId}/governance`,
    ),
  /** Owner/admin only. */
  updateCeiling: (
    companyId: string,
    agentId: string,
    data: { policy: AgentGovernancePolicy; revision: number; channel?: "web" | "telegram" | "teams" },
  ) =>
    api.put<{ policy: AgentGovernanceRecord }>(
      `/companies/${companyId}/agents/${agentId}/governance/ceiling`,
      data,
    ),
  /** Current steward (or an administrator acting for them). */
  updateRequest: (
    companyId: string,
    agentId: string,
    data: { policy: AgentGovernancePolicy; revision: number; channel?: "web" | "telegram" | "teams" },
  ) =>
    api.put<{ policy: AgentGovernanceRecord }>(
      `/companies/${companyId}/agents/${agentId}/governance/request`,
      data,
    ),
};
