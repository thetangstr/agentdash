import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentStewardships = pgTable(
  "agent_stewardships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    userId: text("user_id").notNull(),
    assignedByUserId: text("assigned_by_user_id"),
    endedByUserId: text("ended_by_user_id"),
    transferReason: text("transfer_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeUserUq: uniqueIndex("agent_stewardships_active_user_uq")
      .on(table.companyId, table.userId)
      .where(sql`${table.endedAt} is null`),
    activeAgentUq: uniqueIndex("agent_stewardships_active_agent_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.endedAt} is null`),
    companyUserIdx: index("agent_stewardships_company_user_idx").on(table.companyId, table.userId),
    companyAgentStartedIdx: index("agent_stewardships_company_agent_started_idx").on(
      table.companyId,
      table.agentId,
      table.startedAt,
    ),
  }),
);
