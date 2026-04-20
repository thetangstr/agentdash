// AgentDash: requireTier middleware
// Gates routes behind a minimum tier. Pulls the current tier from the
// entitlements service and responds with 402 Payment Required when the
// company is below the floor.

import type { RequestHandler } from "express";
import type { Db } from "@agentdash/db";
import { tierAtLeast, type Tier } from "@agentdash/shared";
import { entitlementsService } from "../services/entitlements.js";

export function requireTier(db: Db, min: Tier): RequestHandler {
  const svc = entitlementsService(db);
  return async (req, res, next) => {
    const companyId = (req.params as { companyId?: string }).companyId;
    if (!companyId) {
      res.status(400).json({ error: "companyId required" });
      return;
    }
    try {
      const tier = await svc.getTier(companyId);
      if (!tierAtLeast(tier, min)) {
        res.status(402).json({
          error: "tier_insufficient",
          currentTier: tier,
          requiredTier: min,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
