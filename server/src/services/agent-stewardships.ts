import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentStewardships,
  companyMemberships,
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

export function agentStewardshipService(db: Db) {
  async function assertActiveUserMember(companyId: string, userId: string, database: StewardshipDb = db) {
    const membership = await database
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
    if (!membership) {
      throw conflict("Steward user must be an active company member");
    }
  }

  async function assertAssignableCompanyAgent(companyId: string, agentId: string, database: StewardshipDb = db) {
    const agent = await database
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== companyId) {
      throw conflict("Stewardship agent must belong to the same company");
    }
    if (agent.status === "terminated") {
      throw conflict("Stewardship agent must not be terminated");
    }
    return agent;
  }

  async function assertTransferCompanyAgent(companyId: string, agentId: string, database: StewardshipDb = db) {
    const agent = await database
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      throw notFound("Agent not found");
    }
    if (agent.status === "terminated") {
      throw conflict("Stewardship agent must not be terminated");
    }
    return agent;
  }

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
    await assertActiveUserMember(companyId, input.userId);
    await assertAssignableCompanyAgent(companyId, input.agentId);
    const now = new Date();

    try {
      return await db.transaction(async (tx) => {
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
    await assertActiveUserMember(companyId, input.userId);
    await assertTransferCompanyAgent(companyId, agentId);
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
