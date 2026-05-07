// AgentDash: goals-eval-hitl
// HTTP wrappers for the Phase D verdict / coverage / DoD / metric / feature-flag
// endpoints. Follows the same shape as the other ui/src/api/*.ts modules:
// thin functions that delegate to the shared `api` client.
import type {
  CreateVerdictInput,
  DefinitionOfDone,
  GoalMetricDefinition,
  VerdictEntityType,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CoverageBreakdownRow {
  projectId: string | null;
  totalInFlight: number;
  coveredInFlight: number;
  coverageRatio: number;
}

export interface CoverageResult {
  totalInFlight: number;
  coveredInFlight: number;
  coverageRatio: number;
  byProject?: CoverageBreakdownRow[];
}

export interface VerdictRow {
  id: string;
  companyId: string;
  entityType: VerdictEntityType;
  goalId: string | null;
  projectId: string | null;
  issueId: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  outcome: string;
  rubricScores: Record<string, unknown> | null;
  justification: string | null;
  createdAt: string;
}

export interface ReviewTimelineRow {
  source: "execution_decision" | "verdict";
  rowId: string;
  createdAt: string;
  outcome: string;
  body: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  rubricScores: Record<string, unknown> | null;
}

export interface FeatureFlagRow {
  companyId: string;
  flagKey: string;
  enabled: boolean;
  updatedAt: string;
}

export const goalsEvalHitlApi = {
  fetchCoverage: (companyId: string, breakdown?: boolean) => {
    const qs = breakdown ? "?breakdown=true" : "";
    return api.get<CoverageResult>(`/companies/${companyId}/coverage${qs}`);
  },
  fetchReviewTimeline: (companyId: string, issueId: string) =>
    api.get<ReviewTimelineRow[]>(
      `/companies/${companyId}/issues/${issueId}/review-timeline`,
    ),
  listVerdicts: (companyId: string, entityType: VerdictEntityType, entityId: string) => {
    const params = new URLSearchParams({ entityType, entityId });
    return api.get<VerdictRow[]>(`/companies/${companyId}/verdicts?${params.toString()}`);
  },
  createVerdict: (input: CreateVerdictInput) =>
    api.post<VerdictRow>(`/companies/${input.companyId}/verdicts`, input),
  listFeatureFlags: (companyId: string) =>
    api.get<FeatureFlagRow[]>(`/companies/${companyId}/feature-flags`),
  getFeatureFlag: (companyId: string, flagKey: string) =>
    api.get<FeatureFlagRow>(`/companies/${companyId}/feature-flags/${flagKey}`),
  setFeatureFlag: (companyId: string, flagKey: string, enabled: boolean) =>
    api.put<FeatureFlagRow>(`/companies/${companyId}/feature-flags/${flagKey}`, { enabled }),
  setGoalMetricDefinition: (companyId: string, goalId: string, def: GoalMetricDefinition) =>
    api.put<{ id: string; metricDefinition: GoalMetricDefinition }>(
      `/companies/${companyId}/goals/${goalId}/metric-definition`,
      def,
    ),
  setProjectDoD: (companyId: string, projectId: string, dod: DefinitionOfDone) =>
    api.put<{ id: string; definitionOfDone: DefinitionOfDone }>(
      `/companies/${companyId}/projects/${projectId}/dod`,
      dod,
    ),
  setIssueDoD: (companyId: string, issueId: string, dod: DefinitionOfDone) =>
    api.put<{ id: string; definitionOfDone: DefinitionOfDone }>(
      `/companies/${companyId}/issues/${issueId}/dod`,
      dod,
    ),
};

// Stable query keys for tanstack-query consumers.
export const goalsEvalHitlQueryKeys = {
  coverage: (companyId: string, breakdown?: boolean) =>
    ["goals-eval-hitl", "coverage", companyId, breakdown ?? false] as const,
  reviewTimeline: (companyId: string, issueId: string) =>
    ["goals-eval-hitl", "review-timeline", companyId, issueId] as const,
  verdicts: (companyId: string, entityType: VerdictEntityType, entityId: string) =>
    ["goals-eval-hitl", "verdicts", companyId, entityType, entityId] as const,
  featureFlags: (companyId: string) =>
    ["goals-eval-hitl", "feature-flags", companyId] as const,
};
