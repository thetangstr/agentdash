import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, date, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

// AgentDash: goals-eval-hitl
export type DefinitionOfDoneCriterion = {
  id: string;
  text: string;
  done: boolean;
};

export type DefinitionOfDone = {
  summary: string;
  criteria: DefinitionOfDoneCriterion[];
  goalMetricLink?: string;
};

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    env: jsonb("env").$type<AgentEnvConfig>(),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    executionWorkspacePolicy: jsonb("execution_workspace_policy").$type<Record<string, unknown>>(),
    // AgentDash: goals-eval-hitl
    definitionOfDone: jsonb("definition_of_done").$type<DefinitionOfDone>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // A3 (2026-08-16): ownership. Text, not an auth FK, for the same reason
    // as agent_stewardships.user_id — durable principals must survive
    // auth-user cleanup. Backfilled to each company's first admin (the only
    // human who has ever existed on mkboard).
    createdByUserId: text("created_by_user_id"),
    // A5: open by default; 'restricted' limits visibility to the access
    // list (project_access) plus admins. The exception, not the rule.
    visibility: text("visibility").notNull().default("company"),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
    // A6: two live projects in one company cannot share a name. Partial so
    // an archived project frees its name. Measured before adding: zero
    // duplicates on either instance (mkboard has 0 projects, uat 1).
    companyNameUniqueIdx: uniqueIndex("projects_company_name_unique_idx")
      .on(table.companyId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
  }),
);
