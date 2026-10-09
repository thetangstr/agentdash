import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentStewardships } from "@paperclipai/db";

/**
 * AgentDash: an agent that hands work to a colleague hands it to the
 * colleague's agent.
 *
 * "Have a colleague do X" used to land on the colleague as a decision item,
 * while the agent they steward — the one that does their work — never woke.
 * When an agent assigns an issue to a person who stewards an agent, the
 * assignment goes to that agent instead.
 *
 * The person keeps the assignment when:
 *  - the caller is not an agent (a person assigning a person means it);
 *  - the caller set `assignToPerson: true` (a decision only a human can make);
 *  - an agent is named as well (the caller already chose);
 *  - the person stewards no agent, or their agent is the caller (routing it
 *    back would loop the work to the agent that is trying to hand it off);
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
  if (!input.actorAgentId || input.assignToPerson === true || input.assigneeAgentId) return null;
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
  if (!row || row.agentId === input.actorAgentId || NOT_ROUTABLE_AGENT_STATUSES.has(row.status)) return null;
  return { fromUserId: userId, toAgentId: row.agentId };
}
