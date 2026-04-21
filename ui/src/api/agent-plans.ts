// AgentDash (AGE-48 Phase 2): API client for agent plans. Mirrors
// server/src/routes/agent-plans.ts. Only surfaces the methods the hub
// approval UI needs — list/get/approve/reject/updateProposal. The assistant
// and onboarding flows hit the server routes directly.

import type {
  AgentTeamPlanPayload,
  UpdateAgentPlanProposal,
} from "@agentdash/shared";
import { api } from "./client";

// Mirrors the PlanRow shape returned by `agent_plans` list/get/approve/reject.
// We keep this permissive — the hub only reads a subset and falls back to
// `proposalPayload` for details.
export interface AgentPlanRow {
  id: string;
  companyId: string;
  goalId: string;
  status: "proposed" | "approved" | "rejected" | "expanded";
  archetype: string;
  rationale: string | null;
  proposalPayload: AgentTeamPlanPayload | null;
  decisionNote: string | null;
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApproveAgentPlanResult {
  plan: AgentPlanRow;
  createdAgentIds: string[];
}

export const agentPlansApi = {
  list: (
    companyId: string,
    filters: { goalId?: string; status?: AgentPlanRow["status"] } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.goalId) params.set("goalId", filters.goalId);
    if (filters.status) params.set("status", filters.status);
    const qs = params.toString();
    return api.get<AgentPlanRow[]>(
      `/companies/${companyId}/agent-plans${qs ? `?${qs}` : ""}`,
    );
  },
  get: (companyId: string, id: string) =>
    api.get<AgentPlanRow>(`/companies/${companyId}/agent-plans/${id}`),
  approve: (companyId: string, id: string, decisionNote?: string) =>
    api.post<ApproveAgentPlanResult>(
      `/companies/${companyId}/agent-plans/${id}/approve`,
      decisionNote ? { decisionNote } : {},
    ),
  reject: (companyId: string, id: string, decisionNote: string) =>
    api.post<AgentPlanRow>(
      `/companies/${companyId}/agent-plans/${id}/reject`,
      { decisionNote },
    ),
  // AgentDash (AGE-48 Phase 2): editor-drawer PATCH. The server merges the
  // partial payload into the stored proposalPayload while the plan is still
  // in `status='proposed'`; approved/rejected plans 422 on PATCH.
  updateProposal: (
    companyId: string,
    id: string,
    patch: UpdateAgentPlanProposal,
  ) => api.patch<AgentPlanRow>(`/companies/${companyId}/agent-plans/${id}`, patch),
};
