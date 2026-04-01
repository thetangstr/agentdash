import { Router } from "express";
import type { Db } from "@agentdash/db";
import { createActionProposalSchema } from "@agentdash/shared";
import { validate } from "../middleware/validate.js";
import { actionProposalService } from "../services/action-proposals.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// AgentDash: Action Proposal Routes
// POST /companies/:companyId/action-proposals  — propose action (runs policy eval)
// GET  /companies/:companyId/action-proposals  — list proposals

export function actionProposalRoutes(db: Db) {
  const router = Router();
  const svc = actionProposalService(db);

  router.post(
    "/companies/:companyId/action-proposals",
    validate(createActionProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      // Agent can propose directly, or board user can submit on behalf of agent
      const agentId = actor.agentId ?? (req.body.agentId as string | undefined);
      if (!agentId) {
        res.status(400).json({ error: "Action proposals require an agentId (agent auth or body.agentId)" });
        return;
      }

      try {
        const result = await svc.propose(companyId, agentId, req.body);
        res.status(201).json(result);
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode ?? 500;
        const message = err instanceof Error ? err.message : "Internal server error";
        res.status(status).json({ error: message });
      }
    },
  );

  router.get("/companies/:companyId/action-proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, { status });
    res.json(result);
  });

  return router;
}
