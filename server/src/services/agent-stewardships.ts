import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentStewardships,
  companyMemberships,
  bridgeEndpoints,
  humanChannelBindings,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation, pgConstraintName } from "../lib/pg-error.js";
import { logActivity } from "./activity-log.js";

type AgentStewardshipRow = typeof agentStewardships.$inferSelect;
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
  if (row.status === "terminated") {
    throw conflict("Stewardship agent must not be terminated");
  }
}

async function lockAssignableCompanyAgent(
  database: StewardshipDb,
  companyId: string,
  agentId: string,
) {
  const result = await database.execute(sql`
    select ${agents.id}, ${agents.companyId}, ${agents.status}
    from ${agents}
    where ${agents.id} = ${agentId}
    for update
  `);
  const rows = resultRows(result) as Array<{ company_id?: string; companyId?: string; status?: string }>;
  const row = rows[0];
  const rowCompanyId = row?.company_id ?? row?.companyId;
  if (!row || rowCompanyId !== companyId) {
    throw conflict("Stewardship agent must belong to the same company");
  }
  if (row.status === "terminated") {
    throw conflict("Stewardship agent must not be terminated");
  }
}

export function agentStewardshipService(db: Db) {

  async function activeByUser(companyId: string, userId: string) {
    return db
      .select()
      .from(agentStewardships)
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.userId, userId),
          isNull(agentStewardships.endedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
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
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row;
  }

  async function historyForAgent(companyId: string, agentId: string) {
    return db
      .select()
      .from(agentStewardships)
      .where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.agentId, agentId)))
      .orderBy(desc(agentStewardships.startedAt));
  }

  async function assign(companyId: string, input: AssignInput): Promise<AgentStewardshipRow> {
    const now = new Date();

    try {
      return await db.transaction(async (tx) => {
        await lockActiveUserMember(tx, companyId, input.userId);
        await lockAssignableCompanyAgent(tx, companyId, input.agentId);

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

        await logActivity(tx as unknown as Db, {
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
        });

        return row;
      });
    } catch (error) {
      if (isStewardshipUniqueConflict(error)) {
        throw conflict("Agent or user already has an active stewardship");
      }
      throw error;
    }
  }

  async function transfer(companyId: string, agentId: string, input: TransferInput): Promise<AgentStewardshipRow> {
    const transferReason = normalizeReason(input.transferReason);
    const now = new Date();

    try {
      return await db.transaction(async (tx) => {
        const lockResult = await tx.execute(sql`
          select pg_try_advisory_xact_lock(hashtextextended(${`${companyId}:${agentId}`}, 0)) as locked
        `);
        const lockRows = resultRows(lockResult) as Array<{ locked?: boolean }>;
        if (lockRows[0]?.locked !== true) {
          throw conflict("Agent stewardship transfer already in progress");
        }

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
        await tx
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
          );

        // Same rule, same transaction, for bridge endpoints: an enrolled
        // machine is a path for the outgoing steward to keep doing this agent's
        // work, and it must not survive the stewardship that justified it.
        await tx
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
          );

        await logActivity(tx as unknown as Db, {
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
        });

        return next;
      });
    } catch (error) {
      if (isStewardshipUniqueConflict(error)) {
        throw conflict("Agent or user already has an active stewardship");
      }
      throw error;
    }
  }

  async function endActiveForUser(
    companyId: string,
    userId: string,
    endedByUserId: string | null,
    database: StewardshipDb = db,
  ) {
    const now = new Date();
    await database
      .update(humanChannelBindings)
      .set({ revokedAt: now, revokedByUserId: endedByUserId, updatedAt: now })
      .where(
        and(
          eq(humanChannelBindings.companyId, companyId),
          eq(humanChannelBindings.userId, userId),
          isNull(humanChannelBindings.revokedAt),
        ),
      );
    await database
      .update(bridgeEndpoints)
      .set({ revokedAt: now, revokedByUserId: endedByUserId, updatedAt: now })
      .where(
        and(
          eq(bridgeEndpoints.companyId, companyId),
          eq(bridgeEndpoints.userId, userId),
          isNull(bridgeEndpoints.revokedAt),
        ),
      );
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
      })),
    );
  }

  return {
    activeByUser,
    activeByAgent,
    activeByUserWithAgent,
    historyForAgent,
    requireActiveByAgent,
    assign,
    transfer,
    endActiveForUser,
    createActivityForArchivedStewardships,
  };
}
