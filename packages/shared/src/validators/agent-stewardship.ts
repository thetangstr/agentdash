import { z } from "zod";

const transferReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .optional()
  .nullable()
  .transform((value) => value ?? null);

export const assignAgentStewardshipSchema = z.object({
  agentId: z.string().uuid(),
  userId: z.string().trim().min(1).max(256),
});

export type AssignAgentStewardship = z.infer<typeof assignAgentStewardshipSchema>;

export const transferAgentStewardshipSchema = z.object({
  userId: z.string().trim().min(1).max(256),
  transferReason: transferReasonSchema,
});

export type TransferAgentStewardship = z.infer<typeof transferAgentStewardshipSchema>;
