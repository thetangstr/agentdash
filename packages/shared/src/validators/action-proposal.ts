import { z } from "zod";

// AgentDash: Action Proposals
export const createActionProposalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  agentId: z.string().uuid(),
  issueId: z.string().uuid().optional(),
  proposedAction: z.string().min(1),
});

export type CreateActionProposal = z.infer<typeof createActionProposalSchema>;
