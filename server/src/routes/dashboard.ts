import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { issues, agents } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import {
  agentVisibilityCondition,
  approvalVisibilityCondition,
  budgetPolicyVisibilityCondition,
  issueVisibilityCondition,
  projectScopedVisibilityCondition,
  resolveAgentVisibility,
} from "./visibility.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await resolveAgentVisibility(db, req, companyId);
    const summary = await svc.summary(companyId, {
      agentVisibleWhere: agentVisibilityCondition(req, companyId, agents.id),
      issueVisibleWhere: issueVisibilityCondition(req, companyId),
      // AgentDash (GH #902): hidden projects' budgets stay out of the counts.
      budgetVisibleWhere: budgetPolicyVisibilityCondition(req, companyId),
      approvalVisibleWhere: approvalVisibilityCondition(req, companyId),
    });
    res.json(summary);
  });

  // AgentDash: UX-3 (#784) — Home's "Working now": live runs with the issue
  // title, agent, last step and start time. Restricted projects stay hidden.
  router.get("/companies/:companyId/dashboard/working-now", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await resolveAgentVisibility(db, req, companyId);
    res.json(
      await svc.workingNow(companyId, {
        visibleWhere: issueVisibilityCondition(req, companyId),
      }),
    );
  });

  return router;
}
