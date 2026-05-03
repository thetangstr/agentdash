// AgentDash: corp-email signup guard.
//
// **Disabled by default as of 2026-05-03.** Both Free and Pro users may
// sign up with any email domain. The middleware is still wired so a
// self-hoster who wants to require work emails can flip
// `AGENTDASH_REQUIRE_CORP_EMAIL=true` (see server/src/index.ts) to
// re-enforce without a code change.
//
// Original rationale (AGE-60 / AGE-104): Pro deployments rejected
// gmail/yahoo/outlook signups at the company-creation step, which
// surfaced the error AFTER the user already had an account. This
// middleware moved the rule to the signup endpoint so the friendly
// inline error rendered BEFORE the user committed. With the rule now
// off, both code paths short-circuit on `enabled: false`.
//
// Auth.tsx still maps the `pro_requires_corp_email` code to a dedicated
// inline message in case a self-hoster turns the rule back on.

import type { RequestHandler } from "express";
import { FREE_MAIL_DOMAINS } from "@paperclipai/shared";

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
