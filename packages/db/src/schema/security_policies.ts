import { pgTable, uuid, text, timestamp, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const securityPolicies = pgTable(
  "security_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    policyType: text("policy_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    rules: jsonb("rules").notNull().$type<Array<Record<string, unknown>>>(),
    effect: text("effect").notNull().default("deny"),
    priority: integer("priority").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("security_policies_company_type_active_idx").on(table.companyId, table.policyType, table.isActive),
    index("security_policies_company_target_idx").on(table.companyId, table.targetType, table.targetId, table.isActive),
  ],
);
