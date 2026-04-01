import { Router } from "express";
import type { Db } from "@agentdash/db";
import { policyEngineService } from "../services/policy-engine.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function securityRoutes(db: Db) {
  const router = Router();
  const svc = policyEngineService(db);

  // --------------- Policy CRUD ---------------

  router.post("/companies/:companyId/security-policies", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const policy = await svc.createPolicy(companyId, req.body);
      res.status(201).json(policy);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/security-policies", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const policyType = req.query.policyType as string | undefined;
      const isActive = req.query.isActive === "true" ? true : req.query.isActive === "false" ? false : undefined;
      const policies = await svc.listPolicies(companyId, { policyType, isActive });
      res.status(200).json(policies);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/security-policies/:id", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const policy = await svc.getPolicyById(id);
      if (!policy) {
        res.status(404).json({ error: "Security policy not found" });
        return;
      }
      res.status(200).json(policy);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/security-policies/:id", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const policy = await svc.updatePolicy(id, req.body);
      if (!policy) {
        res.status(404).json({ error: "Security policy not found" });
        return;
      }
      res.status(200).json(policy);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/security-policies/:id/deactivate", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const policy = await svc.deactivatePolicy(id);
      if (!policy) {
        res.status(404).json({ error: "Security policy not found" });
        return;
      }
      res.status(200).json(policy);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Policy Evaluations (audit log) ---------------

  router.get("/companies/:companyId/policy-evaluations", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.query.agentId as string | undefined;
      const decision = req.query.decision as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const evaluations = await svc.listPolicyEvaluations(companyId, { agentId, decision, limit });
      res.status(200).json(evaluations);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Sandbox ---------------

  router.post("/companies/:companyId/agents/:agentId/sandbox", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;
      const sandbox = await svc.configureSandbox(companyId, agentId, req.body);
      res.status(200).json(sandbox);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/agents/:agentId/sandbox", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const agentId = req.params.agentId as string;
      const sandbox = await svc.getSandbox(companyId, agentId);
      if (!sandbox) {
        res.status(404).json({ error: "Sandbox configuration not found" });
        return;
      }
      res.status(200).json(sandbox);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Kill Switch ---------------

  router.post("/companies/:companyId/kill-switch", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { scope, scopeId, reason } = req.body;
      const userId = (req as any).actor?.userId ?? "unknown";
      const result = await svc.activateKillSwitch(companyId, scope, scopeId, userId, reason);
      res.status(201).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/kill-switch/resume", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { scope, scopeId } = req.body;
      const userId = (req as any).actor?.userId ?? "unknown";
      const result = await svc.resumeFromKillSwitch(companyId, scope, scopeId, userId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/kill-switch/status", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const status = await svc.getKillSwitchStatus(companyId);
      res.status(200).json(status);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(statusCode).json({ error: message });
    }
  });

  return router;
}
