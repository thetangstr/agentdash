import { z } from "zod";

// Required, not optional: the stewardship row is the audit trail for who held
// decision authority and why it moved. Enforcing this only in the web client
// would let every other caller — CLI, MCP, a future channel — record a
// transfer with no explanation.
const transferReasonSchema = z.string().trim().min(1).max(500);

export const assignAgentStewardshipSchema = z.object({
  agentId: z.string().uuid(),
  userId: z.string().trim().min(1).max(256),
}).strict();

export type AssignAgentStewardship = z.infer<typeof assignAgentStewardshipSchema>;

export const transferAgentStewardshipSchema = z.object({
  userId: z.string().trim().min(1).max(256),
  transferReason: transferReasonSchema,
}).strict();

export type TransferAgentStewardship = z.infer<typeof transferAgentStewardshipSchema>;
