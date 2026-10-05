import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, goals } from "@paperclipai/db";

import { conflict, notFound } from "../errors.js";
import { assertActivityAcceptance, type ActivityAcceptance } from "./activity-log.js";

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
  async function accept<T>(supplied: ActivityAcceptance | undefined, work: (tx: Db) => Promise<T>) {
    if (supplied !== undefined) { assertActivityAcceptance(supplied); return work(supplied.executor); }
    return db.transaction(tx => work(tx as unknown as Db));
  }
  async function lockCompanies(tx: Db, ids: string[]) {
    await tx.select({ id: companies.id }).from(companies)
      .where(inArray(companies.id, [...new Set(ids)].sort())).orderBy(asc(companies.id)).for("no key update");
  }
  async function lockGoalCompanies(tx: Db, id: string, nextCompanyId?: string) {
    const [before] = await tx.select().from(goals).where(eq(goals.id, id));
    if (!before) return null;
    await lockCompanies(tx, [before.companyId, nextCompanyId ?? before.companyId]);
    const [current] = await tx.select().from(goals).where(eq(goals.id, id));
    if (!current) return null;
    if (current.companyId !== before.companyId) throw conflict("Goal company changed before acceptance");
    return current;
  }
  // AgentDash (GH #921): parentId and ownerAgentId are foreign keys the schema
  // enforces at the database, not the company boundary. Writing a reference to
  // another company's row used to succeed, and an id matching nothing surfaced
  // the raw 23503 as a 500. Validate inside the locked transaction and answer
  // 404 on a miss, the visibility rule's convention.
  async function assertReferences(tx: Db, companyId: string, data: { parentId?: string | null; ownerAgentId?: string | null }) {
    if (data.parentId) {
      const parent = await tx
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.id, data.parentId), eq(goals.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent goal not found");
    }
    if (data.ownerAgentId) {
      const owner = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, data.ownerAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!owner) throw notFound("Owner agent not found");
    }
  }
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    // AgentDash: candidate-set writers participate even when no selected goal exists.
    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">, acceptance?: ActivityAcceptance) =>
      accept(acceptance, async tx => {
        await lockCompanies(tx, [companyId]);
        await assertReferences(tx, companyId, data);
        return (await tx.insert(goals).values({ ...data, companyId }).returning())[0];
      }),

    update: (id: string, data: Partial<typeof goals.$inferInsert>, acceptance?: ActivityAcceptance) =>
      accept(acceptance, async tx => {
        const current = await lockGoalCompanies(tx, id, data.companyId);
        if (!current) return null;
        if (data.parentId && data.parentId === id) throw conflict("A goal cannot be its own parent");
        await assertReferences(tx, data.companyId ?? current.companyId, data);
        return (await tx.update(goals).set({ ...data, updatedAt: new Date() }).where(eq(goals.id, id)).returning())[0] ?? null;
      }),

    remove: (id: string, acceptance?: ActivityAcceptance) =>
      accept(acceptance, async tx => {
        if (typeof tx.delete !== "function") throw new Error("Goal deletion requires a delete-capable executor");
        if (!await lockGoalCompanies(tx, id)) return null;
        return (await tx.delete(goals).where(eq(goals.id, id)).returning())[0] ?? null;
      }),
  };
}
