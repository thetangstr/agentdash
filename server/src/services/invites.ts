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
      const defaultsPayload =
        input.email && input.email.trim()
          ? { email: input.email.trim().toLowerCase() }
          : null;

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
// invitee cannot accept it without one — so the signup gates (browser email
// guard, MCP signup, and the SSO user-create hook) accept the invite token as
// an alternative credential to the shared instance codes. Three rules keep
// the door narrow:
//
//   1. The invite must be pending: company_join, human-joinable, not revoked,
//      not expired, not already accepted.
//   2. If the invite was addressed to a specific email (defaultsPayload.email),
//      only that email may sign up with it.
//   3. The token is single-use for account creation: the first sign-up claims
//      it by writing the email into defaultsPayload.signupClaimedEmail with a
//      compare-and-set update. A second sign-up with a different email fails
//      the CAS and is refused; the same email may retry a failed attempt.
//
// The claim lives in defaultsPayload rather than a new column because it is
// audit metadata about a short-lived state, never rendered by the invite
// summary responses, and invite expiry (72h) bounds the rows anyway.

/** defaultsPayload key recording which email claimed this token at sign-up. */
export const INVITE_SIGNUP_CLAIM_KEY = "signupClaimedEmail";

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

/**
 * Whether `token` entitles `email` to create an account on a gated instance.
 * Authorizing CLAIMS the token to that email (see above) — callers must only
 * invoke this at the point they would otherwise let the sign-up through.
 * Returns false for every refusal; callers intentionally cannot distinguish
 * them (same response as a missing/invalid invite code).
 */
export async function authorizeCompanyInviteSignup(
  db: Db,
  token: string,
  email: string | null | undefined,
): Promise<boolean> {
  const normalizedEmail = email?.trim().toLowerCase();
  const trimmedToken = token.trim();
  if (!trimmedToken || !normalizedEmail) return false;

  const invite = await db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(trimmedToken)))
    .then((rows) => rows[0] ?? null);
  if (
    !invite ||
    !invite.companyId ||
    invite.inviteType !== "company_join" ||
    invite.allowedJoinTypes === "agent" ||
    invite.revokedAt ||
    invite.acceptedAt ||
    invite.expiresAt.getTime() <= Date.now()
  ) {
    return false;
  }
  const boundEmail = inviteSignupBoundEmail(invite);
  if (boundEmail && boundEmail !== normalizedEmail) return false;

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
        sql`(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_CLAIM_KEY}) IS NULL
          OR lower(${invites.defaultsPayload} ->> ${INVITE_SIGNUP_CLAIM_KEY}) = ${normalizedEmail}`,
      ),
    )
    .returning({ id: invites.id });
  return claimed.length > 0;
}
