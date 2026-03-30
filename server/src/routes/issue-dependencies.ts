import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { taskDependencyService } from "../services/task-dependencies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function issueDependencyRoutes(db: Db) {
  const router = Router();
  const svc = taskDependencyService(db);

  router.post("/companies/:companyId/issues/:issueId/dependencies", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const issueId = req.params.issueId as string;
      const { blockedByIssueId, dependencyType, createdByAgentId, createdByUserId } = req.body;
      const dependency = await svc.addDependency(companyId, issueId, blockedByIssueId, {
        dependencyType,
        createdByAgentId,
        createdByUserId,
      });
      res.status(201).json(dependency);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.delete(
    "/companies/:companyId/issues/:issueId/dependencies/:blockedByIssueId",
    async (req, res) => {
      try {
        assertBoard(req);
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const issueId = req.params.issueId as string;
        const blockedByIssueId = req.params.blockedByIssueId as string;
        const success = await svc.removeDependency(companyId, issueId, blockedByIssueId);
        res.status(200).json({ success });
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        const message = err instanceof Error ? err.message : "Internal server error";
        res.status(status).json({ error: message });
      }
    },
  );

  router.get("/companies/:companyId/issues/:issueId/blockers", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const issueId = req.params.issueId as string;
      const blockers = await svc.getBlockers(companyId, issueId);
      res.status(200).json(blockers);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/issues/:issueId/dependents", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const issueId = req.params.issueId as string;
      const dependents = await svc.getDependents(companyId, issueId);
      res.status(200).json(dependents);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/projects/:projectId/dependency-graph", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const projectId = req.params.projectId as string;
      const graph = await svc.getFullDag(companyId, projectId);
      res.status(200).json(graph);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
