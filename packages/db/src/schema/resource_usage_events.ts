import { pgTable, uuid, text, timestamp, integer, numeric, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const resourceUsageEvents = pgTable(
  "resource_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id),
    projectId: uuid("project_id").references(() => projects.id),
    resourceType: text("resource_type").notNull(),
    resourceProvider: text("resource_provider").notNull(),
    quantity: numeric("quantity").notNull(),
    unit: text("unit").notNull(),
    costCents: integer("cost_cents"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("resource_usage_events_company_type_idx").on(table.companyId, table.resourceType, table.occurredAt),
    index("resource_usage_events_company_agent_idx").on(table.companyId, table.agentId, table.resourceType, table.occurredAt),
  ],
);
