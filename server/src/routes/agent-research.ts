/**
 * AgentDash Integration: Agent Research Routes
 *
 * Copy this file to: agentdash/server/src/routes/agent-research.ts
 *
 * Then register in app.ts:
 *   import { agentResearchRoutes } from "./routes/agent-research.js";
 *   api.use(agentResearchRoutes(db));
 */

import { Router } from "express";
import type { Db } from "@agentdash/db";
import { companies, companyContext } from "@agentdash/db";
import { eq } from "drizzle-orm";
import { agentResearchService } from "../services/agent-research.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentResearchRoutes(db: Db) {
  const router = Router();
  const svc = agentResearchService(db);

  // POST /companies/:companyId/agent-research — trigger assessment
  router.post("/companies/:companyId/agent-research", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      // Pull existing context for richer input
      const contextRows = await db
        .select()
        .from(companyContext)
        .where(eq(companyContext.companyId, companyId));

      const ctxMap = Object.fromEntries(
        contextRows.map((r) => [r.key, r.value]),
      );

      const input = {
        companyName: company.name,
        industry: ctxMap.domain ?? req.body.industry ?? "Technology",
        description: company.description ?? "",
        companyUrl: req.body.companyUrl,
        employeeRange: req.body.employeeRange,
        revenueRange: req.body.revenueRange,
        currentSystems: ctxMap.tech_stack ?? req.body.currentSystems,
        automationLevel: req.body.automationLevel,
        challenges: ctxMap.pain_point ?? req.body.challenges,
        selectedFunctions: req.body.selectedFunctions,
        primaryGoal: req.body.primaryGoal ?? "Both",
        targets: req.body.targets,
        timeline: req.body.timeline,
        budgetRange: req.body.budgetRange,
      };

      const result = await svc.requestAssessment(companyId, input);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // GET /companies/:companyId/agent-research — get stored assessment
  router.get("/companies/:companyId/agent-research", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await svc.getAssessment(companyId);
      if (!result) {
        res.status(404).json({ error: "No assessment found. Run one first." });
        return;
      }

      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
