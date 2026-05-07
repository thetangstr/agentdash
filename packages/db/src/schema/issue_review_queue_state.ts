// AgentDash: goals-eval-hitl
import { sql } from "drizzle-orm";
import { pgTable, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

/**
 * Sibling-of-issues queue state. Rows upserted on Issue→in_review transition,
 * deleted on closing verdict. Keeps `issues.updatedAt` semantically clean while
 * letting the SLA timer + queue-depth analytics derive from first-class data.
 */
export const issueReviewQueueState = pgTable(
  "issue_review_queue_state",
  {
    issueId: uuid("issue_id")
      .primaryKey()
      .references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    escalateAfter: timestamp("escalate_after", { withTimezone: true }),
    assignedReviewerAgentId: uuid("assigned_reviewer_agent_id").references(() => agents.id),
  },
  (table) => ({
    enqueuedIdx: index("issue_review_queue_state_enqueued_idx").on(
      table.companyId,
      table.enqueuedAt,
    ),
    escalateIdx: index("issue_review_queue_state_escalate_idx")
      .on(table.companyId, table.escalateAfter)
      .where(sql`${table.escalateAfter} is not null`),
  }),
);
