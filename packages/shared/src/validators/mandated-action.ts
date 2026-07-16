import { z } from "zod";

export const performMandatedActionSchema = z.object({
  granteeAgentId: z.string().uuid().optional(),
  mandateId: z.string().uuid(),
  counterpartyDid: z.string().min(1),
  action: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});
export type PerformMandatedActionRequest = z.infer<typeof performMandatedActionSchema>;
