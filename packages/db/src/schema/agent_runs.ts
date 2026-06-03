// AgentDash (AGE-119/AGE-120): agent-run metering table. Records each
// discrete agent run for quota tracking. AGE-119 PR #384 adds this table
// and the agentRunService; this file is included here so AGE-120 quota
// computation can land independently. The migration will be deduped when
// both PRs merge.
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    status: text("status").notNull().default("completed"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStartedIdx: index("agent_runs_company_started_idx").on(
      table.companyId,
      table.startedAt,
    ),
    companyAgentIdx: index("agent_runs_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
  }),
);
