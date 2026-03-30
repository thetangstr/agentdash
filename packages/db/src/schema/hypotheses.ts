import { type AnyPgColumn, pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { researchCycles } from "./research_cycles.js";
import { agents } from "./agents.js";

export const hypotheses = pgTable(
  "hypotheses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    cycleId: uuid("cycle_id").notNull().references(() => researchCycles.id, { onDelete: "cascade" }),
    parentHypothesisId: uuid("parent_hypothesis_id").references((): AnyPgColumn => hypotheses.id),
    title: text("title").notNull(),
    rationale: text("rationale"),
    source: text("source").notNull().default("ai"),
    sourceContext: jsonb("source_context").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("proposed"),
    priority: integer("priority").notNull().default(0),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("hypotheses_company_cycle_idx").on(table.companyId, table.cycleId, table.status),
    index("hypotheses_parent_idx").on(table.parentHypothesisId),
  ],
);
