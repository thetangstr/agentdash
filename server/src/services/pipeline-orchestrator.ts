import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agentPipelines, pipelineRuns, pipelineStageExecutions } from "@agentdash/db";
import type {
  PipelineStageDefinition,
  PipelineEdgeDefinition,
  CreatePipeline,
  UpdatePipeline,
  StartPipelineRun,
} from "@agentdash/shared";
import { notFound, badRequest } from "../errors.js";

// AgentDash: Pipeline DAG validation — topological sort via Kahn's algorithm

/**
 * Validates that `stages` and `edges` form a valid DAG:
 *  1. No duplicate stage IDs
 *  2. All edge endpoints reference known stage IDs
 *  3. No cycles (Kahn's topological sort)
 */
export function validatePipelineDag(
  stages: PipelineStageDefinition[],
  edges: PipelineEdgeDefinition[],
): void {
  // 1. Check for duplicate stage IDs
  const idSet = new Set<string>();
  for (const stage of stages) {
    if (idSet.has(stage.id)) {
      throw new Error(`Duplicate stage ID: "${stage.id}"`);
    }
    idSet.add(stage.id);
  }

  // 2. Check all edge endpoints reference known stages
  for (const edge of edges) {
    if (!idSet.has(edge.fromStageId)) {
      throw new Error(`Unknown stage referenced in edge "${edge.id}": fromStageId "${edge.fromStageId}"`);
    }
    if (!idSet.has(edge.toStageId)) {
      throw new Error(`Unknown stage referenced in edge "${edge.id}": toStageId "${edge.toStageId}"`);
    }
  }

  // 3. Kahn's algorithm for cycle detection
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const stage of stages) {
    inDegree.set(stage.id, 0);
    adjacency.set(stage.id, []);
  }

  for (const edge of edges) {
    adjacency.get(edge.fromStageId)!.push(edge.toStageId);
    inDegree.set(edge.toStageId, (inDegree.get(edge.toStageId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== stages.length) {
    throw new Error("Cycle detected in pipeline DAG");
  }
}

// AgentDash: Pipeline orchestrator service — CRUD for pipelines, runs, and stage executions

export function pipelineOrchestratorService(db: Db) {
  return {
    // ── Pipeline CRUD ──────────────────────────────────────────────

    /** List active (non-archived) pipelines for a company, ordered by updatedAt desc */
    async list(companyId: string) {
      return db
        .select()
        .from(agentPipelines)
        .where(
          and(
            eq(agentPipelines.companyId, companyId),
            eq(agentPipelines.status, "active"),
          ),
        )
        .orderBy(desc(agentPipelines.updatedAt));
    },

    /** List all pipelines including archived, ordered by updatedAt desc */
    async listAll(companyId: string) {
      return db
        .select()
        .from(agentPipelines)
        .where(eq(agentPipelines.companyId, companyId))
        .orderBy(desc(agentPipelines.updatedAt));
    },

    /** Get a single pipeline with company boundary check */
    async get(companyId: string, pipelineId: string) {
      const [row] = await db
        .select()
        .from(agentPipelines)
        .where(
          and(
            eq(agentPipelines.id, pipelineId),
            eq(agentPipelines.companyId, companyId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Pipeline not found");
      return row;
    },

    /** Create a new pipeline — validates DAG before inserting */
    async create(companyId: string, data: CreatePipeline, createdBy?: string) {
      validatePipelineDag(data.stages as PipelineStageDefinition[], data.edges as PipelineEdgeDefinition[]);

      const [row] = await db
        .insert(agentPipelines)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          stages: data.stages,
          edges: data.edges,
          executionMode: data.executionMode ?? "sync",
          defaults: data.defaults as Record<string, unknown> | undefined,
          status: "active",
          createdBy: createdBy ?? null,
        })
        .returning();
      return row;
    },

    /** Update a pipeline — re-validates DAG if stages/edges are changing */
    async update(companyId: string, pipelineId: string, data: UpdatePipeline) {
      const existing = await this.get(companyId, pipelineId);

      if (data.stages !== undefined || data.edges !== undefined) {
        const stages = (data.stages ?? existing.stages) as PipelineStageDefinition[];
        const edges = (data.edges ?? existing.edges) as PipelineEdgeDefinition[];
        validatePipelineDag(stages, edges);
      }

      const [row] = await db
        .update(agentPipelines)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.stages !== undefined && { stages: data.stages }),
          ...(data.edges !== undefined && { edges: data.edges }),
          ...(data.executionMode !== undefined && { executionMode: data.executionMode }),
          ...(data.defaults !== undefined && { defaults: data.defaults as Record<string, unknown> }),
          ...(data.status !== undefined && { status: data.status }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentPipelines.id, pipelineId),
            eq(agentPipelines.companyId, companyId),
          ),
        )
        .returning();
      if (!row) throw notFound("Pipeline not found");
      return row;
    },

    /** Soft-delete a pipeline by setting status="archived" and archivedAt */
    async delete(companyId: string, pipelineId: string) {
      const [row] = await db
        .update(agentPipelines)
        .set({
          status: "archived",
          archivedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentPipelines.id, pipelineId),
            eq(agentPipelines.companyId, companyId),
          ),
        )
        .returning();
      if (!row) throw notFound("Pipeline not found");
      return row;
    },

    // ── Pipeline Runs ──────────────────────────────────────────────

    /** Create a run for a pipeline — pipeline must exist and be active */
    async createRun(
      companyId: string,
      pipelineId: string,
      data: StartPipelineRun,
      triggeredBy?: string,
    ) {
      const pipeline = await this.get(companyId, pipelineId);
      if (pipeline.status !== "active") {
        throw badRequest(`Pipeline is not active (status: "${pipeline.status}")`);
      }

      const [row] = await db
        .insert(pipelineRuns)
        .values({
          pipelineId,
          companyId,
          status: "pending",
          executionMode: data.executionMode ?? pipeline.executionMode,
          inputData: data.inputData ?? null,
          triggeredBy: triggeredBy ?? null,
        })
        .returning();
      return row;
    },

    /** Get a single run with company boundary check */
    async getRun(companyId: string, runId: string) {
      const [row] = await db
        .select()
        .from(pipelineRuns)
        .where(
          and(
            eq(pipelineRuns.id, runId),
            eq(pipelineRuns.companyId, companyId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Pipeline run not found");
      return row;
    },

    /** List all runs for a pipeline, ordered by createdAt desc */
    async listRuns(companyId: string, pipelineId: string) {
      return db
        .select()
        .from(pipelineRuns)
        .where(
          and(
            eq(pipelineRuns.pipelineId, pipelineId),
            eq(pipelineRuns.companyId, companyId),
          ),
        )
        .orderBy(desc(pipelineRuns.createdAt));
    },

    /** Cancel a run by setting status="cancelled" */
    async cancelRun(companyId: string, runId: string) {
      const [row] = await db
        .update(pipelineRuns)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(pipelineRuns.id, runId),
            eq(pipelineRuns.companyId, companyId),
          ),
        )
        .returning();
      if (!row) throw notFound("Pipeline run not found");
      return row;
    },

    // ── Stage Executions ───────────────────────────────────────────

    /** Insert a new stage execution record */
    async createStageExecution(
      pipelineRunId: string,
      stageId: string,
      inputState: Record<string, unknown>,
    ) {
      const [row] = await db
        .insert(pipelineStageExecutions)
        .values({
          pipelineRunId,
          stageId,
          inputState,
          status: "pending",
        })
        .returning();
      return row;
    },

    /** List all stage executions for a run */
    async getStageExecutions(pipelineRunId: string) {
      return db
        .select()
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.pipelineRunId, pipelineRunId));
    },

    /** Update a stage execution by ID */
    async updateStageExecution(
      id: string,
      updates: Partial<{
        status: string;
        outputState: Record<string, unknown>;
        costUsd: string;
        selfHealAttempts: number;
        selfHealLog: unknown[];
        heartbeatRunId: string;
        approvalId: string;
        errorMessage: string;
        startedAt: Date;
        completedAt: Date;
      }>,
    ) {
      const [row] = await db
        .update(pipelineStageExecutions)
        .set(updates)
        .where(eq(pipelineStageExecutions.id, id))
        .returning();
      if (!row) throw notFound("Stage execution not found");
      return row;
    },
  };
}
