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
//
// AgentDash (#731): a pending company invite is itself an invitation to create
// an account. The invite token opens this gate too — taken from the body's
// `inviteToken` field (also stripped before Better Auth) or from the
// `agentdash_invite_token` cookie the invite-summary endpoint sets, the same
// cookie the SSO user-create hook reads.
//
// AgentDash (#743 review): two tightened semantics.
//   - `inviteOnly` mode (PAPERCLIP_AUTH_DISABLE_SIGN_UP): the box is closed —
//     Better Auth's disableSignUp is deliberately left OFF so this gate can
//     admit sign-ups carrying a valid company-invite token; shared invite
//     codes do NOT open a signup-disabled box.
//   - reserveCompanyInviteSignup atomically RESERVES the token (2-min TTL) before any user exists — the fix for parallel sign-ups on one token — and the single-use claim is written
//     by the user.create.after hook, so a sign-up that never lands cannot
//     burn the token. When the token arrived in the BODY the guard copies it
//     into the request's cookie header so the after hook sees one transport.

import type { Request, RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
// AgentDash (#726): the code list and the match live in lib/signup-gate.ts so
// the MCP sign-up route and the hosted-box boot guard read them the same way.
// Either list (general or MK) opens the door: a design partner holds an MK
// code and should not also need a general one.
import {
  INVITE_TOKEN_COOKIE_NAME,
  isAcceptedSignupInviteCode,
  readInviteTokenCookie,
} from "../lib/signup-gate.js";
import {
  releaseCompanyInviteSignup,
  reserveCompanyInviteSignup,
} from "../services/invites.js";
import { logger } from "./logger.js";

const SIGNUP_PATH_PREFIX = "/sign-up";

export interface InviteCodeSignupGuardOptions {
  enabled: boolean;
  /**
   * AgentDash (#743 review): true when PAPERCLIP_AUTH_DISABLE_SIGN_UP is set —
   * public sign-up is closed and ONLY a pending company-invite token opens it
   * (shared invite codes do not). Independent of `enabled`; when both are set
   * this stricter mode wins.
   */
  inviteOnly?: boolean;
  /** Required for the company-invite token path; without it only codes pass. */
  db?: Db;
}

function readBodyField(body: unknown, field: string): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = (body as Record<string, unknown>)[field];
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Copy a body-delivered invite token into the request's Cookie header so the
 * Better Auth user.create.after hook — which only sees request headers — can
 * write the single-use claim. No-op when the cookie already carries a token.
 */
function injectInviteTokenCookie(req: Request, token: string): void {
  const existing = readInviteTokenCookie(req.headers.cookie ?? null);
  if (existing === token) return;
  // Replace, not append: a stale invite cookie read by readInviteTokenCookie
  // would shadow the body token the gate just authorized.
  const rest = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=")[0]?.trim() !== INVITE_TOKEN_COOKIE_NAME);
  rest.push(`${INVITE_TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}`);
  req.headers.cookie = rest.join("; ");
}

function refuse(res: Parameters<RequestHandler>[1]) {
  // One message for missing, wrong, and unusable credentials alike:
  // distinguishing them tells a guesser whether they are close.
  res.status(403).json({
    code: "invite_code_required",
    error: "Signup on this instance requires an invite code.",
  });
}

export function inviteCodeSignupGuard(options: InviteCodeSignupGuardOptions): RequestHandler {
  return (req, res, next) => {
    const inviteOnly = options.inviteOnly === true;
    if (!options.enabled && !inviteOnly) return next();
    if (!req.path.startsWith(SIGNUP_PATH_PREFIX)) return next();

    const code = readBodyField(req.body, "inviteCode");
    const tokenFromBody = readBodyField(req.body, "inviteToken");
    const email = readBodyField(req.body, "email");

    // Strip before Better Auth sees the body, whether or not they were valid.
    if (req.body && typeof req.body === "object") {
      delete (req.body as Record<string, unknown>).inviteCode;
      delete (req.body as Record<string, unknown>).inviteToken;
    }

    // A shared instance code opens the design-partner gate — but never a
    // signup-disabled box (inviteOnly), where only a company invite admits.
    if (!inviteOnly && code && isAcceptedSignupInviteCode(code)) return next();

    const token = tokenFromBody ?? readInviteTokenCookie(req.headers.cookie ?? null);
    const authorizeInvite = async () => {
      if (!options.db || !token) return false;
      return reserveCompanyInviteSignup(options.db, token, email);
    };

    void authorizeInvite()
      .then((ok) => {
        if (ok) {
          // Body-delivered tokens are invisible to the create.after claim
          // hook — normalize them onto the cookie transport.
          if (tokenFromBody) injectInviteTokenCookie(req, tokenFromBody);
          // GH #743 re-review: the reservation was taken BEFORE the auth
          // layer ran. If that layer refuses the sign-up (weak password,
          // duplicate account) or the client hangs up mid-request, release
          // the hold so the token isn't parked for the TTL. A completed
          // sign-up has already written the claim, which the release CAS
          // refuses to touch.
          if (options.db && token && email) {
            let released = false;
            const release = () => {
              if (released || !options.db || !token || !email) return;
              released = true;
              void releaseCompanyInviteSignup(options.db, token, email).catch(
                (err: unknown) => {
                  logger.warn(
                    { error: err instanceof Error ? err.message : String(err) },
                    "[signup-gate] failed to release invite reservation",
                  );
                },
              );
            };
            res.once("finish", () => {
              if (res.statusCode >= 400) release();
            });
            res.once("close", () => {
              if (!res.writableEnded) release();
            });
          }
          next();
          return;
        }
        refuse(res);
      })
      .catch(next);
  };
}
