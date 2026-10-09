import { Router } from "express";
import { and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { issues, agents, costEvents } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { documentRunAccess } from "./document-run-access.js";
import {
  agentVisibilityCondition,
  approvalVisibilityCondition,
  budgetPolicyVisibilityCondition,
  canReadCompanySpend,
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
      // AgentDash: the month's spend and tokens cover only what this person can
      // see: agents they cannot see, and restricted projects (directly or via
      // the event's issue), stay out of the totals, as on the Costs page.
      costVisibleWhere: and(
        agentVisibilityCondition(req, companyId, costEvents.agentId),
        projectScopedVisibilityCondition(req, companyId, costEvents.projectId),
        projectScopedVisibilityCondition(
          req,
          companyId,
          sql`(select ${issues.projectId} from ${issues} where ${issues.id} = ${costEvents.issueId})`,
        ),
      ),
    });
    // GH #918: month spend/tokens/utilization and the taskQuality spend
    // figures are the same numbers the /costs routes gate on agents:create.
    // A member who fails that check gets them OMITTED (null), not zeroed —
    // "$0.00" would lie where "unknown" is the truth. Everything else stays.
    res.json(
      (await canReadCompanySpend(db, req, companyId))
        ? summary
        : {
            ...summary,
            costs: null,
            taskQuality: {
              ...summary.taskQuality,
              issueLinkedSpendCents: null,
              issueLinkedTokens: null,
              issueLinkedCachedTokens: null,
              spendPerAcceptedIssueCents: null,
            },
          },
    );
  });

  // AgentDash: UX-3 (#784) — Home's "Working now": live runs with the issue
  // title, agent, last step and start time. Restricted projects stay hidden.
  router.get("/companies/:companyId/dashboard/working-now", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await resolveAgentVisibility(db, req, companyId);
    const workingNow = await svc.workingNow(companyId, {
      visibleWhere: issueVisibilityCondition(req, companyId),
    });
    // Document access (slice 6b): the last step is the run's own progress
    // text; it is dropped for runs the actor may not read.
    const readable = await documentRunAccess(db).readableAgentIds(req.actor, companyId);
    res.json(
      readable === null
        ? workingNow
        : {
            ...workingNow,
            items: workingNow.items.map((item) => (readable.has(item.agent.id) ? item : { ...item, lastStep: null })),
          },
    );
  });

  return router;
}
