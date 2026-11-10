import { diffGovernancePolicies, type AgentGovernancePolicy } from "@paperclipai/shared";

/**
 * AgentDash admin powers: the batch dialog's gains and losses for policy
 * records (`agent.apply_ceiling`), from the same shared function the server
 * preview uses. `before`/`after` carry the policy fields plus a revision.
 */
export function describePolicyChange(before: Record<string, unknown>, after: Record<string, unknown>) {
  const { gains, losses } = diffGovernancePolicies(before as unknown as AgentGovernancePolicy, after as unknown as AgentGovernancePolicy);
  const strip = (text: string) => text;
  return { gains: gains.map((change) => strip(change.text)), losses: losses.map((change) => strip(change.text)) };
}
