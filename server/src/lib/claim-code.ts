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
//
// #767 review: the zero-user check alone was not atomic with Better Auth's
// user insert (8 parallel claims created 8 users). The claim is now a row in
// `agentdash_box_claim`, taken with INSERT … ON CONFLICT DO NOTHING in the
// user.create.before hook: exactly one attempt wins. The row persists, so the
// code stays dead even if the user count later drops to zero.
import { randomUUID } from "node:crypto";
import { count, sql } from "drizzle-orm";
import { agentdashBoxClaim, authUsers, type Db } from "@paperclipai/db";

/** Internal request header naming one claim attempt (set by the server, stripped from clients). */
export const CLAIM_ATTEMPT_HEADER = "x-agentdash-claim-attempt";

export function newClaimAttempt(): string {
  return randomUUID();
}

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

/** Whether any account exists on this instance. */
export async function instanceHasUsers(db: Db): Promise<boolean> {
  const rows = await db.select({ n: count() }).from(authUsers);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Whether the box has been claimed: the persisted claim, or (older boxes) any account. */
export async function boxClaimed(db: Db): Promise<boolean> {
  const marker = await db.select({ id: agentdashBoxClaim.id }).from(agentdashBoxClaim).limit(1);
  return marker.length > 0 || (await instanceHasUsers(db));
}

/**
 * Take the claim for this attempt. True for exactly one caller, ever, and only
 * while the box has no users; the loser of a race gets false.
 */
export async function takeClaim(db: Db, email: string, attempt: string): Promise<boolean> {
  const rows = await db.execute(sql`
    insert into agentdash_box_claim (id, email, attempt)
    select 'box', ${normalizeClaimEmail(email) ?? email}, ${attempt}
     where not exists (select 1 from "user")
    on conflict (id) do nothing
    returning id`);
  return (rows as unknown as unknown[]).length > 0;
}

/** Whether the persisted claim belongs to this attempt. */
export async function claimHeldBy(db: Db, attempt: string): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from agentdash_box_claim where id = 'box' and attempt = ${attempt}`);
  return (rows as unknown as unknown[]).length > 0;
}

/** Give the claim back when this attempt's sign-up created no user (a failed sign-up must not lock the box). */
export async function releaseUnusedClaim(db: Db, attempt: string): Promise<void> {
  await db.execute(sql`
    delete from agentdash_box_claim
     where id = 'box' and attempt = ${attempt} and not exists (select 1 from "user")`);
}

// Health polls are anonymous and frequent: a claimed box stays claimed, so
// `true` is cached for good; `false` for a few seconds.
let claimedCache: { value: boolean; at: number } | null = null;
export async function boxClaimedCached(db: Db, maxAgeMs = 10_000): Promise<boolean> {
  if (claimedCache?.value === true) return true;
  if (claimedCache && Date.now() - claimedCache.at < maxAgeMs) return claimedCache.value;
  const value = await boxClaimed(db);
  claimedCache = { value, at: Date.now() };
  return value;
}
export function resetClaimedCacheForTests(): void {
  claimedCache = null;
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
  if (await boxClaimed(db)) {
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
