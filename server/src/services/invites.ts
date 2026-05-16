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
