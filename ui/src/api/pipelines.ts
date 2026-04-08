import { api } from "./client";
import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  PipelineDefaults,
} from "@agentdash/shared";

// AgentDash: Pipeline API client

export interface Pipeline {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: PipelineStageDefinition[];
  edges: PipelineEdgeDefinition[];
  executionMode: string;
  defaults: PipelineDefaults | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  companyId: string;
  status: string;
  executionMode: string;
  activeStageIds: string[];
  inputData: Record<string, unknown> | null;
  outputData: Record<string, unknown> | null;
  totalCostUsd: string;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface StageExecution {
  id: string;
  pipelineRunId: string;
  stageId: string;
  status: string;
  inputState: unknown;
  outputState: Record<string, unknown> | null;
  costUsd: string;
  selfHealAttempts: number;
  selfHealLog: unknown[];
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PipelineRunWithStages extends PipelineRun {
  stages: StageExecution[];
}

export const pipelinesApi = {
  list: (companyId: string) =>
    api.get<Pipeline[]>(`/companies/${companyId}/pipelines`),

  get: (companyId: string, pipelineId: string) =>
    api.get<Pipeline>(`/companies/${companyId}/pipelines/${pipelineId}`),

  create: (
    companyId: string,
    data: {
      name: string;
      description?: string;
      stages: PipelineStageDefinition[];
      edges?: PipelineEdgeDefinition[];
      executionMode?: string;
      defaults?: PipelineDefaults;
    },
  ) => api.post<Pipeline>(`/companies/${companyId}/pipelines`, data),

  update: (companyId: string, pipelineId: string, data: Partial<Pipeline>) =>
    api.patch<Pipeline>(
      `/companies/${companyId}/pipelines/${pipelineId}`,
      data,
    ),

  delete: (companyId: string, pipelineId: string) =>
    api.delete<Pipeline>(
      `/companies/${companyId}/pipelines/${pipelineId}`,
    ),

  listRuns: (companyId: string, pipelineId: string) =>
    api.get<PipelineRun[]>(
      `/companies/${companyId}/pipelines/${pipelineId}/runs`,
    ),

  startRun: (
    companyId: string,
    pipelineId: string,
    data?: {
      inputData?: Record<string, unknown>;
      executionMode?: string;
    },
  ) =>
    api.post<PipelineRun>(
      `/companies/${companyId}/pipelines/${pipelineId}/runs`,
      data ?? {},
    ),

  getRun: (companyId: string, runId: string) =>
    api.get<PipelineRunWithStages>(
      `/companies/${companyId}/pipeline-runs/${runId}`,
    ),

  cancelRun: (companyId: string, runId: string) =>
    api.post<PipelineRun>(
      `/companies/${companyId}/pipeline-runs/${runId}/cancel`,
      {},
    ),

  hitlDecide: (
    companyId: string,
    runId: string,
    stageId: string,
    decision: "approved" | "rejected",
    notes?: string,
  ) =>
    api.post(
      `/companies/${companyId}/pipeline-runs/${runId}/stages/${stageId}/decide`,
      { decision, notes },
    ),
};
