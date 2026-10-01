import { assertActivityAcceptance, type ActivityAcceptance } from './activity-log.js';
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentStewardships,
  authUsers,
  companyMemberships,
  companies,
  bridgeEndpoints,
  humanChannelBindings,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { normalizeAgentAutonomy } from "./agent-accountability.js";
import { isUniqueViolation, pgConstraintName } from "../lib/pg-error.js";
import { logActivity, insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

type AgentStewardshipRow = typeof agentStewardships.$inferSelect;

/**
 * The steward as another party is allowed to see them.
 *
 * `name` and `email` are nullable on purpose: `agent_stewardships.user_id` is a
 * durable principal id rather than a foreign key into the auth user table (see
 * the schema comment), so a steward can legitimately have no auth row — a local
 * or external principal, or a person whose identity provider changed. `userId`
 * is therefore the only field guaranteed to identify them, which is why callers
 * that need a label fall back name -> email -> userId, the same order the
 * member list in the UI already uses.
 */
export interface AgentStewardSummary {
  userId: string;
  name: string | null;
  email: string | null;
  since: Date;
}
type StewardshipDb = Pick<Db, "select" | "insert" | "update" | "execute">;

type AssignInput = {
  agentId: string;
  userId: string;
  assignedByUserId: string | null;
};

type TransferInput = {
  userId: string;
  transferredByUserId: string | null;
  transferReason?: string | null;
};

type ReleaseInput = {
  releasedByUserId: string | null;
  /**
   * Why the pairing ended, required by the route for the same reason a transfer
   * reason is: this table IS the record of who held decision authority over an
   * agent, and an unexplained gap in it cannot be read after the fact.
   */
  releaseReason?: string | null;
};

function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

function isStewardshipUniqueConflict(error: unknown) {
  if (!isUniqueViolation(error)) return false;
  const constraint = pgConstraintName(error);
  return (
    constraint === "agent_stewardships_active_user_uq" ||
    constraint === "agent_stewardships_active_agent_uq"
  );
}

function normalizeReason(reason: string | null | undefined) {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : null;
}

async function lockActiveUserMember(
  database: StewardshipDb,
  companyId: string,
  userId: string,
) {
  const result = await database.execute(sql`
    select ${companyMemberships.id}
    from ${companyMemberships}
    where ${companyMemberships.companyId} = ${companyId}
      and ${companyMemberships.principalType} = 'user'
      and ${companyMemberships.principalId} = ${userId}
      and ${companyMemberships.status} = 'active'
    for update
  `);
  if (resultRows(result).length === 0) {
    throw conflict("Steward user must be an active company member");
  }
}

async function lockTransferCompanyAgent(
  database: StewardshipDb,
  companyId: string,
  agentId: string,
  options: { allowTerminated?: boolean } = {},
) {
  const result = await database.execute(sql`
    select ${agents.id}, ${agents.status}
    from ${agents}
    where ${agents.companyId} = ${companyId}
      and ${agents.id} = ${agentId}
    for update
  `);
  const rows = resultRows(result) as Array<{ status?: string }>;
  const row = rows[0];
  if (!row) {
    throw notFound("Agent not found");
  }
  if (row.status === "terminated" && !options.allowTerminated) {
    throw conflict("Stewardship agent must not be terminated");
  }
}

async function lockAssignableCompanyAgent(
  database: StewardshipDb,
  companyId: string,
  agentId: string,
) {
  const result = await database.execute(sql`
    select ${agents.id}, ${agents.companyId}, ${agents.status}, ${agents.name}, ${agents.autonomy}
    from ${agents}
    where ${agents.id} = ${agentId}
    for update
  `);
  const rows = resultRows(result) as Array<{
    company_id?: string;
    companyId?: string;
    status?: string;
    name?: string;
    autonomy?: string;
  }>;
  const row = rows[0];
  const rowCompanyId = row?.company_id ?? row?.companyId;
  if (!row || rowCompanyId !== companyId) {
    throw conflict("Stewardship agent must belong to the same company");
  }
  if (row.status === "terminated") {
    throw conflict("Stewardship agent must not be terminated");
  }
  // An autonomous agent has no person at a terminal by definition, so pairing
  // one to a human is not a partial state to be tolerated — it is the two
  // kinds contradicting each other. Refused here, inside the row lock, rather
  // than in the route, because `assign` is reachable from the API, the MCP
  // surface and the creation path.
  if (normalizeAgentAutonomy(row.autonomy) === "autonomous") {
    throw conflict(
      `${row.name?.trim() || "This agent"} is an autonomous agent and works without a steward. ` +
        "Make it a stewarded agent first if a person should run it.",
    );
  }
}

/**
 * One audit row per revoked channel binding and bridge endpoint.
 *
 * Revocation on stewardship end lives inline in this service, and when it moved
 * here it lost the per-row audit the standalone helper had. `stewardship_ended`
 * records that authority ended; it does not record that a specific Telegram
 * binding or a specific enrolled laptop stopped being able to act. Recovering
 * that meant joining a `revoked_at` timestamp against a stewardship row and
 * hoping the timestamps matched.
 *
 * Written on the SAME connection or transaction as the revocation it describes,
 * so a rolled-back transfer cannot leave an audit row claiming a revocation
 * that never happened.
 */
async function auditRevocations(
  database: StewardshipDb,
  input: {
    companyId: string;
    actorUserId: string | null;
    reason: "stewardship_ended" | "stewardship_transferred" | "stewardship_released" | "agent_terminated";
    bindings: Array<{ id: string; agentId: string; provider: string }>;
    endpoints: Array<{ id: string; label: string }>;
  },
  publications?: ActivityPublication[],
) {
  const audit = async (input: Parameters<typeof logActivity>[1]) => {
    if (publications) publications.push(await insertActivity(database, input));
    else await logActivity(database as unknown as Db, input);
  };
  for (const binding of input.bindings) {
    await audit({
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId ?? "board",
      action: "human_channel.binding_revoked",
      entityType: "human_channel_binding",
      entityId: binding.id,
      agentId: binding.agentId,
      details: { provider: binding.provider, reason: input.reason },
    });
  }
  for (const endpoint of input.endpoints) {
    await audit({
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId ?? "board",
      action: "bridge.endpoint_revoked",
      entityType: "bridge_endpoint",
      entityId: endpoint.id,
      details: { label: endpoint.label, reason: input.reason },
    });
  }
}

/**
 * End a terminated agent's pairing, inside the caller's transaction.
 *
 * Termination used to leave the stewardship open. The one-per-person unique
 * index filters on `ended_at` alone, so the person kept a slot held by a dead
 * agent: `assign` to a new agent 409'd on the index, `release` and `transfer`
 * refused the terminated agent, and My Agent kept showing it. The only way out
 * was archiving the person's membership.
 *
 * Called from `agentService.terminate` on the same transaction as the status
 * change, so there is no moment where an agent is terminated and still
 * stewarded. The outgoing steward's channel bindings FOR THIS AGENT are
 * revoked, with the same per-row audit `releaseForAgent` writes.
 *
 * Bridge endpoints are deliberately left alone, unlike transfer and release.
 * An endpoint belongs to a person, not to an agent (there is no agent column),
 * and it also carries that person's steward inbox for any autonomous agent
 * they are accountable for and for tasks from codes they issued. Termination
 * is an administrator's act on the agent, not a decision about the person's
 * devices; revoking every one of them here would cut off work that has nothing
 * to do with the terminated agent. What the terminated agent could still use
 * is already gone: its API keys (including every key minted by redeeming a
 * connect code) are revoked by `terminate` itself.
 */
export async function endStewardshipForTerminatedAgent(
  database: StewardshipDb,
  input: { companyId: string; agentId: string; endedByUserId: string | null },
  // AgentDash: publish-after-commit. When the caller passes a list, audit rows
  // are inserted on its transaction and their live events are queued here; the
  // caller publishes them only after the transaction commits.
  publications?: ActivityPublication[],
): Promise<AgentStewardshipRow[]> {
  const now = new Date();
  const ended = await database
    .update(agentStewardships)
    .set({
      endedAt: now,
      endedByUserId: input.endedByUserId,
      transferReason: "agent_terminated",
      updatedAt: now,
    })
    .where(
      and(
        eq(agentStewardships.companyId, input.companyId),
        eq(agentStewardships.agentId, input.agentId),
        isNull(agentStewardships.endedAt),
      ),
    )
    .returning();

  for (const stewardship of ended) {
    const revokedBindings = await database
      .update(humanChannelBindings)
      .set({ revokedAt: now, revokedByUserId: input.endedByUserId, updatedAt: now })
      .where(
        and(
          eq(humanChannelBindings.companyId, input.companyId),
          eq(humanChannelBindings.userId, stewardship.userId),
          eq(humanChannelBindings.agentId, input.agentId),
          isNull(humanChannelBindings.revokedAt),
        ),
      )
      .returning();
    await auditRevocations(database, {
      companyId: input.companyId,
      actorUserId: input.endedByUserId,
      reason: "agent_terminated",
      bindings: revokedBindings,
      endpoints: [],
    }, publications);

    const endedAudit = {
      companyId: input.companyId,
      actorType: "user" as const,
      actorId: input.endedByUserId ?? "board",
      action: "agent.stewardship_ended",
      entityType: "agent_stewardship",
      entityId: stewardship.id,
      agentId: input.agentId,
      details: {
        userId: stewardship.userId,
        reason: "agent_terminated",
      },
    };
    if (publications) publications.push(await insertActivity(database, endedAudit));
    else await logActivity(database as unknown as Db, endedAudit);
  }

  return ended;
}

export function agentStewardshipService(db: Db) {
  async function accept<T>(supplied: ActivityAcceptance | undefined, work: (executor: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T> {
    if (supplied !== undefined) {
      assertActivityAcceptance(supplied);
      return work(supplied.executor, supplied.publications);
    }
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(tx => work(tx as unknown as Db, publications));
    for (const publication of publications) publishActivity(publication);
    return result;
  }


  /**
   * The person's current pairing, ignoring one that points at a terminated
   * agent.
   *
   * Termination now ends the pairing itself, so a terminated agent's open row
   * should not exist. The filter stays as defence: a row left over from before
   * that change (or written by some path that forgets) would otherwise keep
   * showing a dead agent on My Agent and silently block creator auto-pairing.
   */
  async function activeByUser(companyId: string, userId: string) {
    return db
      .select({ stewardship: agentStewardships })
      .from(agentStewardships)
      .innerJoin(agents, eq(agents.id, agentStewardships.agentId))
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.userId, userId),
          isNull(agentStewardships.endedAt),
          ne(agents.status, "terminated"),
        ),
      )
      .then((rows) => rows[0]?.stewardship ?? null);
  }

  /**
   * Whether this person has ever stewarded an agent in this company, ended or
   * not. Personal-agent provisioning is for a first visit; a person whose agent
   * was terminated, released or transferred is not arriving for the first time.
   */
  async function hasStewardshipHistory(companyId: string, userId: string) {
    const row = await db
      .select({ id: agentStewardships.id })
      .from(agentStewardships)
      .where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.userId, userId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row !== null;
  }

  async function activeByAgent(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentStewardships)
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.agentId, agentId),
          isNull(agentStewardships.endedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function activeByUserWithAgent(companyId: string, userId: string) {
    const row = await db
      .select({
        stewardship: agentStewardships,
        agent: agents,
      })
      .from(agentStewardships)
      .innerJoin(agents, eq(agents.id, agentStewardships.agentId))
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.userId, userId),
          eq(agents.companyId, companyId),
          isNull(agentStewardships.endedAt),
          // Same defence as `activeByUser`: a dead agent is not "my agent".
          ne(agents.status, "terminated"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row;
  }

  /**
   * Who stands behind each of these agents, keyed by agent id.
   *
   * Batched rather than per-agent because the agent list is the main caller and
   * a per-row lookup there is one query per agent on a hot read path.
   *
   * A LEFT join, not an inner one: an agent whose steward has no auth user row
   * must still report a steward. Dropping the row would tell the caller the
   * agent is unstewarded, which is a different and wrong answer.
   */
  async function activeStewardsByAgentIds(
    companyId: string,
    agentIds: string[],
  ): Promise<Map<string, AgentStewardSummary>> {
    const byAgentId = new Map<string, AgentStewardSummary>();
    if (agentIds.length === 0) return byAgentId;
    const rows = await db
      .select({
        agentId: agentStewardships.agentId,
        userId: agentStewardships.userId,
        startedAt: agentStewardships.startedAt,
        name: authUsers.name,
        email: authUsers.email,
      })
      .from(agentStewardships)
      .leftJoin(authUsers, eq(authUsers.id, agentStewardships.userId))
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          inArray(agentStewardships.agentId, agentIds),
          isNull(agentStewardships.endedAt),
        ),
      );
    for (const row of rows) {
      byAgentId.set(row.agentId, {
        userId: row.userId,
        name: row.name ?? null,
        email: row.email ?? null,
        since: row.startedAt,
      });
    }
    return byAgentId;
  }

  async function activeStewardForAgent(
    companyId: string,
    agentId: string,
  ): Promise<AgentStewardSummary | null> {
    const byAgentId = await activeStewardsByAgentIds(companyId, [agentId]);
    return byAgentId.get(agentId) ?? null;
  }

  async function historyForAgent(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentStewardships)
      .where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.agentId, agentId)))
      .orderBy(desc(agentStewardships.startedAt));
  }

  async function assign(companyId: string, input: AssignInput, acceptance?: ActivityAcceptance, beforeWrite?: () => void): Promise<AgentStewardshipRow> {
    const now = new Date();

    try {
      return await accept(acceptance, async (tx, publications) => {
        await lockActiveUserMember(tx, companyId, input.userId);
        await lockAssignableCompanyAgent(tx, companyId, input.agentId);

        beforeWrite?.();
        const row = await tx
          .insert(agentStewardships)
          .values({
            companyId,
            agentId: input.agentId,
            userId: input.userId,
            assignedByUserId: input.assignedByUserId,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);

        publications.push(await insertActivity(tx, {
          companyId,
          actorType: "user",
          actorId: input.assignedByUserId ?? "board",
          action: "agent.stewardship_assigned",
          entityType: "agent_stewardship",
          entityId: row.id,
          agentId: input.agentId,
          details: {
            userId: input.userId,
            agentId: input.agentId,
          },
        }));

        return row;
      });
    } catch (error) {
      if (isStewardshipUniqueConflict(error)) {
        throw conflict("Agent or user already has an active stewardship");
      }
      throw error;
    }
  }

  async function transfer(companyId: string, agentId: string, input: TransferInput, acceptance?: ActivityAcceptance, beforeWrite?: () => void): Promise<AgentStewardshipRow> {
    const transferReason = normalizeReason(input.transferReason);
    const now = new Date();

    try {
      return await accept(acceptance, async (tx, publications) => {
        const lockResult = await tx.execute(sql`
          select pg_try_advisory_xact_lock(hashtextextended(${`${companyId}:${agentId}`}, 0)) as locked
        `);
        const lockRows = resultRows(lockResult) as Array<{ locked?: boolean }>;
        if (lockRows[0]?.locked !== true) {
          throw conflict("Agent stewardship transfer already in progress");
        }

        // AgentDash: take the successor INSERT's existing company FK lock before
        // membership/agent locks, matching company-first source authorization.
        const parent = await tx.execute(sql`
          select ${companies.id} from ${companies}
          where ${companies.id} = ${companyId}
          for key share
        `);
        if (resultRows(parent).length === 0) throw notFound("Company not found");

        await lockActiveUserMember(tx, companyId, input.userId);
        await lockTransferCompanyAgent(tx, companyId, agentId);

        const locked = await tx.execute(sql`
          select ${agentStewardships.id}
          from ${agentStewardships}
          where ${agentStewardships.companyId} = ${companyId}
            and ${agentStewardships.agentId} = ${agentId}
            and ${agentStewardships.endedAt} is null
          for update
        `);
        const lockedRows = resultRows(locked);
        if (lockedRows.length === 0) {
          throw conflict("Active stewardship changed; retry the transfer");
        }

        const active = await tx
          .select()
          .from(agentStewardships)
          .where(
            and(
              eq(agentStewardships.companyId, companyId),
              eq(agentStewardships.agentId, agentId),
              isNull(agentStewardships.endedAt),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!active) {
          throw conflict("Active stewardship changed; retry the transfer");
        }
        if (active.userId === input.userId) {
          throw conflict("Agent is already stewarded by this user");
        }

        beforeWrite?.();
        await tx
          .update(agentStewardships)
          .set({
            endedAt: now,
            endedByUserId: input.transferredByUserId,
            updatedAt: now,
          })
          .where(eq(agentStewardships.id, active.id));

        const next = await tx
          .insert(agentStewardships)
          .values({
            companyId,
            agentId,
            userId: input.userId,
            assignedByUserId: input.transferredByUserId,
            transferReason,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);

        // The outgoing steward's channel bindings grant a path to act for this
        // agent, so they end with the stewardship rather than outliving it.
        //
        // `.returning()` is load-bearing: each revoked row gets its own audit
        // entry below. "The stewardship ended" does not answer the question an
        // incident review actually asks — when did THIS channel stop being able
        // to act, and why.
        const revokedBindings = await tx
          .update(humanChannelBindings)
          .set({
            revokedAt: now,
            revokedByUserId: input.transferredByUserId,
            updatedAt: now,
          })
          .where(
            and(
              eq(humanChannelBindings.companyId, companyId),
              eq(humanChannelBindings.userId, active.userId),
              isNull(humanChannelBindings.revokedAt),
            ),
          )
          .returning();

        // Same rule, same transaction, for bridge endpoints: an enrolled
        // machine is a path for the outgoing steward to keep doing this agent's
        // work, and it must not survive the stewardship that justified it.
        const revokedEndpoints = await tx
          .update(bridgeEndpoints)
          .set({
            revokedAt: now,
            revokedByUserId: input.transferredByUserId,
            updatedAt: now,
          })
          .where(
            and(
              eq(bridgeEndpoints.companyId, companyId),
              eq(bridgeEndpoints.userId, active.userId),
              isNull(bridgeEndpoints.revokedAt),
            ),
          )
          .returning();

        await auditRevocations(tx, {
          companyId,
          actorUserId: input.transferredByUserId,
          reason: "stewardship_transferred",
          bindings: revokedBindings,
          endpoints: revokedEndpoints,
        }, publications);

        publications.push(await insertActivity(tx, {
          companyId,
          actorType: "user",
          actorId: input.transferredByUserId ?? "board",
          action: "agent.stewardship_transferred",
          entityType: "agent_stewardship",
          entityId: next.id,
          agentId,
          details: {
            fromUserId: active.userId,
            toUserId: input.userId,
            previousStewardshipId: active.id,
            transferReason,
          },
        }));

        return next;
      });
    } catch (error) {
      if (isStewardshipUniqueConflict(error)) {
        throw conflict("Agent or user already has an active stewardship");
      }
      throw error;
    }
  }

  /**
   * End an agent's pairing without putting anybody else in its place.
   *
   * The missing third verb. `assign` creates a pairing and `transfer` moves one,
   * and until this existed the only way to leave an agent with no steward was to
   * archive the person — so "release this agent" meant "remove that human from
   * the company", and the guard that tells you to end a pairing before making an
   * agent autonomous pointed at something no caller could do. It was reachable
   * only by calling `endActiveForUser` from a script, which is how it was done
   * the first time, and that is not a thing to leave as the answer.
   *
   * Keyed by agent rather than by user because that is the question being asked
   * — this agent should stand alone — even though the 1:1 constraint means the
   * two select the same row.
   *
   * Structured exactly like `transfer` minus the incoming steward: same advisory
   * lock so two releases cannot interleave, same `for update` re-read so a
   * transfer landing between the check and the write loses, and the same
   * revocation of the outgoing steward's channel bindings and bridge endpoints.
   * Those are paths to act for this agent; the moment the pairing that justified
   * them ends, they end too.
   */
  async function releaseForAgent(
    companyId: string,
    agentId: string,
    input: ReleaseInput,
  ): Promise<AgentStewardshipRow> {
    const releaseReason = normalizeReason(input.releaseReason);
    const now = new Date();

    return db.transaction(async (tx) => {
      const lockResult = await tx.execute(sql`
        select pg_try_advisory_xact_lock(hashtextextended(${`${companyId}:${agentId}`}, 0)) as locked
      `);
      const lockRows = resultRows(lockResult) as Array<{ locked?: boolean }>;
      if (lockRows[0]?.locked !== true) {
        throw conflict("Agent stewardship change already in progress");
      }

      // Release, unlike transfer and assign, is allowed on a terminated agent:
      // ending a dead agent's pairing is exactly what frees its person for a
      // new one. Nobody is being handed authority over the terminated agent.
      await lockTransferCompanyAgent(tx, companyId, agentId, { allowTerminated: true });

      const locked = await tx.execute(sql`
        select ${agentStewardships.id}
        from ${agentStewardships}
        where ${agentStewardships.companyId} = ${companyId}
          and ${agentStewardships.agentId} = ${agentId}
          and ${agentStewardships.endedAt} is null
        for update
      `);
      if (resultRows(locked).length === 0) {
        throw notFound("Active stewardship not found");
      }

      const active = await tx
        .select()
        .from(agentStewardships)
        .where(
          and(
            eq(agentStewardships.companyId, companyId),
            eq(agentStewardships.agentId, agentId),
            isNull(agentStewardships.endedAt),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!active) {
        throw notFound("Active stewardship not found");
      }

      const ended = await tx
        .update(agentStewardships)
        .set({
          endedAt: now,
          endedByUserId: input.releasedByUserId,
          updatedAt: now,
        })
        .where(eq(agentStewardships.id, active.id))
        .returning()
        .then((rows) => rows[0]!);

      const revokedBindings = await tx
        .update(humanChannelBindings)
        .set({
          revokedAt: now,
          revokedByUserId: input.releasedByUserId,
          updatedAt: now,
        })
        .where(
          and(
            eq(humanChannelBindings.companyId, companyId),
            eq(humanChannelBindings.userId, active.userId),
            isNull(humanChannelBindings.revokedAt),
          ),
        )
        .returning();

      const revokedEndpoints = await tx
        .update(bridgeEndpoints)
        .set({
          revokedAt: now,
          revokedByUserId: input.releasedByUserId,
          updatedAt: now,
        })
        .where(
          and(
            eq(bridgeEndpoints.companyId, companyId),
            eq(bridgeEndpoints.userId, active.userId),
            isNull(bridgeEndpoints.revokedAt),
          ),
        )
        .returning();

      await auditRevocations(tx, {
        companyId,
        actorUserId: input.releasedByUserId,
        reason: "stewardship_released",
        bindings: revokedBindings,
        endpoints: revokedEndpoints,
      });

      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: input.releasedByUserId ?? "board",
        action: "agent.stewardship_ended",
        entityType: "agent_stewardship",
        entityId: ended.id,
        agentId,
        details: {
          userId: active.userId,
          reason: "released",
          releaseReason,
        },
      });

      return ended;
    });
  }

  async function endActiveForUser(
    companyId: string,
    userId: string,
    endedByUserId: string | null,
    database: StewardshipDb = db,
  ) {
    const now = new Date();
    const revokedBindings = await database
      .update(humanChannelBindings)
      .set({ revokedAt: now, revokedByUserId: endedByUserId, updatedAt: now })
      .where(
        and(
          eq(humanChannelBindings.companyId, companyId),
          eq(humanChannelBindings.userId, userId),
          isNull(humanChannelBindings.revokedAt),
        ),
      )
      .returning();
    const revokedEndpoints = await database
      .update(bridgeEndpoints)
      .set({ revokedAt: now, revokedByUserId: endedByUserId, updatedAt: now })
      .where(
        and(
          eq(bridgeEndpoints.companyId, companyId),
          eq(bridgeEndpoints.userId, userId),
          isNull(bridgeEndpoints.revokedAt),
        ),
      )
      .returning();
    await auditRevocations(database, {
      companyId,
      actorUserId: endedByUserId,
      reason: "stewardship_ended",
      bindings: revokedBindings,
      endpoints: revokedEndpoints,
    });
    return database
      .update(agentStewardships)
      .set({
        endedAt: now,
        endedByUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.userId, userId),
          isNull(agentStewardships.endedAt),
        ),
      )
      .returning();
  }

  async function requireActiveByAgent(companyId: string, agentId: string) {
    const stewardship = await activeByAgent(companyId, agentId);
    if (!stewardship) throw notFound("Active stewardship not found");
    return stewardship;
  }

  async function createActivityForArchivedStewardships(input: {
    companyId: string;
    userId: string;
    endedByUserId: string | null;
    stewardships: AgentStewardshipRow[];
    database: StewardshipDb;
  }) {
    if (input.stewardships.length === 0) return;
    await input.database.insert(activityLog).values(
      input.stewardships.map((stewardship) => ({
        companyId: input.companyId,
        actorType: "user",
        actorId: input.endedByUserId ?? input.userId,
        action: "agent.stewardship_ended",
        entityType: "agent_stewardship",
        entityId: stewardship.id,
        agentId: stewardship.agentId,
        details: {
          userId: input.userId,
          reason: "member_archived",
        },
        // AgentDash (consolidation PR-C): server-written, actor resolved here.
        origin: "server" as const,
      })),
    );
  }

  return {
    activeByUser,
    hasStewardshipHistory,
    activeByAgent,
    activeByUserWithAgent,
    activeStewardsByAgentIds,
    activeStewardForAgent,
    historyForAgent,
    requireActiveByAgent,
    assign,
    transfer,
    releaseForAgent,
    endActiveForUser,
    createActivityForArchivedStewardships,
  };
}
