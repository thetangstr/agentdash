import { logger } from "../middleware/logger.js";

/**
 * AgentDash (scan 2, E3): the person a company's first agent is created for
 * becomes that agent's steward, on every workspace and every path.
 *
 * A founder's first agent (the wizard's hire, the Chief of Staff the /cos
 * bootstrap creates, a first POST /agents) used to be left with nobody paired
 * unless the workspace had the stewardship capability. The agent list showed
 * "Needs a steward" on the founder's own Chief of Staff, nothing tied the
 * founder to it (no My Agent page, no connect command), and its escalations
 * reached no one. Being answerable for the first agent made for you is not the
 * workforce feature the capability gates (pairing other people, personal
 * agents for joiners); it is the minimum for the agent to have an owner. So
 * this runs regardless of the company's product profile.
 *
 * Only when neither side is already paired: stewardship is one agent per
 * person and one person per agent, and the service refuses a second pairing
 * anyway. Best-effort by construction: a failure here must never fail the
 * company or agent creation it follows; the agent stays valid and can be
 * paired from its page.
 */
export interface FounderStewardshipDeps {
  activeByUser(companyId: string, userId: string): Promise<unknown | null>;
  activeByAgent(companyId: string, agentId: string): Promise<unknown | null>;
  assign(
    companyId: string,
    input: { agentId: string; userId: string; assignedByUserId: string | null },
  ): Promise<unknown>;
}

export type FounderStewardshipOutcome = "paired" | "already_paired" | "user_has_agent" | "failed";

export async function pairFounderWithAgent(
  stewardships: FounderStewardshipDeps,
  input: { companyId: string; agentId: string; userId: string },
): Promise<FounderStewardshipOutcome> {
  try {
    if (await stewardships.activeByAgent(input.companyId, input.agentId)) return "already_paired";
    if (await stewardships.activeByUser(input.companyId, input.userId)) return "user_has_agent";
    await stewardships.assign(input.companyId, {
      agentId: input.agentId,
      userId: input.userId,
      assignedByUserId: input.userId,
    });
    return "paired";
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, userId: input.userId },
      "[stewardship] could not pair the founder with their first agent",
    );
    return "failed";
  }
}
