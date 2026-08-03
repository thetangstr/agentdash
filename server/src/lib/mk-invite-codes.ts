import { timingSafeEqual } from "node:crypto";

/**
 * AgentDash-MK: the codes that grant the `agentdash_mk` product profile.
 *
 * Deliberately a SEPARATE list from `AGENTDASH_INVITE_CODES` rather than a
 * `code:profile` map. A map needs a parser, a syntax to get wrong, and an
 * answer for what a malformed entry means; two lists need none of that and are
 * trivially reversible — an operator revokes MK by clearing one variable
 * without touching the general funnel gate.
 *
 * Read from the environment on every call rather than cached at import: an
 * operator rotating a partner's code should not have to restart the server, and
 * the list is short enough that the cost is irrelevant.
 */
export function configuredMkInviteCodes(): string[] {
  return (process.env.AGENTDASH_MK_INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/**
 * Constant-time match, mirroring `codeMatches` in routes/invite-codes.ts.
 *
 * An invite code is a shared secret and this is a guessing target, so the
 * comparison must not leak length-prefix information through timing. Buffers of
 * different length short-circuit before `timingSafeEqual`, which throws on a
 * length mismatch — that check is a requirement of the API, not an optimization.
 */
export function isMkInviteCode(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const supplied = Buffer.from(candidate);
  return configuredMkInviteCodes().some((configured) => {
    const expected = Buffer.from(configured);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
