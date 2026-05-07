// AgentDash: goals-eval-hitl
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Active reviewer-agent assignments for a company. Queue items themselves are
 * derived (issues.status='in_review' left-join verdicts on closing outcomes);
 * only the assignment row persists here.
 */
export const cosReviewerAssignments = pgTable(
  "cos_reviewer_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
    queuePartition: text("queue_partition"),
    hiredAt: timestamp("hired_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    queueDepthAtSpawn: integer("queue_depth_at_spawn"),
  },
  (table) => ({
    activeIdx: index("cos_reviewer_assignments_active_idx")
      .on(table.companyId)
      .where(sql`${table.retiredAt} is null`),
    historyIdx: index("cos_reviewer_assignments_history_idx").on(
      table.companyId,
      table.hiredAt,
    ),
  }),
);
