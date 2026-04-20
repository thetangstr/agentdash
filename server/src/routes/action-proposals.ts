import { Router } from "express";
import type { Db } from "@agentdash/db";
import { actionProposalService } from "../services/action-proposals.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

// AgentDash: Action Proposals routes
export function actionProposalRoutes(db: Db) {
  const router = Router();
  const svc = actionProposalService(db);

  // GET /api/companies/:companyId/action-proposals?status=pending
  router.get("/companies/:companyId/action-proposals", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const proposals = await svc.list(companyId, { status });
    res.json(proposals);
  });

  // POST /api/companies/:companyId/action-proposals/:id/approve
  router.post("/companies/:companyId/action-proposals/:id/approve", async (req, res) => {
    const { companyId, id } = req.params;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const decidedByUserId =
      req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";
    const { decisionNote } = req.body as { decisionNote?: string };

    const proposal = await svc.approve(companyId, id, { decidedByUserId, decisionNote });
    if (!proposal) throw notFound("Approval not found");
    res.json(proposal);
  });

  // POST /api/companies/:companyId/action-proposals/:id/reject
  router.post("/companies/:companyId/action-proposals/:id/reject", async (req, res) => {
    const { companyId, id } = req.params;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const decidedByUserId =
      req.actor.type === "board" ? (req.actor.userId ?? "board") : "board";
    const { decisionNote } = req.body as { decisionNote?: string };

    const proposal = await svc.reject(companyId, id, { decidedByUserId, decisionNote });
    if (!proposal) throw notFound("Approval not found");
    res.json(proposal);
  });

  return router;
}
