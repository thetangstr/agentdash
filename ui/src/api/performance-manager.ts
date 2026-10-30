import type {
  AgentRecommendationDecisionResult,
  AgentRecommendationList,
  DecideAgentRecommendation,
  PerformanceManagerRecord,
  PerformanceManagerUpdateResult,
  PerformanceManagerView,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash: Agent Performance Management gate 4 (P4.2) — the performance
 * manager (overview LLD §4.3; doc/plans/2026-10-29-apm-gate4-5-build-spec.md).
 *
 * The performance manager is advisory: it reads agent cards, files
 * profile-change proposals and recommendations, and never approves, applies,
 * changes access or edits an active profile. These calls read the
 * designation, set it (company admins), list an agent's recommendations,
 * record a person's decision on one, and read the manager's own record. The
 * server decides who may do each; the UI shows its refusals.
 */

function companyBase(companyId: string): string {
  return `/companies/${encodeURIComponent(companyId)}`;
}

function recommendationsPath(companyId: string, agentId: string): string {
  return `${companyBase(companyId)}/evaluation/agents/${encodeURIComponent(agentId)}/recommendations`;
}

export const performanceManagerQueryKeys = {
  designation: (companyId: string) => ["companies", companyId, "performance-manager"] as const,
  recommendations: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "recommendations"] as const,
  record: (companyId: string, managerAgentId: string | null) =>
    ["evaluation", companyId, "performance-manager", "record", managerAgentId ?? "effective"] as const,
};

export const performanceManagerApi = {
  /** Any principal of the company: the designation, the manager acting now, and whether the caller may change it. */
  get: (companyId: string) => api.get<PerformanceManagerView>(`${companyBase(companyId)}/performance-manager`),
  /** Company admins only. `null` returns to the Chief of Staff default. */
  set: (companyId: string, agentId: string | null) =>
    api.patch<PerformanceManagerUpdateResult>(`${companyBase(companyId)}/performance-manager`, { agentId }),
  /** People who can see the agent (and the manager itself). Newest first; advisory only. `viewer.canDecide` runs the decision route's guard. */
  recommendations: (companyId: string, agentId: string) =>
    api.get<AgentRecommendationList>(recommendationsPath(companyId, agentId)),
  /** The agent's accountable person or a company admin. Recording a decision changes nothing else. */
  decide: (companyId: string, agentId: string, recommendationId: string, body: DecideAgentRecommendation) =>
    api.post<AgentRecommendationDecisionResult>(
      `${recommendationsPath(companyId, agentId)}/${encodeURIComponent(recommendationId)}/decision`,
      body,
    ),
  /** The manager's record (the effective manager's, or `managerAgentId`'s). Descriptive only: no causal claim, no score. */
  record: (companyId: string, managerAgentId: string | null = null) =>
    api.get<PerformanceManagerRecord>(
      `${companyBase(companyId)}/evaluation/performance-manager/record${
        managerAgentId ? `?agentId=${encodeURIComponent(managerAgentId)}` : ""
      }`,
    ),
};
