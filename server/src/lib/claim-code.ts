// AgentDash (#767, SC-6): the one-time claim link of a hosted box
// (self-serve cloud spec §3.5).
//
// The control plane provisions a box with an instance invite code (the claim
// code, AGENTDASH_INVITE_CODES) and AGENTDASH_CLAIM_EMAIL, the email the
// person verified at signup. While AGENTDASH_CLAIM_EMAIL is set, an instance
// invite code opens sign-up only:
//   - for that email (case-insensitive, trimmed), and
//   - while the box has ZERO users.
// The first sign-up therefore kills the code on the spot, with no restart:
// the "not single-use" gap of the hand-run claim (runbook §11) is closed.
// Company invite tokens (#743) are a different credential and unaffected.
// When AGENTDASH_CLAIM_EMAIL is unset (every self-hosted or on-prem install)
// nothing here applies.
import { count } from "drizzle-orm";
import { authUsers, type Db } from "@paperclipai/db";

type Env = NodeJS.ProcessEnv;

export function normalizeClaimEmail(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** The email the claim code is bound to, or null when no claim binding applies. */
export function configuredClaimEmail(env: Env = process.env): string | null {
  return normalizeClaimEmail(env.AGENTDASH_CLAIM_EMAIL);
}

export function claimEmailMatches(email: string | null | undefined, env: Env = process.env): boolean {
  const bound = configuredClaimEmail(env);
  const candidate = normalizeClaimEmail(email);
  return bound !== null && candidate !== null && candidate === bound;
}

/** Whether any account exists on this instance (the box is claimed). */
export async function instanceHasUsers(db: Db): Promise<boolean> {
  const rows = await db.select({ n: count() }).from(authUsers);
  return Number(rows[0]?.n ?? 0) > 0;
}

export type ClaimCheck =
  | { ok: true }
  | { ok: false; status: number; code: "claim_email_mismatch" | "claim_code_used"; error: string };

/**
 * Check a sign-up that presented a VALID instance invite code. The specific
 * reasons are safe to return: only a holder of the code reaches this point.
 */
export async function checkClaimSignup(db: Db, email: string | null | undefined, env: Env = process.env): Promise<ClaimCheck> {
  if (!configuredClaimEmail(env)) return { ok: true };
  if (await instanceHasUsers(db)) {
    return {
      ok: false,
      status: 409,
      code: "claim_code_used",
      error: "This claim link has already been used. Sign in with the account that claimed this workspace.",
    };
  }
  if (!claimEmailMatches(email, env)) {
    return {
      ok: false,
      status: 403,
      code: "claim_email_mismatch",
      error: "This claim link belongs to a different email address. Use the email you signed up with.",
    };
  }
  return { ok: true };
}
