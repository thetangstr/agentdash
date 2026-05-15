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

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { invites } from "@paperclipai/db";

// Same constants access.ts uses. Kept in sync deliberately — invite tokens
// are user-visible and the prefix `pcp_invite_` is documented in onboarding
// emails / CLI prompts. If access.ts evolves these, this file must follow.
//
// Followup: extract the token primitives into a shared module so access.ts
// and this service stop drifting (tracked in repo issues).
const INVITE_TOKEN_PREFIX = "pcp_invite_";
const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
// 16 chars × log2(36) ≈ 82.7 bits of entropy. access.ts still uses 8
// (~41 bits) which is acceptable when paired with a redeem rate-limit
// but tight; the new service starts at the safer ceiling so callers that
// adopt these primitives don't inherit the weaker default.
const INVITE_TOKEN_SUFFIX_LENGTH = 16;
const INVITE_TOKEN_MAX_RETRIES = 5;
const COMPANY_INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72h, matches access.ts.

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Cryptographically uniform draw from `INVITE_TOKEN_ALPHABET`. Naïve
 * `byte % 36` skews the first four chars ~1.4% high (256 mod 36 = 4).
 * Reject any byte in the partial bucket and redraw — bias-free at the
 * cost of an expected ~4/256 = 1.6% retry rate per char.
 */
function pickAlphabetChar(): string {
  const max = INVITE_TOKEN_ALPHABET.length;
  const ceiling = 256 - (256 % max); // largest multiple of 36 ≤ 256 = 252
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const byte = randomBytes(1)[0]!;
    if (byte < ceiling) return INVITE_TOKEN_ALPHABET[byte % max]!;
  }
  // (4/256)^8 ≈ 1.5e-12 — practically unreachable, but bounded.
  return INVITE_TOKEN_ALPHABET[randomBytes(1)[0]! % max]!;
}

function createInviteToken(): string {
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += pickAlphabetChar();
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function isInviteTokenHashCollisionError(error: unknown): boolean {
  // Postgres unique-constraint violation. We retry to dodge the (vanishingly
  // rare) randBytes hash collision rather than surfacing a 5xx.
  const code = (error as { code?: string } | null)?.code;
  return code === "23505";
}

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
