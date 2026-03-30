import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { onboardingService } from "../services/onboarding.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function onboardingRoutes(db: Db) {
  const router = Router();
  const svc = onboardingService(db);

  // --------------- Sessions ---------------

  router.post("/companies/:companyId/onboarding/sessions", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createSession(companyId, (req as any).actor?.userId ?? "unknown");
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/onboarding/sessions/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getSession(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/onboarding/sessions/:id", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateSession(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Sources ---------------

  router.post("/companies/:companyId/onboarding/sessions/:id/sources", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.ingestSource(companyId, req.params.id as string, req.body);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/onboarding/sessions/:id/sources", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.listSources(companyId, req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Extract ---------------

  router.post("/companies/:companyId/onboarding/sessions/:id/extract", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.extractContext(companyId, req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Company Context ---------------

  router.get("/companies/:companyId/context", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.listContext(companyId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/context/:id", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateContext(req.params.id as string, req.body);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Team Suggestions ---------------

  router.post("/companies/:companyId/onboarding/sessions/:id/suggest-team", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.suggestTeam(companyId, req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/onboarding/sessions/:id/apply-team", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.applyTeam(companyId, req.body.suggestions);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Complete ---------------

  router.post("/companies/:companyId/onboarding/sessions/:id/complete", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.completeSession(req.params.id as string);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
