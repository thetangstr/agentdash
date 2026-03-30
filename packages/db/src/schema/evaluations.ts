import { pgTable, uuid, text, timestamp, integer, jsonb, doublePrecision, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { experiments } from "./experiments.js";
import { researchCycles } from "./research_cycles.js";
import { hypotheses } from "./hypotheses.js";
import { agents } from "./agents.js";

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    experimentId: uuid("experiment_id").notNull().references(() => experiments.id),
    cycleId: uuid("cycle_id").notNull().references(() => researchCycles.id),
    hypothesisId: uuid("hypothesis_id").notNull().references(() => hypotheses.id),
    verdict: text("verdict").notNull(),
    summary: text("summary").notNull(),
    analysis: jsonb("analysis").notNull().$type<Array<{ metricKey: string; baseline: number; final: number; delta: number; deltaPct: number; significant: boolean }>>(),
    confidenceLevel: doublePrecision("confidence_level"),
    costTotalCents: integer("cost_total_cents"),
    nextAction: text("next_action").notNull(),
    nextActionDetail: jsonb("next_action_detail").$type<Record<string, unknown>>(),
    evaluatedByAgentId: uuid("evaluated_by_agent_id").references(() => agents.id),
    evaluatedByUserId: text("evaluated_by_user_id"),
    approvedByUserId: text("approved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("evaluations_experiment_unique").on(table.experimentId),
    index("evaluations_cycle_idx").on(table.cycleId),
  ],
);
