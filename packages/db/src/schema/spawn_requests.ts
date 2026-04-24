import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";
import { agentTemplates } from "./agent_templates.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const spawnRequests = pgTable(
  "spawn_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").references(() => approvals.id),
    templateId: uuid("template_id").references(() => agentTemplates.id),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    quantity: integer("quantity").notNull().default(1),
    reason: text("reason"),
    projectId: uuid("project_id").references(() => projects.id),
    agentConfig: jsonb("agent_config").notNull().$type<Record<string, unknown>>().default({}),
    status: text("status").notNull().default("pending"),
    spawnedAgentIds: jsonb("spawned_agent_ids").notNull().$type<string[]>().default([]),
    fulfilledCount: integer("fulfilled_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("spawn_requests_company_status_idx").on(table.companyId, table.status),
    index("spawn_requests_company_approval_idx").on(table.companyId, table.approvalId),
    index("spawn_requests_company_template_idx").on(table.companyId, table.templateId),
  ],
);
