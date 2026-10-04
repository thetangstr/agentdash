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
import { sql } from "drizzle-orm";
import { type Db } from "@paperclipai/db";

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

/**
 * An uncompleted claim row (no user was created under it) this old can be
 * taken over: the attempt that took it died (aborted request, crash) (#812).
 */
export const CLAIM_STALE_MS = 5 * 60_000;

async function claimState(db: Db): Promise<{ users: boolean; completed: boolean }> {
  const rows = (await db.execute(sql`
    select exists (select 1 from "user") as users,
           exists (select 1 from agentdash_box_claim where completed_at is not null) as completed`)) as unknown as Array<{
    users: boolean;
    completed: boolean;
  }>;
  return { users: Boolean(rows[0]?.users), completed: Boolean(rows[0]?.completed) };
}

/**
 * Whether the box has been claimed: an account exists, or a claim completed
 * with a user (which stays true even if that user is later deleted). A claim
 * row with no user behind it is NOT a claim (#812).
 */
export async function boxClaimed(db: Db): Promise<boolean> {
  const s = await claimState(db);
  return s.users || s.completed;
}

/** Mark the claim completed once its user exists (the user.create.after hook, and MCP sign-up). */
export async function completeClaim(db: Db): Promise<void> {
  await db.execute(sql`
    update agentdash_box_claim set completed_at = now()
     where id = 'box' and completed_at is null and exists (select 1 from "user")`);
  // A user now exists: any cached pre-signup state is stale.
  invalidateClaimStateCache();
}

/**
 * Take the claim for this attempt. True for exactly one caller at a time, and
 * only while the box has no users; the loser of a race gets false. A stale,
 * uncompleted row (its attempt died) is taken over (#812).
 */
export async function takeClaim(db: Db, email: string, attempt: string, staleMs: number = CLAIM_STALE_MS): Promise<boolean> {
  const rows = await db.execute(sql`
    insert into agentdash_box_claim (id, email, attempt)
    select 'box', ${normalizeClaimEmail(email) ?? email}, ${attempt}
     where not exists (select 1 from "user")
    on conflict (id) do update
       set email = excluded.email, attempt = excluded.attempt, claimed_at = now()
     where agentdash_box_claim.completed_at is null
       and agentdash_box_claim.claimed_at < now() - ${staleMs} * interval '1 millisecond'
       and not exists (select 1 from "user")
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

// Health polls are anonymous and frequent. The whole state is cached for good
// only once a user exists (#812: never on a claim row alone); otherwise for a
// few seconds.
let claimedCache: {
  state: { users: boolean; completed: boolean };
  permanent: boolean;
  at: number;
} | null = null;

/**
 * The cached claim state, shared by `boxClaimedCached` and /api/health's
 * `hasUsers` — one EXISTS query per polling window, not one per field.
 */
export async function claimStateCached(
  db: Db,
  maxAgeMs = 10_000,
): Promise<{ users: boolean; completed: boolean }> {
  if (claimedCache?.permanent) return claimedCache.state;
  if (claimedCache && Date.now() - claimedCache.at < maxAgeMs) return claimedCache.state;
  const state = await claimState(db);
  claimedCache = { state, permanent: state.users, at: Date.now() };
  return state;
}

export async function boxClaimedCached(db: Db, maxAgeMs = 10_000): Promise<boolean> {
  const s = await claimStateCached(db, maxAgeMs);
  return s.users || s.completed;
}
/**
 * Drop the cached state. Called when a user is created: a `users:false`
 * snapshot taken before the first sign-up would otherwise keep reporting
 * `hasUsers:false`/`claimed:false` to /auth and the control plane for up to
 * the polling window.
 */
export function invalidateClaimStateCache(): void {
  claimedCache = null;
}
export function resetClaimedCacheForTests(): void {
  invalidateClaimStateCache();
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
