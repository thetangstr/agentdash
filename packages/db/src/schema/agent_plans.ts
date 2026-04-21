import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

// AgentDash: Goal-driven agent team proposals. An approved plan expands into
// agents + playbooks + routines + key results + budget policies in one txn.
export const agentPlans = pgTable(
  "agent_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").notNull().references(() => goals.id),
    status: text("status").notNull().default("proposed"),
    archetype: text("archetype").notNull(),
    rationale: text("rationale"),
    proposalPayload: jsonb("proposal_payload").$type<Record<string, unknown>>().notNull(),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id),
    proposedByUserId: text("proposed_by_user_id"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_plans_company_idx").on(table.companyId),
    index("agent_plans_goal_idx").on(table.goalId),
    index("agent_plans_company_status_idx").on(table.companyId, table.status),
  ],
);
