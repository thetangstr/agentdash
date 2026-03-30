import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentFactoryService } from "../services/agent-factory.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function spawnRequestRoutes(db: Db) {
  const router = Router();
  const svc = agentFactoryService(db);

  router.post("/companies/:companyId/spawn-requests", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.requestSpawn(companyId, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/spawn-requests", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const status = req.query.status as string | undefined;
      const requests = await svc.listSpawnRequests(companyId, status);
      res.status(200).json(requests);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/spawn-requests/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const request = await svc.getSpawnRequestById(id);
      if (!request) {
        res.status(404).json({ error: "Spawn request not found" });
        return;
      }
      res.status(200).json(request);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
