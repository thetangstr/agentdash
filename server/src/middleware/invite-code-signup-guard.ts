// AgentDash: invite-code gate on browser signup.
//
// **Disabled by default.** Enable with AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true.
//
// Found by the 2026-07-31 inventory: the invite-code funnel gate protected only
// the MCP self-serve path (routes/onboarding-mcp-signup.ts). The browser path —
// Better Auth's POST /api/auth/sign-up/email — had no gate at all beyond the
// corp-email guard, which is itself off by default. A "closed" design-partner
// phase with an open signup page is not closed.
//
// Off by default on purpose: turning it on unconditionally would break every
// local dev install, the e2e suites, and every existing self-hoster the moment
// they upgraded. The operator running a closed phase opts in.
//
// The code is read from the body and DELETED before the request continues, so
// Better Auth never sees a field it does not model.

import type { RequestHandler } from "express";
// AgentDash (#726): the code list and the match live in lib/signup-gate.ts so
// the MCP sign-up route and the hosted-box boot guard read them the same way.
// Either list (general or MK) opens the door: a design partner holds an MK
// code and should not also need a general one.
import { isAcceptedSignupInviteCode } from "../lib/signup-gate.js";

const SIGNUP_PATH_PREFIX = "/sign-up";

export interface InviteCodeSignupGuardOptions {
  enabled: boolean;
}

function readInviteCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = (body as Record<string, unknown>).inviteCode;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function inviteCodeSignupGuard(options: InviteCodeSignupGuardOptions): RequestHandler {
  return (req, res, next) => {
    if (!options.enabled) return next();
    if (!req.path.startsWith(SIGNUP_PATH_PREFIX)) return next();

    const code = readInviteCode(req.body);

    // Strip before Better Auth sees the body, whether or not it was valid.
    if (req.body && typeof req.body === "object") {
      delete (req.body as Record<string, unknown>).inviteCode;
    }

    if (!code || !isAcceptedSignupInviteCode(code)) {
      // One message for missing and wrong alike: distinguishing them tells a
      // guesser whether they are close.
      res.status(403).json({
        code: "invite_code_required",
        error: "Signup on this instance requires an invite code.",
      });
      return;
    }

    next();
  };
}
