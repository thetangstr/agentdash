import { ApiError } from "../api/client";

/**
 * AgentDash (scan 2, E3): make the owner the steward of the agent the
 * onboarding wizard just created for them.
 *
 * Without a stewardship the owner is the one person who cannot reach their
 * own agent — no My Agent page, no connect command, escalations to nobody —
 * and the agent list shows it as "Needs a steward". This used to run only on
 * workspaces with the stewardship capability; the server now accepts a person
 * pairing themselves with an agent they created on every workspace, so the
 * wizard always asks.
 *
 * Checked rather than attempted-and-swallowed where it can be: the agent's own
 * stewardship is read first (an open read), so a second launch does not even
 * try. The one refusal that is expected is 409 from the one-agent-per-person
 * rule — the owner already stewards another agent here — and it is reported,
 * not thrown. Anything else is a real failure and propagates.
 */
export type OwnerPairingOutcome = "paired" | "already_paired" | "owner_has_agent" | "refused_by_gate";

export async function pairOwnerWithNewAgent(
  api: {
    getAgentStewardship: (companyId: string, agentId: string) => Promise<{ stewardship: unknown | null }>;
    pair: (companyId: string, agentId: string, userId: string) => Promise<unknown>;
  },
  input: { companyId: string; agentId: string; userId: string },
): Promise<OwnerPairingOutcome> {
  const current = await api.getAgentStewardship(input.companyId, input.agentId);
  if (current.stewardship) return "already_paired";
  try {
    await api.pair(input.companyId, input.agentId, input.userId);
    return "paired";
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return "owner_has_agent";
    // The capability gate's 404: an older server, or an agent the server does
    // not record this user as having created. The agent stays "Needs a
    // steward" and can be paired from its page; failing the whole launch over
    // it would strand the owner mid-wizard.
    if (err instanceof ApiError && err.status === 404) return "refused_by_gate";
    throw err;
  }
}
