import { z } from "zod";
import { HUMAN_CHANNEL_PROVIDERS } from "../types/human-channel.js";

/**
 * Pairing input. `userId` is deliberately absent: the server takes the human
 * from the authenticated session, never from the request body, so a caller
 * cannot bind a provider identity to someone else.
 */
export const verifyHumanChannelBindingSchema = z
  .object({
    provider: z.enum(HUMAN_CHANNEL_PROVIDERS),
    externalTenantId: z.string().trim().min(1).max(200).optional().nullable(),
    externalUserId: z.string().trim().min(1).max(200),
    externalConversationId: z.string().trim().min(1).max(200).optional().nullable(),
    metadata: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export type VerifyHumanChannelBinding = z.infer<typeof verifyHumanChannelBindingSchema>;
