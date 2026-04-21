import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { goals } from "@agentdash/db";

// AgentDash (AGE-48 Phase 1): options accepted by `goalService.create()`.
// `skipAutoPropose` suppresses the CoS auto-propose side-effect. Seed
// scripts, test fixtures, and bulk importers must pass
// `skipAutoPropose: true` so they do not produce phantom agent plans.
export interface CreateGoalOptions {
  skipAutoPropose?: boolean;
}

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (
      companyId: string,
      data: Omit<typeof goals.$inferInsert, "companyId"> & { targetDate?: string | Date | null },
      options: CreateGoalOptions = {},
    ) => {
      const values = {
        ...data,
        companyId,
        targetDate: data.targetDate ? new Date(data.targetDate) : null,
      };
      const created = await db
        .insert(goals)
        .values(values)
        .returning()
        .then((rows) => rows[0]);

      // AgentDash (AGE-48 Phase 1): auto-propose a Chief-of-Staff plan for
      // the new goal, unless the caller opts out (seed scripts, test
      // fixtures, bulk importers). The orchestrator swallows its own
      // errors — we await so tests can observe the proposed plan, but a
      // failure here must never fail goal creation. See cos-orchestrator.ts.
      if (!options.skipAutoPropose && created) {
        // Dynamic import avoids a circular dep (cos-orchestrator imports
        // goalService for its own lookups).
        const { cosOrchestratorService } = await import("./cos-orchestrator.js");
        await cosOrchestratorService(db).proposeForGoal(companyId, created.id);
      }

      return created;
    },

    update: (id: string, data: Partial<typeof goals.$inferInsert> & { targetDate?: string | Date | null }) => {
      const values: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (typeof data.targetDate === "string") {
        values.targetDate = new Date(data.targetDate);
      }
      return db
        .update(goals)
        .set(values)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
