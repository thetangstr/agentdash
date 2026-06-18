import type { Request, Response, NextFunction } from "express";
import { deploymentKind, licenseStatusFromEnv } from "../services/license.js";

// AgentDash (On-prem SKU, G2): privileged-route license gate.
//
// Opt-in via AGENTDASH_ENFORCE_LICENSE=true so existing installs and the
// on-prem reference box are never broken until a license is provisioned. When
// enforcement is on AND this process is an on_prem deployment, an invalid or
// missing license returns 402. Cloud deployments are never gated here (they're
// gated by Stripe entitlements instead).
export function requireLicense(req: Request, res: Response, next: NextFunction): void {
  if (process.env.AGENTDASH_ENFORCE_LICENSE !== "true") return next();
  if (deploymentKind() !== "on_prem") return next();

  const status = licenseStatusFromEnv();
  if (status.valid) return next();

  res.status(402).json({ error: "license_required", reason: status.reason });
}
