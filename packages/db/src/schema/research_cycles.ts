import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

export const researchCycles = pgTable(
  "research_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id),
    projectId: uuid("project_id").references(() => projects.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    maxIterations: integer("max_iterations"),
    currentIteration: integer("current_iteration").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("research_cycles_company_status_idx").on(table.companyId, table.status),
    index("research_cycles_goal_idx").on(table.companyId, table.goalId),
  ],
);
