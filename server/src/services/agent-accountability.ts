import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentStewardships, authUsers, companyMemberships } from "@paperclipai/db";
import { AGENT_AUTONOMY_KINDS, type AgentAutonomy } from "@paperclipai/shared";
import { conflict } from "../errors.js";

/**
 * Which kind of agent this is, and who answers for it.
 *
 * Two things used to be inferred from one absence. An agent with no active
 * stewardship was either half set up or deliberately running on its own, and
 * nothing in the data said which — so `approval-card-delivery` returned early
 * for both (`if (!active) return`), the board showed both as "no steward", and
 * an autonomous agent's escalation reached nobody at all.
 *
 * `agents.autonomy` now states the kind, and this module is the one place that
 * turns it into an answer to "who do I take this to?". Callers must not read
 * `agents.accountable_user_id` directly: for a stewarded agent it is null and
 * the steward is the answer, and duplicating that rule at each call site is how
 * the two drift apart.
 *
 * The vocabulary itself lives in `@paperclipai/shared` because the board renders
 * it and the validators accept it.
 */
export { AGENT_AUTONOMY_KINDS };
export type { AgentAutonomy };

export function isAgentAutonomy(value: unknown): value is AgentAutonomy {
  return typeof value === "string" && (AGENT_AUTONOMY_KINDS as readonly string[]).includes(value);
}

/**
 * Anything unrecognised reads as `stewarded`.
 *
 * The safe direction: a stewarded agent that is really autonomous merely looks
 * unfinished, while an autonomous agent that is really stewarded would drop its
 * steward's channel binding and their My Agent page.
 */
export function normalizeAgentAutonomy(value: unknown): AgentAutonomy {
  return isAgentAutonomy(value) ? value : "stewarded";
}

/**
 * How an agent arrived at its accountable human.
 *
 * `unpaired` is a real state, not an error: a stewarded agent whose pairing was
 * never completed. It is reported rather than smoothed over, because the fix is
 * for a person to finish the pairing and they cannot do that if no screen says
 * so.
 */
export type AgentAccountabilityVia = "steward" | "assignment" | "unpaired";

export interface AgentAccountability {
  autonomy: AgentAutonomy;
  /** The human to escalate to, or null when the agent is stewarded but unpaired. */
  userId: string | null;
  via: AgentAccountabilityVia;
  name: string | null;
  email: string | null;
}

/** Label a human the way the member list does: name, then email, then id. */
export function accountabilityLabel(value: AgentAccountability | null): string | null {
  if (!value?.userId) return null;
  return value.name?.trim() || value.email?.trim() || value.userId;
}

type AccountabilityDb = Pick<Db, "select">;

