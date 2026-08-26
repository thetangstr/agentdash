import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const onboardingSessions = pgTable(
  "onboarding_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("in_progress"),
    currentStep: text("current_step").notNull().default("discovery"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: text("created_by_user_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUnique: uniqueIndex("onboarding_sessions_company_user_unique").on(
      table.companyId,
      table.createdByUserId,
    ),
  }),
);
