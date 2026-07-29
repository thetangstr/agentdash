// AgentDash-MK: human↔provider channel pairing.
//
// Separate from connector credentials on purpose: one company bot/app
// credential serves many human conversations, so identity pairing and
// credential lifecycle revoke independently.

export const HUMAN_CHANNEL_PROVIDERS = ["telegram", "teams"] as const;
export type HumanChannelProvider = (typeof HUMAN_CHANNEL_PROVIDERS)[number];

export const EXTERNAL_CHANNEL_EVENT_STATES = ["claimed", "processed", "failed"] as const;
export type ExternalChannelEventState = (typeof EXTERNAL_CHANNEL_EVENT_STATES)[number];

export interface HumanChannelBinding {
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  provider: string;
  externalTenantId: string | null;
  externalUserId: string;
  externalConversationId: string | null;
  metadata: Record<string, unknown> | null;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
