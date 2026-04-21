import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// AgentDash: Manual KPIs — CEO-defined key performance indicators for a company.
// Values are updated manually or via the `update_kpi` agent tool; see AGE-45.
export const kpis = pgTable(
  "kpis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    unit: text("unit").notNull().default(""),
    targetValue: numeric("target_value").notNull().default("0"),
    currentValue: numeric("current_value"),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("kpis_company_priority_idx").on(table.companyId, table.priority.desc()),
  ],
);
