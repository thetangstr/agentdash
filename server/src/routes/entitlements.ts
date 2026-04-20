// AgentDash: Entitlements routes
// - GET  exposes the merged tier + limits + features for the given company
// - PATCH is restricted to instance admins; Phase 3 replaces this
//   with a Stripe webhook that calls entitlementsService.setTier().

import { Router } from "express";
import type { Db } from "@agentdash/db";
import { TIERS, type Tier } from "@agentdash/shared";
import { entitlementsService } from "../services/entitlements.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function entitlementsRoutes(db: Db) {
  const router = Router();
  const svc = entitlementsService(db);

  router.get("/companies/:companyId/entitlements", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const entitlements = await svc.getEntitlements(companyId);
    res.json(entitlements);
  });

  router.patch("/companies/:companyId/entitlements", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("instance admin required");
    }
    const tier = (req.body as { tier?: unknown })?.tier;
    if (!isTier(tier)) {
      res.status(400).json({ error: "invalid_tier", allowed: [...TIERS] });
      return;
    }
    await svc.setTier(companyId, tier);
    const entitlements = await svc.getEntitlements(companyId);
    res.json(entitlements);
  });

  return router;
}
