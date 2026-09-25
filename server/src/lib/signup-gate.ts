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
