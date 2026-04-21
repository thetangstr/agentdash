import type { Goal } from "@agentdash/shared";
import { api } from "./client";

// AgentDash: Goal hub rollup shape (AGE-40). Mirrors server
// GoalHubRollup in server/src/services/goals-hub.ts.
export interface GoalHubAgentSummary {
  agentId: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  budgetMonthlyCents: number;
  spendMonthlyCents: number;
  linkedAt: string;
}

export interface GoalHubPlanSummary {
  id: string;
  archetype: string;
  status: string;
  rationale: string | null;
  decisionNote: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  proposedByUserId: string | null;
  approvedByUserId: string | null;
  createdAt: string;
}

export interface GoalHubWorkSummary {
  openIssueCount: number;
  issuesByStatus: Record<string, number>;
  activeRoutineCount: number;
  routinesByStatus: Record<string, number>;
  activePipelineCount: number;
  pipelinesByStatus: Record<string, number>;
}

export interface GoalHubSpendSummary {
  windowStart: string;
  windowEnd: string;
  spendCents: number;
  revenueCents: number;
  netCents: number;
  budgetCents: number | null;
  budgetPolicyId: string | null;
  percentOfBudget: number | null;
}

export interface GoalHubKpiRow {
  metric: string;
  baseline: number;
  target: number;
  current: number;
  unit: string;
  horizonDays: number;
  deltaToTarget: number;
  progressPercent: number;
  onTrack: boolean;
}

export interface GoalHubActivityEntry {
  id: string;
  kind: "activity_log" | "heartbeat_run";
  occurredAt: string;
  summary: string;
  actorType?: string;
  actorId?: string;
  agentId?: string | null;
  entityType?: string;
  entityId?: string;
  status?: string;
}

export interface GoalHubRollup {
  goal: Goal;
  plan: GoalHubPlanSummary | null;
  agents: GoalHubAgentSummary[];
  work: GoalHubWorkSummary;
  spend: GoalHubSpendSummary;
  kpis: GoalHubKpiRow[];
  activity: GoalHubActivityEntry[];
}

export const goalsApi = {
  list: (companyId: string) => api.get<Goal[]>(`/companies/${companyId}/goals`),
  get: (id: string) => api.get<Goal>(`/goals/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
  // AgentDash: Goal hub rollup (AGE-40)
  getHub: (companyId: string, goalId: string) =>
    api.get<GoalHubRollup>(`/companies/${companyId}/goals/${goalId}/hub`),
};
