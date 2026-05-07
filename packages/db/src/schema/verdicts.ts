// AgentDash: goals-eval-hitl
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { goals } from "./goals.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";

/**
 * Polymorphic verdict store across goal/project/issue.
 *
 * Exactly one of (goalId, projectId, issueId) is non-null and matches entityType.
 * Exactly one of (reviewerAgentId, reviewerUserId) is non-null (neutrality enforced
 * at the service layer; CHECK is shape-only).
 *
 * `reviewerUserId` is `text` (NOT uuid) to match `issues.assigneeUserId` shape so
 * neutral-validator equality checks typecheck.
 */
export const verdicts = pgTable(
  "verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    entityType: text("entity_type").notNull(),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id),
    reviewerUserId: text("reviewer_user_id"),
    outcome: text("outcome").notNull(),
    rubricScores: jsonb("rubric_scores").$type<Record<string, unknown>>(),
    justification: text("justification"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("verdicts_company_entity_idx").on(
      table.companyId,
      table.entityType,
      table.goalId,
      table.projectId,
      table.issueId,
    ),
    recencyIdx: index("verdicts_company_created_idx").on(table.companyId, table.createdAt),
    closingIdx: index("verdicts_closing_idx")
      .on(
        table.companyId,
        table.entityType,
        table.goalId,
        table.projectId,
        table.issueId,
      )
      .where(sql`${table.outcome} in ('passed','failed','escalated_to_human')`),
    entityTargetCheck: check(
      "verdicts_entity_target_check",
      sql`(
        (${table.entityType} = 'goal' and ${table.goalId} is not null and ${table.projectId} is null and ${table.issueId} is null)
        or (${table.entityType} = 'project' and ${table.projectId} is not null and ${table.goalId} is null and ${table.issueId} is null)
        or (${table.entityType} = 'issue' and ${table.issueId} is not null and ${table.goalId} is null and ${table.projectId} is null)
      )`,
    ),
    reviewerXorCheck: check(
      "verdicts_reviewer_xor_check",
      sql`(${table.reviewerAgentId} is not null) <> (${table.reviewerUserId} is not null)`,
    ),
  }),
);
