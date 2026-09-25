// AgentDash (#TBD): minimal invite-creation service.
//
// The full invite flow lives in `server/src/routes/access.ts` and
// includes branding, agent-message rendering, OpenClaw prompt synthesis,
// and per-actor permission checks. None of that helper code is exported,
// so other route modules can't reuse it without copy/paste.
//
// This service exposes the *minimum* primitive — "create a company-join
// invite token for company X, attribute it to user Y, optionally tag it
// with the recipient's email" — so the onboarding wizard and any future
// programmatic caller can stop reinventing the create-invite loop.
//
// Why a service and not a shared helper inside access.ts:
//   - access.ts is already ~3800 lines; adding another export grows the
//     "everything is in access.ts" problem.
//   - The route file mixes auth, validation, branding, and persistence;
//     this service does only persistence so it's testable in isolation.
//   - Future cleanup can collapse access.ts's `createCompanyInviteForCompany`
//     to delegate here, but that's a bigger refactor and not required to
//     unblock the onboarding-wizard customer-facing fix.

import type { Db } from "@paperclipai/db";
import { invites } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  COMPANY_INVITE_TTL_MS,
  INVITE_TOKEN_MAX_RETRIES,
  createInviteToken,
  hashToken,
  isInviteTokenHashCollisionError,
} from "../lib/invite-tokens.js";
import { isHostedBox } from "./license.js";

export type CreateCompanyInviteInput = {
  companyId: string;
  invitedByUserId: string | null;
  /** Recipient's email — recorded in defaultsPayload for audit/UX, not enforced. */
  email?: string | null;
  /** Defaults to "both" (humans + agents may redeem). */
  allowedJoinTypes?: "human" | "agent" | "both";
  /**
   * AgentDash: auto-approve-invites — when true, a human accepting this invite
   * is granted active membership immediately (no admin approval). Defaults false.
   */
  autoApprove?: boolean;
};

export type CreateCompanyInviteOutput = {
  id: string;
  token: string;
  expiresAt: Date;
};

export function inviteService(db: Db) {
  return {
    /**
     * Insert a company_join invite row and return its ID + plaintext token.
     * The plaintext token is only returned here; storage hashes it.
     */
    async createCompanyInvite(
      input: CreateCompanyInviteInput,
    ): Promise<CreateCompanyInviteOutput> {
      const expiresAt = new Date(Date.now() + COMPANY_INVITE_TTL_MS);
      const boundEmail =
        input.email && input.email.trim()
          ? input.email.trim().toLowerCase()
          : null;
      // GH #743 re-review: on hosted boxes an auto-approving human-capable
      // invite without an email binding would let ANYONE holding the link
      // create an account and land in the company with active membership.
      // Require the binding so accept-time enforcement has something to
      // check against. Agent-only invites are exempt — auto-approve only
      // applies to human acceptance.
      if (
        input.autoApprove === true &&
        (input.allowedJoinTypes ?? "both") !== "agent" &&
        isHostedBox() &&
        !boundEmail
      ) {
        throw new Error("hosted_auto_approve_requires_email");
      }
      const defaultsPayload = boundEmail ? { email: boundEmail } : null;

      for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
        const token = createInviteToken();
        try {
          const [row] = await db
            .insert(invites)
            .values({
              companyId: input.companyId,
              inviteType: "company_join",
              allowedJoinTypes: input.allowedJoinTypes ?? "both",
              autoApprove: input.autoApprove ?? false,
              defaultsPayload,
              expiresAt,
              invitedByUserId: input.invitedByUserId,
              tokenHash: hashToken(token),
            })
            .returning();
          if (!row) throw new Error("invite_insert_returned_no_row");
          return { id: row.id, token, expiresAt };
        } catch (error) {
          if (!isInviteTokenHashCollisionError(error)) throw error;
        }
      }
      throw new Error("invite_token_collision_retries_exhausted");
    },
  };
}

// AgentDash (#731): company invites bypass the hosted signup gate.
//
// A pending company_join invite IS an invitation to create an account — the
// invitee cannot accept it without one — so the signup gates (the browser
// email guard, which is also the only gate on a signup-disabled box, and
// the SSO user-create hook) accept the invite token as an alternative
// credential to the shared instance codes. Three rules keep the door
// narrow:
//
//   1. The invite must be pending: company_join, human-joinable, not revoked,
//      not expired, not already accepted.
//   2. If the invite was addressed to a specific email (defaultsPayload.email),
//      only that email may sign up with it.
//   3. The token is single-use for account creation, enforced in TWO
//      atomic steps (GH #743 re-review — a read-only check let N parallel
//      sign-ups on one token all create accounts):
//      a. RESERVE — the gate (browser guard / SSO user-create hook) runs a
//         CAS update writing signupReservedEmail + signupReservedUntil
//         (2-minute TTL) BEFORE any user exists. Only one email can hold the
//         reservation at a time; a second concurrent email's CAS writes
//         nothing and is refused. A sign-up that fails leaves the
//         reservation until it expires — the TTL is the release, and
//         same-email retries refresh it.
//      b. CLAIM — the user.create.after hook writes
//         defaultsPayload.signupClaimedEmail with a CAS update. A second
//         completed sign-up with a different email fails the CAS.
//
// The claim's and reservation's WHERE clauses re-verify every validity
// predicate, so a stale verdict cannot outlive the check that produced it.
//
// The reservation/claim live in defaultsPayload rather than new columns
// because they are short-lived gate metadata, never rendered by the invite
// summary responses, and invite expiry (72h) bounds the rows anyway.

