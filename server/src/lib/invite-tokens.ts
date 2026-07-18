import { createHash, randomBytes } from "node:crypto";
import { isUniqueViolation, pgConstraintName, unwrapPgError } from "./pg-error.js";

export const INVITE_TOKEN_PREFIX = "pcp_invite_";
export const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const INVITE_TOKEN_SUFFIX_LENGTH = 16;
export const INVITE_TOKEN_MAX_RETRIES = 5;
export const COMPANY_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Cryptographically uniform draw from `INVITE_TOKEN_ALPHABET`.
 *
 * Naive `byte % 36` skews the first four chars high because 256 mod 36 = 4.
 * Reject the partial bucket and redraw instead.
 */
function pickInviteTokenChar(): string {
  const max = INVITE_TOKEN_ALPHABET.length;
  const ceiling = 256 - (256 % max);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const byte = randomBytes(1)[0]!;
    if (byte < ceiling) return INVITE_TOKEN_ALPHABET[byte % max]!;
  }
  return INVITE_TOKEN_ALPHABET[randomBytes(1)[0]! % max]!;
}

export function createInviteToken(): string {
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += pickInviteTokenChar();
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

export function isInviteTokenHashCollisionError(error: unknown): boolean {
  // drizzle-orm >=0.45 wraps the pg error in DrizzleQueryError; unwrap the
  // cause chain before inspecting the SQLSTATE code / constraint name.
  if (!isUniqueViolation(error)) return false;
  if (pgConstraintName(error) === "invites_token_hash_unique_idx") return true;
  const message = unwrapPgError(error).message ?? "";
  return message.includes("invites_token_hash_unique_idx");
}