export function agentAccountabilityService(db: AccountabilityDb) {
  /**
   * Resolve accountability for a set of agents in one round trip.
   *
   * Batched because the agent list and the heartbeat sweep both need this for
   * every agent at once, and a per-agent lookup there is one query per row on a
   * hot path — the same reason `activeStewardsByAgentIds` is batched.
   */
  async function resolveForAgents(
    companyId: string,
    agentIds: string[],
  ): Promise<Map<string, AgentAccountability>> {
    const byAgentId = new Map<string, AgentAccountability>();
    if (agentIds.length === 0) return byAgentId;

    const rows = await db
      .select({
        agentId: agents.id,
        autonomy: agents.autonomy,
        accountableUserId: agents.accountableUserId,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));

    const stewardRows = await db
      .select({
        agentId: agentStewardships.agentId,
        userId: agentStewardships.userId,
      })
      .from(agentStewardships)
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          inArray(agentStewardships.agentId, agentIds),
          isNull(agentStewardships.endedAt),
        ),
      );
    const stewardByAgentId = new Map(stewardRows.map((row) => [row.agentId, row.userId]));

    // Resolve every referenced human once, and tolerate finding nothing:
    // `user_id` is a durable principal id rather than a foreign key into the
    // auth table, so a legitimate accountable party can have no auth row. The
    // id is what identifies them; the name is only a label.
    const userIds = new Set<string>();
    for (const row of rows) {
      const stewardUserId = stewardByAgentId.get(row.agentId);
      const resolved =
        normalizeAgentAutonomy(row.autonomy) === "autonomous"
          ? row.accountableUserId
          : stewardUserId ?? null;
      if (resolved) userIds.add(resolved);
    }
    const profiles = new Map<string, { name: string | null; email: string | null }>();
    if (userIds.size > 0) {
      const users = await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(inArray(authUsers.id, [...userIds]));
      for (const user of users) profiles.set(user.id, { name: user.name, email: user.email });
    }

    for (const row of rows) {
      const autonomy = normalizeAgentAutonomy(row.autonomy);
      const stewardUserId = stewardByAgentId.get(row.agentId) ?? null;
      const userId = autonomy === "autonomous" ? row.accountableUserId ?? null : stewardUserId;
      const via: AgentAccountabilityVia =
        autonomy === "autonomous" ? "assignment" : stewardUserId ? "steward" : "unpaired";
      const profile = userId ? profiles.get(userId) ?? null : null;
      byAgentId.set(row.agentId, {
        autonomy,
        userId,
        via,
        name: profile?.name ?? null,
        email: profile?.email ?? null,
      });
    }
    return byAgentId;
  }

  async function resolveForAgent(
    companyId: string,
    agentId: string,
  ): Promise<AgentAccountability | null> {
    const map = await resolveForAgents(companyId, [agentId]);
    return map.get(agentId) ?? null;
  }

  /**
   * The human an escalation from this agent should reach, or null.
   *
   * The whole point of the change: a stewarded agent escalates to its steward
   * exactly as before, and an autonomous agent — which previously escalated
   * into a void — reaches whoever was made accountable for it.
   */
  async function escalationUserId(companyId: string, agentId: string): Promise<string | null> {
    return (await resolveForAgent(companyId, agentId))?.userId ?? null;
  }

  /**
   * The accountable human has to be a person in this company.
   *
   * Without this, `accountable_user_id` is a free-text field: a typo, a stale id
   * from another instance, or a former member all satisfy the NOT NULL check
   * while naming nobody who can actually be reached. The check that matters is
   * membership, not the auth row — a durable principal id with an active
   * membership is a real person here even if their identity provider changed.
   */
  async function assertAccountableMember(companyId: string, userId: string): Promise<void> {
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
    if (!member) {
      throw conflict(
        "The accountable person must be an active member of this company. " +
          "Invite them first, or name someone who is already a member.",
      );
    }
  }

  return { resolveForAgent, resolveForAgents, escalationUserId, assertAccountableMember };
}

/**
 * An autonomous agent gets no credential a person can carry.
 *
 * Decided 2026-08-19: a connect code and a hand-minted key exist so somebody can
 * drive an agent from their own terminal, and an autonomous agent has no such
 * person. Issuing one anyway would hand out a live credential with no human
 * attached — the thing an audit cannot answer for — and would quietly recreate
 * the pairing this kind exists to say does not exist.
 *
 * Deliberately NOT applied to the `default` key minted inside agent creation.
 * That one is the agent's own service credential for callbacks against `/api/*`
 * (GH #71), it is never handed to anybody, and one adapter still depends on it:
 * `openclaw_gateway` is the only adapter with `supportsLocalAgentJwt: false`, so
 * a heartbeat run there authenticates with the stored key rather than the
 * short-lived local JWT every other adapter gets. Refusing that key would not
 * make an autonomous agent safer, it would make it unable to run.
 *
 * Thrown as a conflict rather than a validation error because the request is
 * well formed; it is the agent's kind that makes it impossible, and the caller's
 * fix is to make the agent stewarded first.
 */
export function assertAgentMayHoldKey(agent: { name?: string | null; autonomy?: unknown }): void {
  if (normalizeAgentAutonomy(agent.autonomy) !== "autonomous") return;
  const name = agent.name?.trim() || "This agent";
  throw conflict(
    `${name} is an autonomous agent, so no key or connect code can be issued for it. ` +
      "Make it a stewarded agent first if a person needs to run it from their own terminal.",
  );
}
