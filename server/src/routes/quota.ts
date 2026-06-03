// AgentDash (AGE-120): Agent-run quota API route.
// GET /companies/:companyId/quota — returns the quota snapshot for the workspace.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { quotaService } from "../services/quota.js";
import { forbidden, notFound } from "../errors.js";

export function quotaRoutes(db: Db) {
  const router = Router();
  const svc = quotaService(db);

  router.get("/companies/:companyId/quota", async (req, res) => {
    const { companyId } = req.params;
    if (!req.actor?.companyIds?.includes(companyId)) {
      throw forbidden("Not a member of this company");
    }
    const snapshot = await svc.getQuota(companyId);
    if (!snapshot) throw notFound("Company not found");
    res.json(snapshot);
  });

  return router;
}
