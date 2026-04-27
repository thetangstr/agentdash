import { Router } from "express";
import type { Db } from "@agentdash/db";
import { budgetForecastService } from "../services/budget-forecasts.js";
import { capacityPlanningService } from "../services/capacity-planning.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function budgetExtendedRoutes(db: Db) {
  const router = Router();
  const forecast = budgetForecastService(db);
  const capacity = capacityPlanningService(db);

  // --------------- Departments ---------------

  router.get("/companies/:companyId/departments", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const departments = await forecast.listDepartments(companyId);
      res.status(200).json(departments);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.post("/companies/:companyId/departments", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { name, description, parentId, leadUserId } = req.body;
      const department = await forecast.createDepartment(companyId, { name, description, parentId, leadUserId });
      res.status(201).json(department);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.patch("/companies/:companyId/departments/:id", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const department = await forecast.updateDepartment(id, req.body);
      res.status(200).json(department);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Budget Allocations ---------------

  router.post("/companies/:companyId/budget-allocations", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { parentPolicyId, childPolicyId, allocatedAmount, isFlexible } = req.body;
      const allocation = await forecast.createAllocation(companyId, {
        parentPolicyId,
        childPolicyId,
        allocatedAmount,
        isFlexible,
      });
      res.status(201).json(allocation);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/budget-allocations", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const parentPolicyId = req.query.parentPolicyId as string | undefined;
      const allocations = await forecast.listAllocations(companyId, parentPolicyId);
      res.status(200).json(allocations);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Forecasts ---------------

  router.get("/companies/:companyId/budget-forecasts/burn-rate", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const scopeType = req.query.scopeType as string;
      const scopeId = req.query.scopeId as string;

      // AgentDash: scopeType=company returns a company-wide aggregate burn rate
      // using the capacity service summary instead of a per-agent/project lookup.
      if (scopeType === "company" || (!scopeType && !scopeId)) {
        const companyBurn = await forecast.computeCompanyBurnRate(companyId);
        res.status(200).json(companyBurn);
        return;
      }

      if (scopeType !== "agent" && scopeType !== "project") {
        res.status(400).json({ error: `Invalid scopeType: ${scopeType}. Must be "agent", "project", or "company".` });
        return;
      }

      const burnRate = await forecast.computeBurnRate(companyId, scopeType as "agent" | "project", scopeId);
      res.status(200).json(burnRate);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/budget-forecasts/roi/:projectId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const projectId = req.params.projectId as string;
      const roi = await forecast.computeProjectROI(companyId, projectId);
      res.status(200).json(roi);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Resource Usage ---------------

  router.post("/companies/:companyId/resource-usage", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = { ...req.body, occurredAt: new Date(req.body.occurredAt) };
      const event = await forecast.recordResourceUsage(companyId, body);
      res.status(201).json(event);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/resource-usage/summary", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const resourceType = req.query.resourceType as string | undefined;
      const agentId = req.query.agentId as string | undefined;
      const days = req.query.days ? Number(req.query.days) : undefined;
      const summary = await forecast.getResourceUsageSummary(companyId, { resourceType, agentId, days });
      res.status(200).json(summary);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // --------------- Capacity Planning ---------------

  router.get("/companies/:companyId/capacity/workforce", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const workforce = await capacity.getWorkforceSnapshot(companyId);
      res.status(200).json(workforce);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/capacity/pipeline", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const projectId = req.query.projectId as string | undefined;
      const pipeline = await capacity.getTaskPipeline(companyId, projectId);
      res.status(200).json(pipeline);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/capacity/estimate/:projectId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const projectId = req.params.projectId as string;
      const estimate = await capacity.estimateProjectCapacity(projectId);
      res.status(200).json(estimate);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/companies/:companyId/capacity/recommendations/:projectId", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const projectId = req.params.projectId as string;
      const recommendations = await capacity.recommendSpawns(companyId, projectId);
      res.status(200).json(recommendations);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  router.get("/agents/:agentId/throughput", async (req, res) => {
    try {
      assertBoard(req);
      const agentId = req.params.agentId as string;
      const windowDays = req.query.windowDays ? Number(req.query.windowDays) : undefined;
      const throughput = await capacity.getAgentThroughput(agentId, windowDays);
      res.status(200).json(throughput);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
