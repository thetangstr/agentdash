import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { departments } from "./departments.js";

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    role: text("role").notNull().default("general"),
    icon: text("icon"),
    adapterType: text("adapter_type").notNull().default("claude_local"),
    adapterConfig: jsonb("adapter_config").notNull().$type<Record<string, unknown>>().default({}),
    runtimeConfig: jsonb("runtime_config").notNull().$type<Record<string, unknown>>().default({}),
    skillKeys: jsonb("skill_keys").notNull().$type<string[]>().default([]),
    instructionsTemplate: text("instructions_template"),
    okrs: jsonb("okrs").notNull().$type<Array<{ objective: string; keyResults: Array<{ metric: string; target: number; unit: string }> }>>().default([]),
    kpis: jsonb("kpis").notNull().$type<Array<{ name: string; metric: string; target: number; unit: string; frequency: string }>>().default([]),
    authorityLevel: text("authority_level").notNull().default("executor"),
    taskClassification: text("task_classification").notNull().default("deterministic"),
    estimatedCostPerTaskCents: integer("estimated_cost_per_task_cents"),
    estimatedMinutesPerTask: integer("estimated_minutes_per_task"),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    departmentId: uuid("department_id").references(() => departments.id),
    permissions: jsonb("permissions").notNull().$type<Record<string, unknown>>().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_templates_company_slug_unique").on(table.companyId, table.slug),
    index("agent_templates_company_role_idx").on(table.companyId, table.role),
  ],
);
