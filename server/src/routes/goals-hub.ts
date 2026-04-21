import { Router } from "express";
import type { Db } from "@agentdash/db";
import { goalsHubService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

// AgentDash: Goal hub rollup endpoint — one call returns agent roster, plan,
// work, spend/budget, KPIs, and activity timeline for a goal.
export function goalsHubRoutes(db: Db) {
  const router = Router();
  const svc = goalsHubService(db);

  router.get("/companies/:companyId/goals/:goalId/hub", async (req, res) => {
    const companyId = req.params.companyId as string;
    const goalId = req.params.goalId as string;
    assertCompanyAccess(req, companyId);
    const rollup = await svc.getRollup(companyId, goalId);
    res.json(rollup);
  });

  return router;
}
