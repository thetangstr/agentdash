import { pgTable, uuid, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// AgentDash: Pipeline definitions — ordered sequences of agent stages
export const agentPipelines = pgTable("agent_pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  stages: jsonb("stages").notNull().$type<Array<{
    order: number;
    name: string;
    agentTemplateSlug?: string;
    agentId?: string;
    autoAdvance: boolean;
    config?: Record<string, unknown>;
  }>>(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("agent_pipelines_company_status_idx").on(table.companyId, table.status),
]);

// AgentDash: Pipeline run — individual execution of a pipeline
export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  pipelineId: uuid("pipeline_id").notNull().references(() => agentPipelines.id),
  triggerIssueId: uuid("trigger_issue_id").references(() => issues.id),
  status: text("status").notNull().default("running"),
  currentStageIndex: integer("current_stage_index").notNull().default(0),
  stageResults: jsonb("stage_results").notNull().$type<Array<{
    stageIndex: number;
    stageName: string;
    agentId: string;
    issueId: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    output?: Record<string, unknown>;
  }>>().default([]),
  context: jsonb("context").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("pipeline_runs_company_status_idx").on(table.companyId, table.status),
  index("pipeline_runs_pipeline_idx").on(table.pipelineId),
  index("pipeline_runs_trigger_issue_idx").on(table.triggerIssueId),
]);
