import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const policyEvaluations = pgTable(
  "policy_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    action: text("action").notNull(),
    resource: text("resource"),
    matchedPolicyIds: jsonb("matched_policy_ids").notNull().$type<string[]>().default([]),
    decision: text("decision").notNull(),
    denialReason: text("denial_reason"),
    context: jsonb("context").$type<Record<string, unknown>>(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("policy_evaluations_company_time_idx").on(table.companyId, table.evaluatedAt),
    index("policy_evaluations_company_agent_idx").on(table.companyId, table.agentId, table.evaluatedAt),
    index("policy_evaluations_company_decision_idx").on(table.companyId, table.decision),
  ],
);
