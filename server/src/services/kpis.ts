import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { kpis } from "@agentdash/db";

// AgentDash: Manual KPIs service (AGE-45)

type KpiRow = typeof kpis.$inferSelect;

export type KpiCreateInput = {
  name: string;
  unit?: string;
  targetValue: number | string;
  currentValue?: number | string | null;
  priority?: number;
};

export type KpiUpdateInput = Partial<KpiCreateInput>;

function toNumericString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

export function kpisService(db: Db) {
  return {
    list: (companyId: string): Promise<KpiRow[]> =>
      db
        .select()
        .from(kpis)
        .where(eq(kpis.companyId, companyId))
        .orderBy(desc(kpis.priority), kpis.createdAt),

    getById: (id: string): Promise<KpiRow | null> =>
      db
        .select()
        .from(kpis)
        .where(eq(kpis.id, id))
        .then((rows) => rows[0] ?? null),

    findByName: (companyId: string, name: string): Promise<KpiRow | null> =>
      db
        .select()
        .from(kpis)
        .where(and(eq(kpis.companyId, companyId), eq(kpis.name, name)))
        .then((rows) => rows[0] ?? null),

    create: async (companyId: string, data: KpiCreateInput): Promise<KpiRow> => {
      const values: typeof kpis.$inferInsert = {
        companyId,
        name: data.name,
        unit: data.unit ?? "",
        targetValue: toNumericString(data.targetValue) ?? "0",
        currentValue: toNumericString(data.currentValue ?? null),
        priority: data.priority ?? 0,
      };
      const rows = await db.insert(kpis).values(values).returning();
      return rows[0]!;
    },

    update: async (id: string, data: KpiUpdateInput): Promise<KpiRow | null> => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.unit !== undefined) updates.unit = data.unit;
      if (data.targetValue !== undefined) updates.targetValue = toNumericString(data.targetValue);
      if (data.currentValue !== undefined) {
        updates.currentValue = toNumericString(data.currentValue ?? null);
      }
      if (data.priority !== undefined) updates.priority = data.priority;
      const rows = await db.update(kpis).set(updates).where(eq(kpis.id, id)).returning();
      return rows[0] ?? null;
    },

    remove: async (id: string): Promise<KpiRow | null> => {
      const rows = await db.delete(kpis).where(eq(kpis.id, id)).returning();
      return rows[0] ?? null;
    },

    setValue: async (id: string, value: number | string): Promise<KpiRow | null> => {
      const rows = await db
        .update(kpis)
        .set({ currentValue: toNumericString(value), updatedAt: new Date() })
        .where(eq(kpis.id, id))
        .returning();
      return rows[0] ?? null;
    },
  };
}

export type KpisService = ReturnType<typeof kpisService>;
