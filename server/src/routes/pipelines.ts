import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createPipelineSchema, updatePipelineSchema, startPipelineRunSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { pipelineOrchestratorService } from "../services/pipeline-orchestrator.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

// AgentDash: Pipeline Routes
// Manage pipeline definitions and runs

export function pipelineRoutes(db: Db) {
  const router = Router();
  const svc = pipelineOrchestratorService(db);

  // Pipeline definitions
  router.post(
    "/companies/:companyId/pipelines",
    validate(createPipelineSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const pipeline = await svc.createPipeline(companyId, req.body);
      res.status(201).json(pipeline);
    },
  );

  router.get("/companies/:companyId/pipelines", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.listPipelines(companyId, { status });
    res.json(result);
  });

  router.get("/pipelines/:id", async (req, res) => {
    const pipeline = await svc.getPipelineById(req.params.id as string);
    assertCompanyAccess(req, pipeline.companyId);
    res.json(pipeline);
  });

  router.patch("/pipelines/:id", validate(updatePipelineSchema), async (req, res) => {
    assertBoard(req);
    const pipeline = await svc.updatePipeline(req.params.id as string, req.body);
    res.json(pipeline);
  });

  // Pipeline runs
  router.post(
    "/pipelines/:id/runs",
    validate(startPipelineRunSchema),
    async (req, res) => {
      const pipeline = await svc.getPipelineById(req.params.id as string);
      assertCompanyAccess(req, pipeline.companyId);
      const run = await svc.startRun(pipeline.companyId, pipeline.id, req.body.triggerIssueId, req.body.context);
      res.status(201).json(run);
    },
  );

  router.get("/companies/:companyId/pipeline-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pipelineId = req.query.pipelineId as string | undefined;
    const status = req.query.status as string | undefined;
    const result = await svc.listRuns(companyId, { pipelineId, status });
    res.json(result);
  });

  router.get("/pipeline-runs/:id", async (req, res) => {
    const run = await svc.getRunById(req.params.id as string);
    assertCompanyAccess(req, run.companyId);
    res.json(run);
  });

  router.post("/pipeline-runs/:id/cancel", async (req, res) => {
    assertBoard(req);
    const run = await svc.cancelRun(req.params.id as string);
    res.json(run);
  });

  return router;
}
