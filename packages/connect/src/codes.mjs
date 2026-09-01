/**
 * Recognising a connect code, client-side.
 *
 * This deliberately mirrors `server/src/lib/connect-codes.ts` rather than
 * importing it — the CLI has zero dependencies and must not grow a link into
 * the server package. The two only need to agree on shape, and the server is
 * the authority on validity: a code that looks right here and is rejected
 * there is a normal outcome, not a bug.
 *
 * The point of telling a code from a key is that they warrant different
 * handling. A code is ten-minute, single-use, and therefore safe as a command
 * line argument. An agent key is long-lived, so it is only ever read from the
 * terminal with echo off.
 */

const CONNECT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CONNECT_CODE_LENGTH = 8;

/** Fold a mistyped code back onto the alphabet. Mirrors the server exactly. */
export function normalizeConnectCode(input) {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function formatConnectCode(input) {
  const normalized = normalizeConnectCode(input);
  if (normalized.length !== CONNECT_CODE_LENGTH) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/**
 * An agent key (`pcp_<48hex>`) must never be mistaken for a code, or it would
 * be echoed to the screen and sent to a redeem endpoint that cannot use it.
 * The length check alone settles that -- keys are far longer -- but the prefix
 * is rejected explicitly so the intent survives a future change to either.
 */
export function looksLikeConnectCode(input) {
  const raw = String(input ?? "").trim();
  if (/^pcp_/i.test(raw)) return false;
  const normalized = normalizeConnectCode(raw);
  if (normalized.length !== CONNECT_CODE_LENGTH) return false;
  for (const char of normalized) {
    if (!CONNECT_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}
