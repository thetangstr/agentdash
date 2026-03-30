import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const onboardingSessions = pgTable(
  "onboarding_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    status: text("status").notNull().default("in_progress"),
    currentStep: text("current_step").notNull().default("discovery"),
    context: jsonb("context").notNull().$type<Record<string, unknown>>().default({}),
    createdByUserId: text("created_by_user_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("onboarding_sessions_company_status_idx").on(table.companyId, table.status),
  ],
);
