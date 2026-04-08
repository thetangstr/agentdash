import { pgTable, uuid, text, timestamp, jsonb, integer, numeric, index } from "drizzle-orm/pg-core";
import { pipelineRuns } from "./agent_pipelines.js";

// AgentDash: Per-stage execution tracking for pipeline runs
export const pipelineStageExecutions = pgTable(
  "pipeline_stage_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineRunId: uuid("pipeline_run_id").notNull().references(() => pipelineRuns.id),
    stageId: text("stage_id").notNull(),
    status: text("status").notNull().default("pending"),
    heartbeatRunId: uuid("heartbeat_run_id"),
    inputState: jsonb("input_state").$type<Record<string, unknown>>(),
    outputState: jsonb("output_state").$type<Record<string, unknown>>(),
    costUsd: numeric("cost_usd").default("0"),
    selfHealAttempts: integer("self_heal_attempts").notNull().default(0),
    selfHealLog: jsonb("self_heal_log").$type<any[]>().default([]),
    approvalId: uuid("approval_id"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pipeline_stage_exec_run_idx").on(table.pipelineRunId),
    index("pipeline_stage_exec_stage_idx").on(table.pipelineRunId, table.stageId),
  ],
);
