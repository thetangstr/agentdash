import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { goals } from "./goals.js";

export const agentOkrs = pgTable(
  "agent_okrs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id),
    objective: text("objective").notNull(),
    status: text("status").notNull().default("active"),
    period: text("period").notNull().default("quarterly"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_okrs_company_agent_status_idx").on(table.companyId, table.agentId, table.status),
    index("agent_okrs_company_agent_period_idx").on(table.companyId, table.agentId, table.periodEnd),
  ],
);
