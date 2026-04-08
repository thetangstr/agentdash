import { Router } from "express";
import type { Db } from "@agentdash/db";
import { pipelineOrchestratorService } from "../services/pipeline-orchestrator.js";
import { pipelineRunnerService } from "../services/pipeline-runner.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import {
  createPipelineSchema,
  updatePipelineSchema,
  startPipelineRunSchema,
} from "@agentdash/shared";

// AgentDash: Pipeline orchestrator routes
export function pipelineRoutes(db: Db) {
  const router = Router();
  const orchestrator = pipelineOrchestratorService(db);
  const runner = pipelineRunnerService(db);

  // --- Pipeline CRUD ---

  // List pipelines for a company
  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includeArchived = req.query.includeArchived === "true";
    const pipelines = includeArchived
      ? await orchestrator.listAll(companyId)
      : await orchestrator.list(companyId);
    res.json(pipelines);
  });

  // Get a single pipeline
  router.get("/companies/:companyId/pipelines/:pipelineId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const pipelineId = req.params.pipelineId as string;
    assertCompanyAccess(req, companyId);
    const pipeline = await orchestrator.get(companyId, pipelineId);
    res.json(pipeline);
  });

  // Create a pipeline
  router.post(
    "/companies/:companyId/pipelines",
    validate(createPipelineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const pipeline = await orchestrator.create(companyId, req.body);
      res.status(201).json(pipeline);
    },
  );

  // Update a pipeline
  router.patch(
    "/companies/:companyId/pipelines/:pipelineId",
    validate(updatePipelineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const pipelineId = req.params.pipelineId as string;
      assertCompanyAccess(req, companyId);
      const pipeline = await orchestrator.update(companyId, pipelineId, req.body);
      res.json(pipeline);
    },
  );

  // Delete (archive) a pipeline
  router.delete("/companies/:companyId/pipelines/:pipelineId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const pipelineId = req.params.pipelineId as string;
    assertCompanyAccess(req, companyId);
    const pipeline = await orchestrator.delete(companyId, pipelineId);
    res.json(pipeline);
  });

  // --- Pipeline Run Management ---

  // List runs for a pipeline
  router.get("/companies/:companyId/pipelines/:pipelineId/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const pipelineId = req.params.pipelineId as string;
    assertCompanyAccess(req, companyId);
    const runs = await orchestrator.listRuns(companyId, pipelineId);
    res.json(runs);
  });

  // Start a pipeline run
  router.post(
    "/companies/:companyId/pipelines/:pipelineId/runs",
    validate(startPipelineRunSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const pipelineId = req.params.pipelineId as string;
      assertCompanyAccess(req, companyId);
      const run = await orchestrator.createRun(companyId, pipelineId, req.body);
      // Start execution
      const result = await runner.startRun(run.id);
      res.status(201).json({ ...run, ...result });
    },
  );

  // Get a specific run
  router.get("/companies/:companyId/pipeline-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, companyId);
    const run = await orchestrator.getRun(companyId, runId);
    const stages = await orchestrator.getStageExecutions(run.id);
    res.json({ ...run, stages });
  });

  // Cancel a run
  router.post("/companies/:companyId/pipeline-runs/:runId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, companyId);
    const run = await orchestrator.cancelRun(companyId, runId);
    res.json(run);
  });

  // HITL decision on a run's stage
  router.post(
    "/companies/:companyId/pipeline-runs/:runId/stages/:stageId/decide",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const runId = req.params.runId as string;
      const stageId = req.params.stageId as string;
      assertCompanyAccess(req, companyId);
      const { decision, notes } = req.body;
      const result = await runner.onHitlDecision(runId, stageId, decision, notes);
      res.json(result);
    },
  );

  return router;
}
