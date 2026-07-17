import { z } from "zod";

export const createMandateSchema = z.object({
  grantorAgentId: z.string().uuid(),
  granteeAgentId: z.string().uuid(),
  scope: z.array(z.string()).default([]),
  permissionKey: z.string().min(1).default("clockchain:attest"),
  spendCapCents: z.number().int().nonnegative().default(0),
  expiresAt: z.string().datetime(),
});
export type CreateMandateRequest = z.infer<typeof createMandateSchema>;
