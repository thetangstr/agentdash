import { createHash, randomBytes } from "node:crypto";

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
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    if (code !== "23505") continue;
    if (constraint === "invites_token_hash_unique_idx") return true;
    if (message.includes("invites_token_hash_unique_idx")) return true;
  }
  return false;
}
