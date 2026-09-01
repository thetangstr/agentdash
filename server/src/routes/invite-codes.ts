// AgentDash: invite-code validation — the cloud side of the fresh-install
// funnel gate.
//
// POST /api/invites/validate {code} → 200 {valid: boolean}
//
// Fresh self-hosted installs call this endpoint (on www.agentdash.cloud by
// default) from POST /api/onboarding/mcp-signup before creating the founding
// user, so handing out invite codes controls who can claim new instances
// through our funnel. The code list lives in AGENTDASH_INVITE_CODES
// (comma-separated) on the instance serving validation — no DB table until
// codes need lifecycle (single-use, expiry); this is deliberately the seed
// of the future license/entitlement service.
//
// Design notes:
// - Always 200 with {valid} (except rate-limit/body errors): a 403 here
//   would be indistinguishable from network-level failures to the caller,
//   and we want callers to fail closed on transport errors but treat a
//   definitive {valid:false} as "wrong code".
// - Constant-shape response; no hint whether codes are configured at all.
// - Auth-tier rate limiter: this is a guessing target.

import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DeploymentMode } from "@paperclipai/shared";
import { createAuthRateLimiter } from "../middleware/rate-limit.js";

const validateBodySchema = z.object({
  code: z.string().trim().min(1).max(120),
});

function configuredInviteCodes(): string[] {
  return (process.env.AGENTDASH_INVITE_CODES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function codeMatches(candidate: string, configured: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InviteCodeRoutesOptions {
  deploymentMode: DeploymentMode;
}

export function inviteCodeRoutes(opts: InviteCodeRoutesOptions) {
  const router = Router();

  router.post(
    "/invites/validate",
    createAuthRateLimiter({ deploymentMode: opts.deploymentMode }),
    (req, res) => {
      const parsed = validateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: "invalid_body",
          error: "Body must be { code: 1-120 chars }.",
        });
        return;
      }
      const codes = configuredInviteCodes();
      const valid = codes.some((c) => codeMatches(parsed.data.code, c));
      res.json({ valid });
    },
  );

  return router;
}
