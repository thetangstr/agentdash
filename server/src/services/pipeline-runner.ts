import { eq, and } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agentPipelines, pipelineRuns, pipelineStageExecutions } from "@agentdash/db";
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

// AgentDash: Pipeline runner service — advances pipeline runs through DAG stages
export function pipelineRunnerService(db: Db) {
  const svc = {
    // Start a pipeline run by launching entry stages
    async startRun(runId: string) {
      const [run] = await db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId));
      if (!run) throw new Error("Run not found");

      const [pipeline] = await db
        .select()
        .from(agentPipelines)
        .where(eq(agentPipelines.id, run.pipelineId));
      if (!pipeline) throw new Error("Pipeline not found");

      const stages = pipeline.stages as PipelineStageDefinition[];
      const edges = (pipeline.edges ?? []) as PipelineEdgeDefinition[];
      const entryStageIds = findEntryStages(stages, edges);

      if (entryStageIds.length === 0) {
        throw new Error("Pipeline has no entry stages");
      }

      // Mark run as running
      await db
        .update(pipelineRuns)
        .set({
          status: "running",
          activeStageIds: entryStageIds,
          startedAt: new Date(),
        })
        .where(eq(pipelineRuns.id, runId));

      // Create stage executions for entry stages
      const initialEnvelope = buildStateEnvelope({
        pipelineRunId: runId,
        pipelineId: pipeline.id,
        sourceStageId: null,
        data: (run.inputData as Record<string, unknown>) ?? {},
        stageIndex: 0,
        totalStages: stages.length,
        executionMode: run.executionMode as "sync" | "async",
        accumulatedCostUsd: 0,
      });

      for (const stageId of entryStageIds) {
        const stage = getStageById(stages, stageId);
        if (!stage) continue;

        const mapped = applyStateMapping(initialEnvelope.data, stage.stateMapping);
        const stageEnvelope = { ...initialEnvelope, data: mapped };

        await db.insert(pipelineStageExecutions).values({
          pipelineRunId: runId,
          stageId,
          inputState: stageEnvelope as any,
          status: "pending",
        });
      }

      return { runId, entryStageIds };
    },

    // Called when a stage completes — advances the DAG
    async onStageCompleted(
      runId: string,
      stageId: string,
      outputData: Record<string, unknown>,
      costUsd: number,
    ) {
      const [run] = await db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId));
      if (!run || run.status !== "running") return;

      const [pipeline] = await db
        .select()
        .from(agentPipelines)
        .where(eq(agentPipelines.id, run.pipelineId));
      if (!pipeline) return;

      const stages = pipeline.stages as PipelineStageDefinition[];
      const edges = (pipeline.edges ?? []) as PipelineEdgeDefinition[];
      const defaults = pipeline.defaults as PipelineDefaults | null;

      // Update stage execution as completed
      const stageExecs = await db
        .select()
        .from(pipelineStageExecutions)
        .where(
          and(
            eq(pipelineStageExecutions.pipelineRunId, runId),
            eq(pipelineStageExecutions.stageId, stageId),
          ),
        );
      const stageExec = stageExecs[0];
      if (stageExec) {
        await db
          .update(pipelineStageExecutions)
          .set({
            status: "completed",
            outputState: outputData,
            costUsd: String(costUsd),
            completedAt: new Date(),
          })
          .where(eq(pipelineStageExecutions.id, stageExec.id));
      }

      // Accumulate cost
      const newTotalCost = Number(run.totalCostUsd ?? 0) + costUsd;

      // Budget check
      if (defaults?.budgetCapUsd && newTotalCost > defaults.budgetCapUsd) {
        await db
          .update(pipelineRuns)
          .set({ status: "paused", totalCostUsd: String(newTotalCost) })
          .where(eq(pipelineRuns.id, runId));
        return { action: "paused", reason: "budget_exceeded" };
      }

      // Find next stages via DAG edges + conditions
      const nextStageIds = findNextStages(stageId, edges, outputData);

      // Get all completed stages for merge-readiness checks
      const allExecs = await db
        .select()
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.pipelineRunId, runId));
      const completedIds = new Set(
        allExecs.filter((e) => e.status === "completed").map((e) => e.stageId),
      );
      completedIds.add(stageId);

      // Filter next stages — check merge readiness
      const readyStageIds: string[] = [];
      for (const nextId of nextStageIds) {
        const nextStage = getStageById(stages, nextId);
        if (!nextStage) continue;

        if (nextStage.type === "merge") {
          const strategy = nextStage.mergeStrategy ?? "all";
          if (!isMergeReady(nextId, edges, completedIds, strategy)) {
            continue; // wait for other branches
          }
        }
        readyStageIds.push(nextId);
      }

      // Remove completed stage from active, add new ready stages
      const currentActive = (run.activeStageIds as string[]) ?? [];
      const newActive = [
        ...currentActive.filter((id) => id !== stageId),
        ...readyStageIds,
      ];

      // If no active stages and no ready stages, pipeline is complete
      if (newActive.length === 0) {
        await db
          .update(pipelineRuns)
          .set({
            status: "completed",
            activeStageIds: [],
            outputData,
            totalCostUsd: String(newTotalCost),
            completedAt: new Date(),
          })
          .where(eq(pipelineRuns.id, runId));
        return { action: "completed", outputData };
      }

      // Update run with new active stages and cost
      await db
        .update(pipelineRuns)
        .set({
          activeStageIds: newActive,
          totalCostUsd: String(newTotalCost),
        })
        .where(eq(pipelineRuns.id, runId));

      // Create stage executions for newly ready stages
      const stageIndex = stages.findIndex((s) => s.id === stageId);
      for (const nextId of readyStageIds) {
        const nextStage = getStageById(stages, nextId);
        if (!nextStage) continue;

        const mapped = applyStateMapping(outputData, nextStage.stateMapping);
        const envelope = buildStateEnvelope({
          pipelineRunId: runId,
          pipelineId: pipeline.id,
          sourceStageId: stageId,
          data: mapped,
          stageIndex: stageIndex + 1,
          totalStages: stages.length,
          executionMode: run.executionMode as "sync" | "async",
          accumulatedCostUsd: newTotalCost,
        });

        await db.insert(pipelineStageExecutions).values({
          pipelineRunId: runId,
          stageId: nextId,
          inputState: envelope as any,
          status: nextStage.type === "hitl_gate" ? "waiting_hitl" : "pending",
        });
      }

      return { action: "advanced", readyStageIds };
    },

    // Handle HITL gate approval
    async onHitlDecision(
      runId: string,
      stageId: string,
      decision: "approved" | "rejected",
      notes?: string,
    ) {
      if (decision === "rejected") {
        await db
          .update(pipelineRuns)
          .set({ status: "cancelled", errorMessage: notes ?? "HITL rejected" })
          .where(eq(pipelineRuns.id, runId));
        return { action: "cancelled" };
      }

      // Approved — mark stage as completed and advance
      return svc.onStageCompleted(runId, stageId, { hitl_decision: "approved", notes }, 0);
    },

    // Handle stage failure
    async onStageFailed(runId: string, stageId: string, error: string) {
      const stageExecs = await db
        .select()
        .from(pipelineStageExecutions)
        .where(
          and(
            eq(pipelineStageExecutions.pipelineRunId, runId),
            eq(pipelineStageExecutions.stageId, stageId),
          ),
        );
      const stageExec = stageExecs[0];
      if (stageExec) {
        await db
          .update(pipelineStageExecutions)
          .set({
            status: "failed",
            errorMessage: error,
            completedAt: new Date(),
          })
          .where(eq(pipelineStageExecutions.id, stageExec.id));
      }

      // Mark run as failed
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          errorMessage: `Stage ${stageId} failed: ${error}`,
          failedAt: new Date(),
        })
        .where(eq(pipelineRuns.id, runId));

      return { action: "failed", stageId, error };
    },
  };

  return svc;
}
