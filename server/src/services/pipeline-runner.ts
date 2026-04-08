import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  PipelineDefaults,
  StateEnvelope,
} from "@agentdash/shared";
import { evaluateCondition } from "./pipeline-condition-evaluator.js";

// AgentDash: Pipeline runner — core DAG execution engine

export function findEntryStages(
  stages: PipelineStageDefinition[],
  edges: PipelineEdgeDefinition[],
): string[] {
  const hasIncoming = new Set(edges.map((e) => e.toStageId));
  return stages.filter((s) => !hasIncoming.has(s.id)).map((s) => s.id);
}

export function findNextStages(
  completedStageId: string,
  edges: PipelineEdgeDefinition[],
  outputData: Record<string, unknown>,
): string[] {
  return edges
    .filter((e) => e.fromStageId === completedStageId)
    .filter((e) => evaluateCondition(e.condition, outputData))
    .map((e) => e.toStageId);
}

export function buildStateEnvelope(params: {
  pipelineRunId: string;
  pipelineId: string;
  sourceStageId: string | null;
  data: Record<string, unknown>;
  stageIndex: number;
  totalStages: number;
  executionMode: "sync" | "async";
  accumulatedCostUsd: number;
}): StateEnvelope {
  return {
    pipelineRunId: params.pipelineRunId,
    sourceStageId: params.sourceStageId,
    data: params.data,
    metadata: {
      pipelineId: params.pipelineId,
      stageIndex: params.stageIndex,
      totalStages: params.totalStages,
      executionMode: params.executionMode,
      accumulatedCostUsd: params.accumulatedCostUsd,
    },
  };
}

export function applyStateMapping(
  source: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mapping) return { ...source };
  const result: Record<string, unknown> = {};
  for (const [targetKey, sourceKey] of Object.entries(mapping)) {
    result[targetKey] = source[sourceKey];
  }
  return result;
}

export function getStageById(
  stages: PipelineStageDefinition[],
  stageId: string,
): PipelineStageDefinition | undefined {
  return stages.find((s) => s.id === stageId);
}

export function getIncomingEdges(
  stageId: string,
  edges: PipelineEdgeDefinition[],
): PipelineEdgeDefinition[] {
  return edges.filter((e) => e.toStageId === stageId);
}

export function isMergeReady(
  mergeStageId: string,
  edges: PipelineEdgeDefinition[],
  completedStageIds: Set<string>,
  strategy: "all" | "any",
): boolean {
  const incoming = getIncomingEdges(mergeStageId, edges);
  if (incoming.length === 0) return true;
  if (strategy === "any") {
    return incoming.some((e) => completedStageIds.has(e.fromStageId));
  }
  return incoming.every((e) => completedStageIds.has(e.fromStageId));
}

export function getEffectiveTimeout(
  stage: PipelineStageDefinition,
  defaults: PipelineDefaults | null,
): number {
  if (stage.type === "hitl_gate") {
    return (stage.hitlTimeoutHours ?? defaults?.hitlTimeoutHours ?? 72) * 60;
  }
  return stage.timeoutMinutes ?? defaults?.stageTimeoutMinutes ?? 30;
}

export function getEffectiveMaxRetries(
  stage: PipelineStageDefinition,
  defaults: PipelineDefaults | null,
): number {
  return stage.maxRetries ?? defaults?.maxSelfHealRetries ?? 3;
}
