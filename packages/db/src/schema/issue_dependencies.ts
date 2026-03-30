import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    blockedByIssueId: uuid("blocked_by_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    dependencyType: text("dependency_type").notNull().default("blocks"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("issue_dependencies_unique_edge").on(table.issueId, table.blockedByIssueId),
    index("issue_dependencies_company_issue_idx").on(table.companyId, table.issueId),
    index("issue_dependencies_company_blocker_idx").on(table.companyId, table.blockedByIssueId),
  ],
);
