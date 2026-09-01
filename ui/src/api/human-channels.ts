import type { HumanChannelProvider } from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash-MK: typed client for the human↔provider channel routes in
 * `server/src/routes/human-channels.ts`. Mirrors the shape of
 * `agent-governance.ts` — a flat object of thin wrappers, one per route, that
 * do nothing but name the URL and the response body.
 *
 * The dates arrive as ISO strings over the wire even though the DB column is a
 * timestamp, so this record types them as `string`, unlike the shared
 * `HumanChannelBinding` whose fields are `Date` at rest.
 */
export interface ChannelBinding {
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  provider: string;
  externalTenantId: string | null;
  externalUserId: string;
  externalConversationId: string | null;
  metadata: Record<string, unknown> | null;
  verifiedAt: string | null;
  /** WhatsApp's 24-hour free-form window opens on this inbound timestamp. */
  lastInboundAt?: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a pairing endpoint mints. The server returns a deep link and only a deep
 * link — never the raw token — so this is the entire surface the UI ever holds.
 */
export interface PairingChallenge {
  deepLink: string;
  expiresAt: string;
}

export const humanChannelsApi = {
  /** The caller's own bindings. Identity comes from the session, never a body. */
  listMine: (companyId: string) =>
    api.get<{ bindings: ChannelBinding[] }>(`/companies/${companyId}/me/channels`),

  /**
   * Mint a single-use pairing link for the authenticated caller. WHO it binds
   * is always the session; the provider is the only thing this call chooses.
   * Teams answers 503 until the bot is configured — the caller renders that as
   * "not available" rather than swallowing it.
   */
  startPairing: (companyId: string, provider: HumanChannelProvider) =>
    api.post<PairingChallenge>(
      `/companies/${companyId}/me/channels/${provider}/pairing`,
      {},
    ),

  /** A human revokes their own binding; an administrator may revoke any. */
  revoke: (companyId: string, bindingId: string) =>
    api.post<{ binding: ChannelBinding }>(
      `/companies/${companyId}/channel-bindings/${bindingId}/revoke`,
      {},
    ),

  /** Administrator view of every binding in the company, for audit. */
  listAll: (companyId: string) =>
    api.get<{ bindings: ChannelBinding[] }>(`/companies/${companyId}/channel-bindings`),
};
