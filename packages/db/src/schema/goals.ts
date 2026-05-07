import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// AgentDash: goals-eval-hitl
export type GoalMetricDefinition = {
  target: number | string;
  unit: string;
  source: string;
  baseline?: number | string;
  currentValue?: number | string;
  lastUpdatedAt?: string;
};

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    description: text("description"),
    level: text("level").notNull().default("task"),
    status: text("status").notNull().default("planned"),
    parentId: uuid("parent_id").references((): AnyPgColumn => goals.id),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    // AgentDash: goals-eval-hitl
    metricDefinition: jsonb("metric_definition").$type<GoalMetricDefinition>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("goals_company_idx").on(table.companyId),
  }),
);
