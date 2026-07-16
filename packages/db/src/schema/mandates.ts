import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { budgetPolicies } from "./budget_policies.js";

export const mandates = pgTable(
  "mandates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    grantorAgentId: uuid("grantor_agent_id").notNull().references(() => agents.id),
    granteeAgentId: uuid("grantee_agent_id").notNull().references(() => agents.id),
    scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
    permissionKey: text("permission_key").notNull(),
    spendCapCents: integer("spend_cap_cents").notNull().default(0),
    budgetPolicyId: uuid("budget_policy_id").references(() => budgetPolicies.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // active | expired | revoked
    status: text("status").notNull().default("active"),
    // Clockchain anchor — set only when delegate_authority actually returns a ledgerId
    ccLedgerId: text("cc_ledger_id"),
    ccBlockHeight: integer("cc_block_height"),
    ccScheme: text("cc_scheme"),
    ccAnchoredAt: timestamp("cc_anchored_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("mandates_company_status_idx").on(table.companyId, table.status),
    granteeIdx: index("mandates_grantee_idx").on(table.companyId, table.granteeAgentId),
  }),
);
