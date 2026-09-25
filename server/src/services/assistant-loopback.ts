import { randomBytes } from "node:crypto";
import { ASSISTANT_LOOPBACK_TOKEN_PREFIX } from "@paperclipai/shared";

/**
 * AgentDash (GH #677 security round): the internal credential the assistant
 * MCP endpoint mints for its own tool loopback.
 *
 * Why this exists: the assistant toolset answers an MCP request by calling
 * the same REST routes a board user would hit, then applying the person-
 * facing §5 redaction before anything leaves the tool envelope. If the
 * loopback carried the caller's `pcpa_` token, that token would have to be
 * allowlisted on every route the toolset touches — and every one of those
 * routes would then answer a raw bearer with UNREDACTED data (adapterConfig,
 * contextSnapshot, member emails). That was the side door the review closed.
 *
 * Instead the endpoint mints a `pcin_` token per request, the middleware
 * resolves it straight out of this in-process map to the grant's board-shaped
 * actor (still company-pinned, still carrying the grant's scopes), and the
 * `pcpa_` allowlist shrinks to exactly the MCP endpoint. The credential is
 * never sent to the client, never persisted, dies when the response closes
 * (and at TTL regardless). Writes were added with M3 (GH #678): a `pcin_`
 * token may write ONLY to the routes in ASSISTANT_LOOPBACK_WRITE_ROUTES and
 * only while the grant holds `agentdash:work` — the gate lives in
 * middleware/auth.ts beside this resolver, so nothing here is reachable by
 * a route nobody listed.
 */

export interface AssistantLoopbackIdentity {
  userId: string;
  companyId: string;
  membershipRole: string | null;
  grantId: string;
  scopes: string[];
  /**
   * GH #678: the OAuth client's display name, so activity rows written by the
   * loopback actor can carry `via: assistant_grant <clientName>`.
   */
  clientName: string;
}

interface LoopbackEntry extends AssistantLoopbackIdentity {
  expiresAt: number;
}

/** Long enough for a slow tool call chain, short enough that a leak is useless. */
const LOOPBACK_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const tokens = new Map<string, LoopbackEntry>();

function sweepExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

export function mintAssistantLoopbackToken(identity: AssistantLoopbackIdentity): string {
  const now = Date.now();
  if (tokens.size >= MAX_ENTRIES) sweepExpired(now);
  const token = `${ASSISTANT_LOOPBACK_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  tokens.set(token, { ...identity, expiresAt: now + LOOPBACK_TOKEN_TTL_MS });
  return token;
}

export function resolveAssistantLoopbackToken(token: string): AssistantLoopbackIdentity | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tokens.delete(token);
    return null;
  }
  const { expiresAt: _expiresAt, ...identity } = entry;
  return identity;
}

export function revokeAssistantLoopbackToken(token: string): void {
  tokens.delete(token);
}

/** Test isolation — the registry is module-level state. */
export function resetAssistantLoopbackTokens(): void {
  tokens.clear();
}
