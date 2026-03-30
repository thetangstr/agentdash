import { pgTable, uuid, text, timestamp, integer, numeric, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { budgetPolicies } from "./budget_policies.js";

export const budgetForecasts = pgTable(
  "budget_forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    policyId: uuid("policy_id").notNull().references(() => budgetPolicies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    forecastType: text("forecast_type").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    projectedAmount: integer("projected_amount").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    inputs: jsonb("inputs").notNull().$type<Record<string, unknown>>(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("budget_forecasts_company_policy_idx").on(table.companyId, table.policyId, table.forecastType, table.computedAt),
  ],
);
