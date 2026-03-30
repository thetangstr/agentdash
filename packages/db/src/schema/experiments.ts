import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { researchCycles } from "./research_cycles.js";
import { hypotheses } from "./hypotheses.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { budgetPolicies } from "./budget_policies.js";
import { approvals } from "./approvals.js";
import { agents } from "./agents.js";

export const experiments = pgTable(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    cycleId: uuid("cycle_id").notNull().references(() => researchCycles.id, { onDelete: "cascade" }),
    hypothesisId: uuid("hypothesis_id").notNull().references(() => hypotheses.id),
    projectId: uuid("project_id").references(() => projects.id),
    issueId: uuid("issue_id").references(() => issues.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("design"),
    successCriteria: jsonb("success_criteria").notNull().$type<Array<{ metricKey: string; comparator: string; targetValue: number; baselineValue?: number }>>(),
    budgetCapCents: integer("budget_cap_cents"),
    budgetPolicyId: uuid("budget_policy_id").references(() => budgetPolicies.id),
    timeLimitHours: integer("time_limit_hours"),
    rollbackTrigger: jsonb("rollback_trigger").$type<Array<{ metricKey: string; comparator: string; threshold: number }>>(),
    approvalId: uuid("approval_id").references(() => approvals.id),
    startedAt: timestamp("started_at", { withTimezone: true }),
    measuringAt: timestamp("measuring_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    abortedAt: timestamp("aborted_at", { withTimezone: true }),
    abortReason: text("abort_reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiments_company_cycle_idx").on(table.companyId, table.cycleId, table.status),
    index("experiments_hypothesis_idx").on(table.hypothesisId),
    index("experiments_status_idx").on(table.companyId, table.status),
  ],
);
