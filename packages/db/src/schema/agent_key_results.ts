import { pgTable, uuid, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agentOkrs } from "./agent_okrs.js";

export const agentKeyResults = pgTable(
  "agent_key_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    okrId: uuid("okr_id").notNull().references(() => agentOkrs.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    targetValue: numeric("target_value").notNull(),
    currentValue: numeric("current_value").notNull().default("0"),
    unit: text("unit").notNull().default("count"),
    weight: numeric("weight").notNull().default("1.0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_key_results_okr_idx").on(table.okrId),
  ],
);
