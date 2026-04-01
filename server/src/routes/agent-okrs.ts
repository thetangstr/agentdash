import { Router } from "express";
import type { Db } from "@agentdash/db";
import { agentFactoryService } from "../services/agent-factory.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentOkrRoutes(db: Db) {
  const router = Router();
  const svc = agentFactoryService(db);

  router.get("/companies/:companyId/agents/:agentId/okrs", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;
      const summary = await svc.getAgentOkrSummary(companyId, agentId);
      res.status(200).json(summary);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/agents/:agentId/okrs", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;
      const result = await svc.setAgentOkrs(companyId, agentId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/agents/:agentId/okrs/:okrId/key-results/:krId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const krId = req.params.krId as string;
      const result = await svc.updateKeyResult(krId, req.body.currentValue);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
