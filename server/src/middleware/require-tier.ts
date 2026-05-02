import type { RequestHandler } from "express";

interface Deps {
  getCompany: (id: string) => Promise<{ planTier: string }>;
  counts: {
    humans: (companyId: string) => Promise<number>;
    agents: (companyId: string) => Promise<number>;
  };
}

const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

export function requireTierFor(action: "invite" | "hire", deps: Deps): RequestHandler {
  return async (req, res, next) => {
    const companyId = (req as any).companyId ?? req.params.companyId ?? (req.body as any)?.companyId;
    if (!companyId) return next();
    const company = await deps.getCompany(companyId);
    if (PRO_LIVE.has(company.planTier)) return next();
    if (action === "invite") {
      const humans = await deps.counts.humans(companyId);
      if (humans >= 1) {
        return res.status(402).json({
          code: "seat_cap_exceeded",
          message: "Free workspaces are limited to 1 user. Upgrade to Pro to invite teammates.",
        });
      }
    }
    if (action === "hire") {
      const agents = await deps.counts.agents(companyId);
      if (agents >= 1) {
        return res.status(402).json({
          code: "agent_cap_exceeded",
          message: "Free workspaces include only the Chief of Staff. Upgrade to Pro to hire more agents.",
        });
      }
    }
    next();
  };
}
