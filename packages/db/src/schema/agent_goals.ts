import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { goals } from "./goals.js";

// AgentDash: Many-to-many link between agents and the business goals they serve.
// Populated when an agent_plan is approved; readable from the Goal detail page.
export const agentGoals = pgTable(
  "agent_goals",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.goalId] }),
    index("agent_goals_goal_idx").on(table.goalId),
    index("agent_goals_company_idx").on(table.companyId),
  ],
);
