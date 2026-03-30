import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { skillsRegistryService } from "../services/skills-registry.js";
import { skillAnalyticsService } from "../services/skill-analytics.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function skillsRegistryRoutes(db: Db) {
  const router = Router();
  const registry = skillsRegistryService(db);
  const analytics = skillAnalyticsService(db);

  // --------------- Skill Versions ---------------

  router.post("/companies/:companyId/skills/:skillId/versions", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const version = await registry.createVersion(companyId, skillId, req.body);
      res.status(201).json(version);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/skills/:skillId/versions", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versions = await registry.listVersions(companyId, skillId);
      res.status(200).json(versions);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/skills/:skillId/versions/:versionNumber", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versionNumber = Number(req.params.versionNumber);
      const version = await registry.getVersion(skillId, versionNumber);
      res.status(200).json(version);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Review Workflow ---------------

  router.post("/companies/:companyId/skills/:skillId/versions/:versionId/submit-review", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versionId = req.params.versionId as string;
      const result = await registry.submitForReview(versionId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/skills/:skillId/versions/:versionId/approve", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versionId = req.params.versionId as string;
      const { reviewedByUserId } = req.body;
      const result = await registry.approveVersion(versionId, reviewedByUserId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/skills/:skillId/versions/:versionId/reject", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versionId = req.params.versionId as string;
      const { reviewedByUserId } = req.body;
      const result = await registry.rejectVersion(versionId, reviewedByUserId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/skills/:skillId/versions/:versionId/publish", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versionId = req.params.versionId as string;
      const result = await registry.publishVersion(versionId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/skills/:skillId/versions/:versionId/deprecate", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const versionId = req.params.versionId as string;
      const result = await registry.deprecateVersion(versionId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Dependencies ---------------

  router.get("/companies/:companyId/skills/:skillId/dependencies", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const dependencies = await registry.getDependencies(companyId, skillId);
      res.status(200).json(dependencies);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.put("/companies/:companyId/skills/:skillId/dependencies", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const dependencies = await registry.setDependencies(companyId, skillId, req.body);
      res.status(200).json(dependencies);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/skills/:skillId/dependency-tree", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const tree = await registry.resolveDependencyTree(companyId, skillId);
      res.status(200).json(tree);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Analytics ---------------

  router.get("/companies/:companyId/skills/analytics/usage", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const days = req.query.days ? Number(req.query.days) : undefined;
      const usage = await analytics.usageBySkill(companyId, { days });
      res.status(200).json(usage);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/skills/analytics/usage/:skillId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const usage = await analytics.usageByAgent(companyId, skillId);
      res.status(200).json(usage);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/skills/analytics/outcomes/:skillId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const skillId = req.params.skillId as string;
      const outcomes = await analytics.outcomeCorrelation(companyId, skillId);
      res.status(200).json(outcomes);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/skills/analytics/unused", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const days = req.query.days ? Number(req.query.days) : undefined;
      const unused = await analytics.unusedSkills(companyId, days ?? 30);
      res.status(200).json(unused);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
