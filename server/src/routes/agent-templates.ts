import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentFactoryService } from "../services/agent-factory.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentTemplateRoutes(db: Db) {
  const router = Router();
  const svc = agentFactoryService(db);

  router.get("/companies/:companyId/agent-templates", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const role = req.query.role as string | undefined;
      const archived = req.query.archived === "true";
      const templates = await svc.listTemplates(companyId, { role, archived });
      res.status(200).json(templates);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/agent-templates/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const template = await svc.getTemplateById(id);
      if (!template) {
        res.status(404).json({ error: "Agent template not found" });
        return;
      }
      res.status(200).json(template);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/agent-templates", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const template = await svc.createTemplate(companyId, req.body);
      res.status(201).json(template);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/agent-templates/:id", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const template = await svc.updateTemplate(id, req.body);
      if (!template) {
        res.status(404).json({ error: "Agent template not found" });
        return;
      }
      res.status(200).json(template);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/agent-templates/:id/archive", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const template = await svc.archiveTemplate(id);
      if (!template) {
        res.status(404).json({ error: "Agent template not found" });
        return;
      }
      res.status(200).json(template);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
