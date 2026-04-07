import { Router } from "express";
import type { Db } from "@agentdash/db";
import { inboxService } from "../services/inbox.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function inboxRoutes(db: Db) {
  const router = Router();
  const svc = inboxService(db);

  // AgentDash: List inbox items
  router.get("/companies/:companyId/inbox", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const rawStatus = (req.query.status as string) ?? "all";
    const validStatuses = ["pending", "approved", "rejected", "all"] as const;
    type InboxStatus = (typeof validStatuses)[number];
    const status: InboxStatus = (validStatuses as readonly string[]).includes(rawStatus)
      ? (rawStatus as InboxStatus)
      : "all";

    const filters = {
      status,
      agentId: req.query.agentId as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    };

    const items = await svc.listRecent(companyId, filters);
    res.json(items);
  });

  // AgentDash: Pending count
  router.get("/companies/:companyId/inbox/count", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);
    const count = await svc.pendingCount(companyId);
    res.json({ count });
  });

  // AgentDash: Get inbox item detail
  router.get("/companies/:companyId/inbox/:actionId", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);
    const item = await svc.getDetail(req.params.actionId);
    if (!item) {
      res.status(404).json({ error: "Action not found" });
      return;
    }
    res.json(item);
  });

  // AgentDash: Approve action
  router.post("/companies/:companyId/inbox/:actionId/approve", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const result = await svc.approve(
      req.params.actionId,
      actor.actorId,
      req.body.decisionNote,
    );
    res.json(result);
  });

  // AgentDash: Reject action
  router.post("/companies/:companyId/inbox/:actionId/reject", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const result = await svc.reject(
      req.params.actionId,
      actor.actorId,
      req.body.reason,
    );
    res.json(result);
  });

  return router;
}
