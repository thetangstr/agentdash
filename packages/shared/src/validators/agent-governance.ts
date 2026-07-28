import { z } from "zod";
import {
  AGENT_DESTRUCTIVE_ACTION_MODES,
  AGENT_GOVERNANCE_CHANNELS,
  AGENT_MINIMUM_APPROVAL_MODES,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
} from "../types/agent-governance.js";

const policyEntrySchema = z.string().trim().min(1).max(200);

export const agentGovernancePolicySchema = z
  .object({
    permissions: z.array(policyEntrySchema).max(200),
    monthlyBudgetCents: z.number().int().nonnegative().max(AGENT_POLICY_UNLIMITED_BUDGET_CENTS),
    destructiveActions: z.enum(AGENT_DESTRUCTIVE_ACTION_MODES),
    dataScopes: z.array(policyEntrySchema).max(200),
    providers: z.array(policyEntrySchema).max(50),
    minimumApproval: z.enum(AGENT_MINIMUM_APPROVAL_MODES),
  })
  .strict();

export type AgentGovernancePolicyInput = z.infer<typeof agentGovernancePolicySchema>;

/**
 * Mutation envelope for both the owner ceiling and the steward request.
 * `revision` is the row revision the caller last observed and drives optimistic
 * concurrency; a stale value is a 409, never a silent overwrite.
 */
export const updateAgentGovernancePolicySchema = z
  .object({
    policy: agentGovernancePolicySchema,
    revision: z.number().int().positive(),
    channel: z.enum(AGENT_GOVERNANCE_CHANNELS).optional(),
  })
  .strict();

export type UpdateAgentGovernancePolicy = z.infer<typeof updateAgentGovernancePolicySchema>;
