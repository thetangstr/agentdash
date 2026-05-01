// AgentDash (AGE-104 follow-up): corp-email signup guard.
//
// Pro deployments (deploymentMode === "authenticated") reject signups from
// free-mail providers (gmail, yahoo, outlook, ...). Until now this only
// fired at company-creation time (AGE-60), which surfaced the error AFTER
// the user had already created an account — too late to act on the
// "use your work email" hint. This middleware moves the same rule to the
// signup endpoint so the friendly inline error renders BEFORE the user
// commits to an account.
//
// The Auth.tsx form already maps the `pro_requires_corp_email` code to a
// dedicated inline message (see ui/src/pages/Auth.tsx).

import type { RequestHandler } from "express";
import { FREE_MAIL_DOMAINS } from "@agentdash/shared";

export interface CorpEmailSignupGuardOptions {
  enabled: boolean;
}

const SIGNUP_PATH_PREFIX = "/api/auth/sign-up";

export function corpEmailSignupGuard(options: CorpEmailSignupGuardOptions): RequestHandler {
  return (req, res, next) => {
    if (!options.enabled) return next();
    if (!req.path.startsWith(SIGNUP_PATH_PREFIX)) return next();

    const email = readEmailFromBody(req.body);
    if (!email) return next();

    const at = email.lastIndexOf("@");
    if (at < 0) return next();
    const domain = email.slice(at + 1).trim().toLowerCase();
    if (!FREE_MAIL_DOMAINS.has(domain)) return next();

    res.status(400).json({
      code: "pro_requires_corp_email",
      error:
        "Pro accounts require a company email. Please sign up with your work email or use the Free self-hosted plan.",
    });
  };
}

function readEmailFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = (body as Record<string, unknown>).email;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
