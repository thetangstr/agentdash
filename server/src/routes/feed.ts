import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { feedService } from "../services/feed.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

// AgentDash: User Feed Route
// Returns a personalized, priority-ranked feed for the authenticated user.

export function feedRoutes(db: Db) {
  const router = Router();
  const svc = feedService(db);

  router.get("/companies/:companyId/feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const userId = req.actor.userId ?? "local-board";
    try {
      const feed = await svc.getFeed(companyId, userId);
      res.json(feed);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
