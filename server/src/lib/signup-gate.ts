// AgentDash (#726): one parser for the sign-up gate, shared by the browser
// sign-up guard, the MCP sign-up route, the Better Auth SSO hook and the
// hosted-box boot guard. They used to parse the same variables separately (the
// boot guard trimmed, `app.ts` compared exactly), so the guard could pass a
// configuration the app then read differently.

import { timingSafeEqual } from "node:crypto";

type Env = NodeJS.ProcessEnv;

/** `"true"`, ignoring surrounding whitespace and case. Everything else is off. */
export function envFlagEnabled(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Whether browser (and, since #726, MCP) sign-up requires an invite code. */
export function signupInviteCodeRequired(env: Env = process.env): boolean {
  return envFlagEnabled(env.AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE);
}

/** Every code that opens sign-up: the general list plus the MK partner list. */
export function acceptedSignupInviteCodes(env: Env = process.env): string[] {
  return [...listFromEnv(env.AGENTDASH_INVITE_CODES), ...listFromEnv(env.AGENTDASH_MK_INVITE_CODES)];
}

/** Constant-time match against `acceptedSignupInviteCodes`. */
export function isAcceptedSignupInviteCode(candidate: string | null | undefined, env: Env = process.env): boolean {
  const trimmed = candidate?.trim() ?? "";
  if (!trimmed) return false;
  const supplied = Buffer.from(trimmed);
  return acceptedSignupInviteCodes(env).some((configured) => {
    const expected = Buffer.from(configured);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

/** Shortest invite code a hosted box accepts. */
export const MIN_HOSTED_INVITE_CODE_LENGTH = 12;

/**
 * A code that is a template placeholder or too short to resist guessing. The
 * hosted-box guard refuses to boot with one, so a pasted template fails until
 * someone fills in real codes.
 */
export function isWeakInviteCode(code: string): boolean {
  return /^changeme/i.test(code.trim()) || code.trim().length < MIN_HOSTED_INVITE_CODE_LENGTH;
}

/** MCP sign-up's remote invite validation, on unless explicitly `off`. */
export function mcpInviteValidationEnabled(env: Env = process.env): boolean {
  return (env.AGENTDASH_INVITE_VALIDATION ?? "").trim().toLowerCase() !== "off";
}

/** Self-serve bootstrap: the first user to sign up can claim the instance. */
export function selfServeBootstrapEnabled(env: Env = process.env): boolean {
  return envFlagEnabled(env.AGENTDASH_SELF_SERVE_BOOTSTRAP);
}

// AgentDash (#731): a pending company invite is itself an invitation to create
// an account. The invite token must survive the OAuth round trip for SSO
// sign-ups, so GET /api/invites/:token drops it into a first-party cookie and
// the user-create hook + the email sign-up guard both read it from there.
// Path=/api/auth keeps it off every other endpoint; SameSite=Lax still lets it
// ride the top-level GET navigation back from the provider's callback.

/** First-party cookie carrying a pending company-invite token through auth. */
export const INVITE_TOKEN_COOKIE_NAME = "agentdash_invite_token";

/** The claim only needs to outlive a sign-up sitting open in a tab. */
export const INVITE_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/** Read `agentdash_invite_token` out of a raw `Cookie` header, or null. */
export function readInviteTokenCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== INVITE_TOKEN_COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function serializeInviteTokenCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${INVITE_TOKEN_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/api/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Whether the invite cookie should carry `Secure`. GH #743 review: decide
 * from the CONFIGURED public URL, not `req.secure` — behind a TLS-
 * terminating proxy the request itself is http and the attribute would be
 * dropped exactly on the deployments that need it. No public URL → not
 * secure (plain-http dev box).
 */
export function inviteCookieSecureFlag(env: Env = process.env): boolean {
  const publicUrl =
    env.PAPERCLIP_PUBLIC_URL ??
    env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    env.BETTER_AUTH_URL ??
    env.BETTER_AUTH_BASE_URL;
  return (publicUrl ?? "").trim().toLowerCase().startsWith("https://");
}

/** Set-Cookie value that stores a pending invite token for the auth endpoints. */
export function buildInviteTokenCookie(token: string, opts: { secure: boolean }): string {
  return serializeInviteTokenCookie(token, INVITE_TOKEN_COOKIE_MAX_AGE_SECONDS, opts.secure);
}

/** Set-Cookie value that expires the invite token cookie immediately. */
export function buildInviteTokenCookieClear(opts: { secure: boolean }): string {
  return serializeInviteTokenCookie("", 0, opts.secure);
}
