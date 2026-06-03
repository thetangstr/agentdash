// AgentDash (AGE-119): agent-run metering — one row per completed heartbeat run.
// Complexity tiering (simple/medium/complex) behind a single displayed
// "agent-run" unit. This table is the foundation for quota enforcement
// (AGE-120), overage billing (AGE-122), and the ledger UX (AGE-123).

import { pgTable, uuid, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" })
      .unique(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    // AgentDash: complexity tier — "simple" | "medium" | "complex".
    // Derived from token count + duration at recording time.
    // Displayed as a single "agent-run" unit to users.
    complexityTier: text("complexity_tier").notNull().default("simple"),
    // Duration of the heartbeat run in milliseconds (startedAt → finishedAt).
    durationMs: integer("duration_ms"),
    // Aggregate token count across all cost_events for this run.
    tokenCount: integer("token_count").notNull().default(0),
    // Aggregate cost in cents across all cost_events for this run.
    costCents: integer("cost_cents").notNull().default(0),
    // AgentDash (AGE-121): true when this run executed beyond the workspace's
    // included monthly allotment. Only relevant for Pro workspaces (Free
    // workspaces are hard-blocked before execution starts).
    isOverage: boolean("is_overage").notNull().default(false),
    // When the agent task completed (heartbeatRun.finishedAt).
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Monthly run count per workspace: WHERE company_id = ? AND completed_at >= ? AND completed_at < ?
    companyCompletedIdx: index("agent_runs_company_completed_idx").on(
      table.companyId,
      table.completedAt,
    ),
    // Per-agent breakdown within a workspace.
    companyAgentCompletedIdx: index("agent_runs_company_agent_completed_idx").on(
      table.companyId,
      table.agentId,
      table.completedAt,
    ),
    // Ensure one agent-run per heartbeat run (belt-and-suspenders with .unique() above).
    heartbeatRunUniqueIdx: uniqueIndex("agent_runs_heartbeat_run_unique_idx").on(
      table.heartbeatRunId,
    ),
  }),
);
