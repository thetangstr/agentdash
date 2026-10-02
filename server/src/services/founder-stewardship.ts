import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { agentStewardshipService } from "./agent-stewardships.js";

/**
 * AgentDash (scan 2, E3): the company's owner becomes the steward of the first
 * agent created for them, on every workspace and every path.
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
 * Only for the company's `owner` (PR #955 review): an admin or any member with
 * agents:create could otherwise delete every agent, create a "first" one and
 * become its steward on a workspace where the stewardship capability is off.
 *
 * Only when neither side is already paired: stewardship is one agent per
 * person and one person per agent, and the service refuses a second pairing
 * anyway. Writes a stewardship row and nothing else: never a membership or a
 * role. Best-effort by construction: a failure here must never fail the
 * company or agent creation it follows; the agent stays valid and can be
 * paired from its page.
 */
export interface FounderStewardshipDeps {
  isCompanyOwner(companyId: string, userId: string): Promise<boolean>;
  activeByUser(companyId: string, userId: string): Promise<unknown | null>;
  activeByAgent(companyId: string, agentId: string): Promise<unknown | null>;
  assign(
    companyId: string,
    input: { agentId: string; userId: string; assignedByUserId: string | null },
  ): Promise<unknown>;
}

export type FounderStewardshipOutcome =
  | "paired"
  | "not_owner"
  | "already_paired"
  | "user_has_agent"
  | "failed";

/** Whether `userId` holds an active `owner` membership in the company. */
export function companyOwnerCheck(db: Pick<Db, "select">) {
  return async (companyId: string, userId: string): Promise<boolean> => {
    const row = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  };
}

/** The production wiring: the stewardship service plus the owner check. */
export function founderStewardshipDeps(db: Db): FounderStewardshipDeps {
  const stewardships = agentStewardshipService(db);
  return {
    isCompanyOwner: companyOwnerCheck(db),
    activeByUser: (companyId, userId) => stewardships.activeByUser(companyId, userId),
    activeByAgent: (companyId, agentId) => stewardships.activeByAgent(companyId, agentId),
    assign: (companyId, input) => stewardships.assign(companyId, input),
  };
}

export async function pairFounderWithAgent(
  deps: FounderStewardshipDeps,
  input: { companyId: string; agentId: string; userId: string },
): Promise<FounderStewardshipOutcome> {
  try {
    if (!(await deps.isCompanyOwner(input.companyId, input.userId))) return "not_owner";
    if (await deps.activeByAgent(input.companyId, input.agentId)) return "already_paired";
    if (await deps.activeByUser(input.companyId, input.userId)) return "user_has_agent";
    await deps.assign(input.companyId, {
      agentId: input.agentId,
      userId: input.userId,
      assignedByUserId: input.userId,
    });
    return "paired";
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, userId: input.userId },
      "[stewardship] could not pair the owner with their first agent",
    );
    return "failed";
  }
}

/**
 * AgentDash (scan 3, lane H): who answers for an agent the onboarding plan
 * hires.
 *
 * Stewardship is one person per agent and one agent per person (enforced by
 * unique indexes on `agent_stewardships`), and the founder already stewards
 * their Chief of Staff, so a plan hire can never also be stewarded by them.
 * Left `stewarded` with nobody paired, every hire showed "Needs a steward"
 * right after onboarding. Plan hires work under the Chief of Staff with no
 * person at a terminal, which is exactly an autonomous agent, so they are
 * created autonomous with the creating human accountable for them.
 *
 * Returns an empty object (the agent stays stewarded, as before) when the
 * creator has no active membership in the company, e.g. an instance admin
 * acting on someone else's workspace: an accountable person must be a member
 * (agents_accountable_ck plus assertAccountableMember).
 */
export async function onboardingHireAccountability(
  db: Pick<Db, "select">,
  companyId: string,
  userId: string | null | undefined,
): Promise<{ autonomy: "autonomous"; accountableUserId: string } | Record<string, never>> {
  if (!userId) return {};
  const member = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return member ? { autonomy: "autonomous", accountableUserId: userId } : {};
}
