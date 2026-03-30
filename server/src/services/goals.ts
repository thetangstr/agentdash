import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";

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

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId"> & { targetDate?: string | Date | null }) => {
      const values = {
        ...data,
        companyId,
        targetDate: data.targetDate ? new Date(data.targetDate) : null,
      };
      return db
        .insert(goals)
        .values(values)
        .returning()
        .then((rows) => rows[0]);
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