/** defaultsPayload key recording which email claimed this token at sign-up. */
export const INVITE_SIGNUP_CLAIM_KEY = "signupClaimedEmail";

/** defaultsPayload keys recording the pending sign-up reservation. */
export const INVITE_SIGNUP_RESERVE_EMAIL_KEY = "signupReservedEmail";
export const INVITE_SIGNUP_RESERVE_UNTIL_KEY = "signupReservedUntil";

/** How long a reserved token is held for an in-flight sign-up. */
export const INVITE_SIGNUP_RESERVATION_TTL_MS = 2 * 60 * 1000;

/** The email this invite was addressed to, or null when it is unbound. */
export function inviteSignupBoundEmail(
  invite: Pick<typeof invites.$inferSelect, "defaultsPayload">,
): string | null {
  const payload = invite.defaultsPayload;
  if (!payload || typeof payload !== "object") return null;
  const email = (payload as Record<string, unknown>).email;
  if (typeof email !== "string" || !email.trim()) return null;
  return email.trim().toLowerCase();
}

/** The email that claimed this token at sign-up, or null when unclaimed. */
export function inviteSignupClaimedEmail(
  invite: Pick<typeof invites.$inferSelect, "defaultsPayload">,
): string | null {
  const payload = invite.defaultsPayload;
  if (!payload || typeof payload !== "object") return null;
  const email = (payload as Record<string, unknown>)[INVITE_SIGNUP_CLAIM_KEY];
  if (typeof email !== "string" || !email.trim()) return null;
  return email.trim().toLowerCase();
}

/** The email holding the pending sign-up reservation, or null. */
export function inviteSignupReservedEmail(
  invite: Pick<typeof invites.$inferSelect, "defaultsPayload">,
): string | null {
  const payload = invite.defaultsPayload;
  if (!payload || typeof payload !== "object") return null;
  const email = (payload as Record<string, unknown>)[INVITE_SIGNUP_RESERVE_EMAIL_KEY];
  if (typeof email !== "string" || !email.trim()) return null;
  return email.trim().toLowerCase();
}

function inviteSignupValidityPredicate(invite: typeof invites.$inferSelect): boolean {
  return Boolean(
    invite.companyId &&
      invite.inviteType === "company_join" &&
      invite.allowedJoinTypes !== "agent" &&
      !invite.revokedAt &&
      !invite.acceptedAt &&
      invite.expiresAt.getTime() > Date.now(),
  );
}

async function findInviteBySignupToken(db: Db, token: string) {
  return db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(token.trim())))
    .then((rows) => rows[0] ?? null);
}

/** SQL fragment: token either unclaimed, or claimed by `email`. The outer
 * parens are load-bearing — inside `and(...)`, an unwrapped top-level OR
 * would escape every other predicate. */
function unclaimedOrSameEmail(email: string) {
  return sql`((${invites.defaultsPayload} ->> ${INVITE_SIGNUP_CLAIM_KEY}) IS NULL
    OR lower(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_CLAIM_KEY}) = ${email})`;
}

/** SQL fragment: no live reservation, or this email holds it / TTL lapsed.
 * Same parenthesization contract as `unclaimedOrSameEmail`. */
function unreservedOrSameEmail(email: string, nowIso: string) {
  return sql`((${invites.defaultsPayload} ->> ${INVITE_SIGNUP_RESERVE_EMAIL_KEY}) IS NULL
    OR lower(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_RESERVE_EMAIL_KEY}) = ${email}
    OR coalesce(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_RESERVE_UNTIL_KEY}, '') < ${nowIso})`;
}

/**
 * Atomically RESERVE `token` for `email`'s in-flight sign-up — the gate
 * admission, run BEFORE any user row exists (GH #743 re-review: the prior
 * read-only check let parallel sign-ups on one token all create accounts).
 * The CAS wins only when the token is pending, unclaimed-or-same-email, and
 * not held by a different email's live reservation; it re-checks every
 * validity predicate in the WHERE so the read above cannot go stale.
 * Returns false for every refusal; callers intentionally cannot
 * distinguish them (same response as a missing/invalid invite code).
 */
