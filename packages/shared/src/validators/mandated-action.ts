import { z } from "zod";

export const performMandatedActionSchema = z.object({
  granteeAgentId: z.guid().optional(),
  mandateId: z.guid(),
  counterpartyDid: z.string().min(1),
  action: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type PerformMandatedActionRequest = z.infer<typeof performMandatedActionSchema>;
