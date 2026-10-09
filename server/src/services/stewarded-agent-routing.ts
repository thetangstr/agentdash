import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentStewardships } from "@paperclipai/db";

/**
 * AgentDash: work assigned to a person who stewards an agent goes to that agent.
 *
 * People remember names, not agents. Whoever assigns an issue to a colleague —
 * a person or an agent, including the colleague assigning themselves — the
 * agent that colleague stewards takes the first pass, and decides from its own
 * mandate whether its steward is needed.
 *
 * The person keeps the assignment when:
 *  - the caller set `assignToPerson: true` (any caller may keep it with them);
 *  - an agent is named as well (the caller already chose);
 *  - the person stewards no agent, or their agent is the caller (that is the
 *    agent handing work to its own steward; routing it back would loop);
 *  - their agent cannot take work right now (paused, terminated, or pending
 *    approval) — the work would sit unseen, which is worse than a decision
 *    item the person will see.
 */
export interface StewardedAgentRoute {
  fromUserId: string;
  toAgentId: string;
}

const NOT_ROUTABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

export async function resolveStewardedAgentRoute(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    /** The calling agent, or null when the caller is not an agent. */
    actorAgentId: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    assignToPerson?: boolean;
  },
): Promise<StewardedAgentRoute | null> {
  if (input.assignToPerson === true || input.assigneeAgentId) return null;
  const userId = typeof input.assigneeUserId === "string" ? input.assigneeUserId.trim() : "";
  if (!userId) return null;
  const row = await db
    .select({ agentId: agents.id, status: agents.status })
    .from(agentStewardships)
    .innerJoin(agents, eq(agents.id, agentStewardships.agentId))
    .where(
      and(
        eq(agentStewardships.companyId, input.companyId),
        eq(agentStewardships.userId, userId),
        eq(agents.companyId, input.companyId),
        isNull(agentStewardships.endedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!row || (input.actorAgentId && row.agentId === input.actorAgentId) || NOT_ROUTABLE_AGENT_STATUSES.has(row.status)) return null;
  return { fromUserId: userId, toAgentId: row.agentId };
}

/**
 * AgentDash: is `userId` the active steward of `agentId`? An agent handing its
 * own issue to its own steward ("my steward must do this themselves") is the
 * other half of the routing above — the steward's work comes to the agent, and
 * the agent can always give it back — so, like returning an issue to the
 * person who created it, it needs no `tasks:assign`.
 */
export async function isActiveStewardOf(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; userId: string },
): Promise<boolean> {
  const row = await db
    .select({ agentId: agentStewardships.agentId })
    .from(agentStewardships)
    .where(
      and(
        eq(agentStewardships.companyId, input.companyId),
        eq(agentStewardships.agentId, input.agentId),
        eq(agentStewardships.userId, input.userId),
        isNull(agentStewardships.endedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return row !== null;
}
