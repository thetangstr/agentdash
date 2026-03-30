import { type AnyPgColumn, pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    parentId: uuid("parent_id").references((): AnyPgColumn => departments.id),
    leadUserId: text("lead_user_id"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("departments_company_idx").on(table.companyId),
    index("departments_company_parent_idx").on(table.companyId, table.parentId),
    uniqueIndex("departments_company_name_unique").on(table.companyId, table.name),
  ],
);
