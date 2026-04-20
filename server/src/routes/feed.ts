import { Router } from "express";
import type { Db } from "@agentdash/db";
import { feedService } from "../services/feed.js";
import { assertCompanyAccess } from "./authz.js";

// AgentDash: Feed routes
export function feedRoutes(db: Db) {
  const router = Router();
  const svc = feedService(db);

  // GET /api/companies/:companyId/feed?userId=&cursor=&limit=
  router.get("/companies/:companyId/feed", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" ? req.query.userId : undefined;
    const cursor =
      typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

    const result = await svc.list(companyId, { userId, cursor, limit });
    res.json(result);
  });

  return router;
}
