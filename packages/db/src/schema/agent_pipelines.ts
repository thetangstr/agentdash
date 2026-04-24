import { pgTable, uuid, text, timestamp, jsonb, index, numeric } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";

// AgentDash: Pipeline orchestration
export const agentPipelines = pgTable(
  "agent_pipelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // AgentDash: business goal this pipeline serves (goal-driven workflow)
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    stages: jsonb("stages").notNull().$type<any[]>().default([]),
    // AgentDash: DAG edges connecting stages
    edges: jsonb("edges").notNull().$type<any[]>().default([]),
    // AgentDash: sync (direct execute) or async (heartbeat-driven)
    executionMode: text("execution_mode").notNull().default("sync"),
    // AgentDash: pipeline-level timeout/budget/retry defaults
    defaults: jsonb("defaults").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("draft"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_pipelines_company_idx").on(table.companyId),
    index("agent_pipelines_goal_idx").on(table.goalId),
  ],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id").notNull().references(() => agentPipelines.id),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    // AgentDash: sync or async execution mode for this run
    executionMode: text("execution_mode").notNull().default("sync"),
    // AgentDash: tracks multiple active stages for parallel fan-out
    activeStageIds: jsonb("active_stage_ids").$type<string[]>().default([]),
    inputData: jsonb("input_data").$type<Record<string, unknown>>(),
    outputData: jsonb("output_data").$type<Record<string, unknown>>(),
    // AgentDash: cost tracking
    totalCostUsd: numeric("total_cost_usd").default("0"),
    triggeredBy: uuid("triggered_by"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pipeline_runs_pipeline_idx").on(table.pipelineId),
    index("pipeline_runs_company_idx").on(table.companyId),
  ],
);