export async function reserveCompanyInviteSignup(
  db: Db,
  token: string,
  email: string | null | undefined,
): Promise<boolean> {
  const normalizedEmail = email?.trim().toLowerCase();
  const trimmedToken = token.trim();
  if (!trimmedToken || !normalizedEmail) return false;

  const invite = await findInviteBySignupToken(db, trimmedToken);
  if (!invite || !inviteSignupValidityPredicate(invite)) return false;
  const boundEmail = inviteSignupBoundEmail(invite);
  if (boundEmail && boundEmail !== normalizedEmail) return false;
  const claimedEmail = inviteSignupClaimedEmail(invite);
  if (claimedEmail && claimedEmail !== normalizedEmail) return false;

  const reservedUntil = new Date(
    Date.now() + INVITE_SIGNUP_RESERVATION_TTL_MS,
  ).toISOString();
  const reserved = await db
    .update(invites)
    .set({
      defaultsPayload: sql`jsonb_set(
        jsonb_set(
          coalesce(${invites.defaultsPayload}, '{}'::jsonb),
          ${`{${INVITE_SIGNUP_RESERVE_EMAIL_KEY}}`}::text[],
          to_jsonb(${normalizedEmail}::text)
        ),
        ${`{${INVITE_SIGNUP_RESERVE_UNTIL_KEY}}`}::text[],
        to_jsonb(${reservedUntil}::text)
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invites.id, invite.id),
        eq(invites.inviteType, "company_join"),
        sql`${invites.allowedJoinTypes} <> 'agent'`,
        sql`${invites.revokedAt} IS NULL`,
        sql`${invites.acceptedAt} IS NULL`,
        sql`${invites.expiresAt} > now()`,
        unclaimedOrSameEmail(normalizedEmail),
        // Free to take: nobody holds it, the same email is retrying, or the
        // previous holder's TTL lapsed. ISO-8601 strings compare correctly.
        unreservedOrSameEmail(normalizedEmail, new Date().toISOString()),
      ),
    )
    .returning({ id: invites.id });
  return reserved.length > 0;
}

/**
 * RELEASE `email`'s pending reservation on `token` — called when a sign-up
 * the gate admitted failed before the user row existed, so the token is
 * spendable again immediately instead of waiting out the TTL. The CAS only
 * fires while THIS email still holds an unclaimed reservation, so it can
 * never stomp a completed claim or another email's newer hold.
 */
export async function releaseCompanyInviteSignup(
  db: Db,
  token: string,
  email: string | null | undefined,
): Promise<void> {
  const normalizedEmail = email?.trim().toLowerCase();
  const trimmedToken = token.trim();
  if (!trimmedToken || !normalizedEmail) return;

  const invite = await findInviteBySignupToken(db, trimmedToken);
  if (!invite) return;

  await db
    .update(invites)
    .set({
      defaultsPayload: sql`coalesce(${invites.defaultsPayload}, '{}'::jsonb)
        - ${INVITE_SIGNUP_RESERVE_EMAIL_KEY}
        - ${INVITE_SIGNUP_RESERVE_UNTIL_KEY}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invites.id, invite.id),
        sql`lower(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_RESERVE_EMAIL_KEY}) = ${normalizedEmail}`,
        sql`(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_CLAIM_KEY}) IS NULL`,
      ),
    );
}

/**
 * Claim `token` to `email` — the single-use finalize, executed AFTER the
 * user row exists (the reservation is the gate; this CAS is the audit).
 * The WHERE clause re-checks revocation, acceptance, expiry AND that no
 * different email holds the reservation (GH #743 review): a token revoked
 * or taken over between the gate and this update simply writes nothing
 * rather than stamping a claim on a dead invite. Returns false when
 * nothing was claimed — callers only log; the account exists by then.
 */
export async function claimCompanyInviteSignup(
  db: Db,
  token: string,
  email: string | null | undefined,
): Promise<boolean> {
  const normalizedEmail = email?.trim().toLowerCase();
  const trimmedToken = token.trim();
  if (!trimmedToken || !normalizedEmail) return false;

  const invite = await findInviteBySignupToken(db, trimmedToken);
  if (!invite) return false;

  const claimed = await db
    .update(invites)
    .set({
      defaultsPayload: sql`jsonb_set(
        coalesce(${invites.defaultsPayload}, '{}'::jsonb),
        ${`{${INVITE_SIGNUP_CLAIM_KEY}}`}::text[],
        to_jsonb(${normalizedEmail}::text)
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invites.id, invite.id),
        eq(invites.inviteType, "company_join"),
        sql`${invites.allowedJoinTypes} <> 'agent'`,
        sql`${invites.revokedAt} IS NULL`,
        sql`${invites.acceptedAt} IS NULL`,
        sql`${invites.expiresAt} > now()`,
        unclaimedOrSameEmail(normalizedEmail),
        sql`((${invites.defaultsPayload} ->> ${INVITE_SIGNUP_RESERVE_EMAIL_KEY}) IS NULL
          OR lower(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_RESERVE_EMAIL_KEY}) = ${normalizedEmail})`,
      ),
    )
    .returning({ id: invites.id });
  return claimed.length > 0;
}
