import type { RequestHandler } from "express";
import {
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  type TierCapacityDeps,
  type TierCapAction,
} from "../services/tier-policy.js";

export function requireTierFor(action: TierCapAction, deps: TierCapacityDeps): RequestHandler {
  return async (req, res, next) => {
    const companyId = (req as any).companyId ?? req.params.companyId ?? (req.body as any)?.companyId;
    if (!companyId) return next();
    const blockedAction = await exceededFreeTierCapacityAction(
      deps,
      companyId,
      action === "invite" ? { humans: 1 } : { agents: 1 },
    );
    if (blockedAction) return res.status(402).json(freeTierCapExceededPayload(blockedAction));
    next();
  };
}
