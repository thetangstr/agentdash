// AgentDash (AGE-100): Free single-seat cap.
//
// Self-hosted Free deployments support exactly one human user. The first
// signup succeeds; subsequent signups are blocked with HTTP 403 and a
// friendly upgrade CTA so the UI can prompt to switch to Pro.
//
// Local-implicit board actor (CLI / dev) is exempt — it has no email and
// doesn't go through the better-auth signup endpoints anyway.
//
// Pro deployments (deploymentMode === "authenticated") leave this gate off
// because Pro orgs intentionally have more than one human.

import type { RequestHandler } from "express";
import { count } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { authUsers } from "@agentdash/db";

export interface FreeSeatCapOptions {
  enabled: boolean;
}

const SIGNUP_PATH_PREFIX = "/api/auth/sign-up";

export function freeSeatCapMiddleware(db: Db, options: FreeSeatCapOptions): RequestHandler {
  return async (req, res, next) => {
    if (!options.enabled) return next();
    if (!req.path.startsWith(SIGNUP_PATH_PREFIX)) return next();

    try {
      const [{ value }] = await db
        .select({ value: count() })
        .from(authUsers);
      if ((value ?? 0) >= 1) {
        res.status(403).json({
          code: "free_tier_seat_cap",
          error:
            "Self-hosted Free supports one human user. Upgrade to Pro to invite teammates.",
        });
        return;
      }
    } catch (err) {
      // If the seat-count query itself fails, surface a generic error rather
      // than letting better-auth proceed silently. Log via next() so the
      // upstream error handler picks it up.
      return next(err);
    }
    next();
  };
}
