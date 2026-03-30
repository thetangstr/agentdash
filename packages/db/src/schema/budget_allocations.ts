import { pgTable, uuid, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { budgetPolicies } from "./budget_policies.js";

export const budgetAllocations = pgTable(
  "budget_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    parentPolicyId: uuid("parent_policy_id").notNull().references(() => budgetPolicies.id),
    childPolicyId: uuid("child_policy_id").notNull().references(() => budgetPolicies.id),
    allocatedAmount: integer("allocated_amount").notNull(),
    isFlexible: boolean("is_flexible").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("budget_allocations_parent_child_unique").on(table.parentPolicyId, table.childPolicyId),
    index("budget_allocations_company_parent_idx").on(table.companyId, table.parentPolicyId),
  ],
);
