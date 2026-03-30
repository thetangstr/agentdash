import { pgTable, uuid, text, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentSandboxes = pgTable(
  "agent_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    isolationLevel: text("isolation_level").notNull().default("process"),
    networkPolicy: jsonb("network_policy").notNull().$type<Record<string, unknown>>().default({}),
    filesystemPolicy: jsonb("filesystem_policy").notNull().$type<Record<string, unknown>>().default({}),
    resourceLimits: jsonb("resource_limits").notNull().$type<Record<string, unknown>>().default({}),
    environmentVars: jsonb("environment_vars").notNull().$type<Record<string, unknown>>().default({}),
    secretAccess: jsonb("secret_access").notNull().$type<string[]>().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_sandboxes_company_agent_unique").on(table.companyId, table.agentId),
  ],
);
