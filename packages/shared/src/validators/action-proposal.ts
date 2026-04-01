import { z } from "zod";
import { ACTION_PROPOSAL_TYPES } from "../constants.js";

export const createActionProposalSchema = z.object({
  actionType: z.enum(ACTION_PROPOSAL_TYPES),
  summary: z.string().min(1),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().default("USD"),
  confidenceScore: z.number().min(0).max(1).optional(),
  evidence: z.record(z.unknown()),
  issueId: z.string().uuid().optional(),
  crmAccountId: z.string().uuid().optional(),
  crmContactId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(), // board user can submit on behalf of agent
});

export type CreateActionProposal = z.infer<typeof createActionProposalSchema>;
