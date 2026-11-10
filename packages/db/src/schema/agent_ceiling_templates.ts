import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import type { AgentGovernancePolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";

/**
 * AgentDash admin powers: a named owner ceiling an admin can apply to many
 * agents at once, or make the company's ceiling for every new agent
 * (`companies.default_ceiling_template_id`). The table lands with the company
 * switches (migration 0159); its routes and the bulk apply arrive in part 3.
 */
export const agentCeilingTemplates = pgTable(
  "agent_ceiling_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The AgentGovernancePolicy shape (packages/shared/src/types/agent-governance.ts). */
    ceiling: jsonb("ceiling").$type<AgentGovernancePolicy>().notNull(),
    revision: integer("revision").notNull().default(1),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("agent_ceiling_templates_company_name_uq").on(table.companyId, table.name),
    companyIdx: index("agent_ceiling_templates_company_idx").on(table.companyId),
  }),
);
