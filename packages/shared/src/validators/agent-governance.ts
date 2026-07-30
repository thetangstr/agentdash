import { z } from "zod";
import {
  AGENT_DESTRUCTIVE_ACTION_MODES,
  AGENT_MINIMUM_APPROVAL_MODES,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
} from "../types/agent-governance.js";

const policyEntrySchema = z.string().trim().min(1).max(200);

/**
 * A list is either the single wildcard or a list of concrete entries — never a
 * mix. Normalization collapses any list containing `"*"` down to `["*"]`, so a
 * mixed list like `["issues:read", "*"]` would silently widen a steward request
 * to the entire ceiling and destroy the caller's actual intent in both the
 * stored row and the audit trail. Reject it at the edge instead.
 */
function policyListSchema(max: number) {
  return z
    .array(policyEntrySchema)
    .max(max)
    .refine(
      (values) => !values.includes(AGENT_POLICY_WILDCARD) || values.length === 1,
      { message: `"${AGENT_POLICY_WILDCARD}" cannot be combined with specific entries` },
    );
}

export const agentGovernancePolicySchema = z
  .object({
    permissions: policyListSchema(200),
    monthlyBudgetCents: z.number().int().nonnegative().max(AGENT_POLICY_UNLIMITED_BUDGET_CENTS),
    destructiveActions: z.enum(AGENT_DESTRUCTIVE_ACTION_MODES),
    dataScopes: policyListSchema(200),
    providers: policyListSchema(50),
    minimumApproval: z.enum(AGENT_MINIMUM_APPROVAL_MODES),
  })
  .strict();

export type AgentGovernancePolicyInput = z.infer<typeof agentGovernancePolicySchema>;

/**
 * Channels a client may claim for itself. `"system"` is intentionally excluded:
 * it is written only by server-side callers, so a steward cannot attribute
 * their own policy change to the system in the audit trail.
 */
export const AGENT_GOVERNANCE_CLIENT_CHANNELS = ["web", "telegram", "teams", "whatsapp"] as const;

/**
 * Mutation envelope for both the owner ceiling and the steward request.
 * `revision` is the row revision the caller last observed and drives optimistic
 * concurrency; a stale value is a 409, never a silent overwrite.
 */
export const updateAgentGovernancePolicySchema = z
  .object({
    policy: agentGovernancePolicySchema,
    revision: z.number().int().positive(),
    channel: z.enum(AGENT_GOVERNANCE_CLIENT_CHANNELS).optional(),
  })
  .strict();

export type UpdateAgentGovernancePolicy = z.infer<typeof updateAgentGovernancePolicySchema>;
