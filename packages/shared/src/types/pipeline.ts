// AgentDash: Pipeline orchestrator types

export interface PipelineStageDefinition {
  id: string;
  name: string;
  type: "agent" | "hitl_gate" | "merge";
  agentId?: string;
  scopedInstruction: string;
  stateMapping?: Record<string, string>;
  timeoutMinutes?: number;
  maxRetries?: number;
  mergeStrategy?: "all" | "any";
  mergeTimeout?: number;
  hitlInstructions?: string;
  hitlTimeoutHours?: number;
  modelTier?: "small" | null;
}

export interface PipelineEdgeDefinition {
  id: string;
  fromStageId: string;
  toStageId: string;
  condition?: string;
}

export interface PipelineDefaults {
  stageTimeoutMinutes: number;
  hitlTimeoutHours: number;
  maxSelfHealRetries: number;
  budgetCapUsd?: number;
}

export interface StateEnvelope {
  pipelineRunId: string;
  sourceStageId: string | null;
  data: Record<string, unknown>;
  metadata: {
    pipelineId: string;
    stageIndex: number;
    totalStages: number;
    executionMode: "sync" | "async";
    accumulatedCostUsd: number;
  };
}

export interface SelfHealEntry {
  attempt: number;
  diagnosis: string;
  adjustedInstruction: string;
  outcome: "retried" | "failed";
  timestamp: string;
}

export interface PipelineWithCounts {
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
  runCount?: number;
  lastRunStatus?: string;
}
