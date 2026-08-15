import { createHash, randomBytes } from "node:crypto";
import { isUniqueViolation, pgConstraintName, unwrapPgError } from "./pg-error.js";

/**
 * The code a person reads off a screen and types into their terminal.
 *
 * Design constraints, in the order that mattered:
 *
 *  - It gets read aloud, retyped, and photographed. So: Crockford Base32,
 *    which omits I, L, O and U precisely because they are misread as 1, 1, 0
 *    and V. Input is normalized back through those confusions, so someone who
 *    types `KVTX-8FO2` when the screen said `KVTX-8F02` still gets in.
 *  - It is short-lived and single-use, so it does not need the entropy of a
 *    long-lived credential. 8 characters is 32^8 ≈ 1.1e12; against a ten-minute
 *    window and a rate-limited endpoint that is a wide margin.
 *  - It is displayed hyphenated (`KVTX-8F02`) and accepted with or without the
 *    hyphen, in any case. The hyphen is presentation, never storage.
 *
 * Only the hash is ever persisted.
 */
export const CONNECT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CONNECT_CODE_LENGTH = 8;
export const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
export const CONNECT_CODE_MAX_RETRIES = 5;

export function hashConnectCode(code: string): string {
  return createHash("sha256").update(normalizeConnectCode(code)).digest("hex");
}

/**
 * Fold the ways a human mistypes this back onto the alphabet.
 *
 * Uppercase; drop anything that is not alphanumeric (hyphens, spaces, the
 * stray whitespace that rides along with a copy-paste); then map the four
 * characters Crockford deliberately excluded onto the digits they resemble.
 * Order matters: strip first, then substitute, or an "O" inside a stripped
 * character class survives.
 */
export function normalizeConnectCode(input: string): string {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

/** `KVTX-8F02` — how it is shown, never how it is stored. */
export function formatConnectCode(code: string): string {
  const normalized = normalizeConnectCode(code);
  if (normalized.length !== CONNECT_CODE_LENGTH) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function isWellFormedConnectCode(input: string): boolean {
  const normalized = normalizeConnectCode(input);
  if (normalized.length !== CONNECT_CODE_LENGTH) return false;
  for (const char of normalized) {
    if (!CONNECT_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Cryptographically uniform draw. `byte % 32` happens to be unbiased for a
 * 32-character alphabet since 256 is a multiple of 32, but the rejection loop
 * is kept so that changing the alphabet length later cannot silently introduce
 * the skew that `invite-tokens.ts` documents.
 */
function pickConnectCodeChar(): string {
  const max = CONNECT_CODE_ALPHABET.length;
  const ceiling = 256 - (256 % max);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const byte = randomBytes(1)[0]!;
    if (byte < ceiling) return CONNECT_CODE_ALPHABET[byte % max]!;
  }
  return CONNECT_CODE_ALPHABET[randomBytes(1)[0]! % max]!;
}

export function createConnectCode(): string {
  let code = "";
  for (let idx = 0; idx < CONNECT_CODE_LENGTH; idx += 1) {
    code += pickConnectCodeChar();
  }
  return code;
}

export function isConnectCodeHashCollisionError(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  if (pgConstraintName(error) === "agent_connect_codes_code_hash_unique_idx") return true;
  const message = unwrapPgError(error).message ?? "";
  return message.includes("agent_connect_codes_code_hash_unique_idx");
}

/**
 * What a redeeming machine calls itself, made safe to store and show.
 *
 * This lands in a key name that an administrator reads later when deciding
 * what to revoke, so it must survive being wrong: a hostile or broken client
 * can send anything, and an empty or absurd value should degrade to something
 * honest rather than produce a nameless key.
 */
export function sanitizeDeviceName(input: string | null | undefined): string {
  const cleaned = String(input ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unnamed device";
}
