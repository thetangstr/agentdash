import { and, eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentPipelines, pipelineRuns, agents, agentTemplates, issues } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { crmLifecycleService } from "./crm-lifecycle.js";

// AgentDash: Pipeline Orchestrator
// Manages multi-agent workflows: Intake → Context → Policy → Resolution → Comms → QA

export function pipelineOrchestratorService(db: Db) {
  // ---------------------------------------------------------------------------
  // Pipeline Definitions
  // ---------------------------------------------------------------------------

  async function createPipeline(
    companyId: string,
    data: { name: string; description?: string; stages: Array<{ order: number; name: string; agentTemplateSlug?: string; agentId?: string; autoAdvance: boolean; config?: Record<string, unknown> }> },
  ) {
    const [pipeline] = await db.insert(agentPipelines).values({
      companyId,
      name: data.name,
      description: data.description ?? null,
      status: "active",
      stages: data.stages,
    }).returning();
    return pipeline;
  }

  async function listPipelines(companyId: string, opts?: { status?: string }) {
    const conditions = [eq(agentPipelines.companyId, companyId)];
    if (opts?.status) conditions.push(eq(agentPipelines.status, opts.status));
    return db.select().from(agentPipelines).where(and(...conditions))
      .orderBy(desc(agentPipelines.createdAt));
  }

  async function getPipelineById(id: string) {
    const pipeline = await db.select().from(agentPipelines)
      .where(eq(agentPipelines.id, id))
      .then((r) => r[0] ?? null);
    if (!pipeline) throw notFound("Pipeline not found");
    return pipeline;
  }

  async function updatePipeline(id: string, data: Partial<{ name: string; description: string | null; status: string; stages: Array<{ order: number; name: string; agentTemplateSlug?: string; agentId?: string; autoAdvance: boolean; config?: Record<string, unknown> }> }>) {
    const [updated] = await db.update(agentPipelines)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(agentPipelines.id, id))
      .returning();
    if (!updated) throw notFound("Pipeline not found");
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Pipeline Runs
  // ---------------------------------------------------------------------------

  async function startRun(
    companyId: string,
    pipelineId: string,
    triggerIssueId: string,
    initialContext?: Record<string, unknown>,
  ) {
    const pipeline = await getPipelineById(pipelineId);
    if (pipeline.status !== "active") throw unprocessable("Pipeline is not active");
    if (pipeline.companyId !== companyId) throw unprocessable("Pipeline does not belong to this company");

    const [run] = await db.insert(pipelineRuns).values({
      companyId,
      pipelineId,
      triggerIssueId,
      status: "running",
      currentStageIndex: 0,
      stageResults: [],
      context: initialContext ?? {},
      startedAt: new Date(),
    }).returning();

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "pipeline-orchestrator",
      action: "pipeline.run_started",
      entityType: "pipeline_run",
      entityId: run.id,
      details: { pipelineId, pipelineName: pipeline.name, triggerIssueId },
    });

    // Advance to first stage
    await advanceToStage(run.id, 0);

    return run;
  }

  async function advanceToStage(pipelineRunId: string, stageIndex: number) {
    const run = await db.select().from(pipelineRuns)
      .where(eq(pipelineRuns.id, pipelineRunId))
      .then((r) => r[0] ?? null);
    if (!run) throw notFound("Pipeline run not found");

    const pipeline = await getPipelineById(run.pipelineId);
    const stages = pipeline.stages as Array<{ order: number; name: string; agentTemplateSlug?: string; agentId?: string; autoAdvance: boolean }>;

    if (stageIndex >= stages.length) {
      // All stages complete
      await db.update(pipelineRuns)
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(pipelineRuns.id, pipelineRunId));

      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "pipeline-orchestrator",
        action: "pipeline.run_completed",
        entityType: "pipeline_run",
        entityId: run.id,
        details: { pipelineId: pipeline.id, totalStages: stages.length },
      });

      // AgentDash: CRM lifecycle — log pipeline run completion
      const runCrmAccountId = (run.context as Record<string, unknown>)?.crmAccountId as string | undefined;
      void crmLifecycleService(db).onPipelineRunCompleted(run.companyId, {
        pipelineName: pipeline.name,
        pipelineRunId: run.id,
        totalStages: stages.length,
        crmAccountId: runCrmAccountId ?? null,
        triggerIssueId: run.triggerIssueId,
      }).catch(() => {});

      return;
    }

    const stage = stages[stageIndex];

    // Resolve agent for this stage
    let agentId = stage.agentId;
    if (!agentId && stage.agentTemplateSlug) {
      // Find an agent spawned from this template slug
      const template = await db.select().from(agentTemplates)
        .where(and(
          eq(agentTemplates.companyId, run.companyId),
          eq(agentTemplates.slug, stage.agentTemplateSlug),
        ))
        .then((r) => r[0] ?? null);

      if (template) {
        // Find an idle agent with this name/role
        const agent = await db.select().from(agents)
          .where(and(
            eq(agents.companyId, run.companyId),
            eq(agents.name, template.name),
          ))
          .then((r) => r[0] ?? null);
        agentId = agent?.id ?? null;
      }
    }

    // Create issue for this stage using the issue service (handles identifier/number)
    const issueSvc = issueService(db);
    const stageIssue = await issueSvc.create(run.companyId, {
      title: `[Pipeline] ${stage.name}`,
      description: `Pipeline stage ${stageIndex + 1}/${stages.length}: ${stage.name}\nPipeline: ${pipeline.name}\nRun: ${run.id}`,
      status: "todo",
      priority: "medium",
      originKind: "pipeline_stage",
      originId: pipelineRunId,
      assigneeAgentId: agentId ?? undefined,
      crmAccountId: (run.context as Record<string, unknown>)?.crmAccountId as string ?? null,
    } as Parameters<typeof issueSvc.create>[1]);

    // Update run state
    await db.update(pipelineRuns)
      .set({ currentStageIndex: stageIndex, updatedAt: new Date() })
      .where(eq(pipelineRuns.id, pipelineRunId));

    await logActivity(db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "pipeline-orchestrator",
      action: "pipeline.stage_started",
      entityType: "pipeline_run",
      entityId: run.id,
      agentId: agentId ?? undefined,
      details: {
        stageIndex,
        stageName: stage.name,
        issueId: stageIssue.id,
        agentId,
      },
    });

    return stageIssue;
  }

  /**
   * Called when a pipeline-stage issue is completed.
   * Records the result and advances to the next stage if autoAdvance is true.
   */
  async function onStageCompleted(companyId: string, issueId: string) {
    // Find the issue to get the pipeline run ID
    const issue = await db.select().from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((r) => r[0] ?? null);
    if (!issue || issue.originKind !== "pipeline_stage" || !issue.originId) return;

    const pipelineRunId = issue.originId;
    const run = await db.select().from(pipelineRuns)
      .where(eq(pipelineRuns.id, pipelineRunId))
      .then((r) => r[0] ?? null);
    if (!run || run.status !== "running") return;

    const pipeline = await getPipelineById(run.pipelineId);
    const stages = pipeline.stages as Array<{ order: number; name: string; autoAdvance: boolean }>;
    const currentStage = stages[run.currentStageIndex];

    // Record stage result
    const stageResults = [...(run.stageResults ?? [])];
    stageResults.push({
      stageIndex: run.currentStageIndex,
      stageName: currentStage?.name ?? `Stage ${run.currentStageIndex}`,
      agentId: issue.assigneeAgentId ?? "",
      issueId,
      status: "completed",
      startedAt: issue.startedAt?.toISOString() ?? issue.createdAt.toISOString(),
      completedAt: new Date().toISOString(),
    });

    await db.update(pipelineRuns)
      .set({ stageResults, updatedAt: new Date() })
      .where(eq(pipelineRuns.id, pipelineRunId));

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "pipeline-orchestrator",
      action: "pipeline.stage_completed",
      entityType: "pipeline_run",
      entityId: pipelineRunId,
      details: {
        stageIndex: run.currentStageIndex,
        stageName: currentStage?.name,
        issueId,
      },
    });

    // AgentDash: CRM lifecycle — log stage completion as CRM activity
    const crmAccountId = (run.context as Record<string, unknown>)?.crmAccountId as string | undefined;
    void crmLifecycleService(db).onPipelineStageCompleted(companyId, {
      pipelineName: pipeline.name,
      stageName: currentStage?.name ?? `Stage ${run.currentStageIndex}`,
      stageIndex: run.currentStageIndex,
      totalStages: stages.length,
      issueId,
      agentId: issue.assigneeAgentId,
      crmAccountId: crmAccountId ?? null,
      pipelineRunId,
    }).catch(() => {});

    // Auto-advance if configured
    if (currentStage?.autoAdvance) {
      await advanceToStage(pipelineRunId, run.currentStageIndex + 1);
    }
  }

  async function listRuns(companyId: string, opts?: { pipelineId?: string; status?: string }) {
    const conditions = [eq(pipelineRuns.companyId, companyId)];
    if (opts?.pipelineId) conditions.push(eq(pipelineRuns.pipelineId, opts.pipelineId));
    if (opts?.status) conditions.push(eq(pipelineRuns.status, opts.status));
    return db.select().from(pipelineRuns).where(and(...conditions))
      .orderBy(desc(pipelineRuns.createdAt));
  }

  async function getRunById(id: string) {
    const run = await db.select().from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .then((r) => r[0] ?? null);
    if (!run) throw notFound("Pipeline run not found");
    return run;
  }

  async function cancelRun(id: string) {
    const [updated] = await db.update(pipelineRuns)
      .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(pipelineRuns.id, id))
      .returning();
    if (!updated) throw notFound("Pipeline run not found");
    return updated;
  }

  return {
    createPipeline,
    listPipelines,
    getPipelineById,
    updatePipeline,
    startRun,
    advanceToStage,
    onStageCompleted,
    listRuns,
    getRunById,
    cancelRun,
  };
}
