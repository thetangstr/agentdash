import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { IssueResponsibilityMappedBy } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { agentProfileRevisions } from "./agent_profiles.js";

/**
 * AgentDash: Agent Performance Management gate 2 — which responsibility an
 * issue's work counts toward (doc/plans/2026-10-29-agent-evaluation-lld.md §5.2).
 *
 * An append-only history of intervals: a transfer closes the current row
 * (`valid_to`) and opens a new one, so obligation credit can be attributed to
 * whoever owned the responsibility at the time. `valid_to IS NULL` is the
 * current mapping; gate 2 allows one current mapping per issue, and the
 * partial unique index makes concurrent remaps serialize rather than fork.
 *
 * A side table, not a column on `issues` (A5). Rows cascade with the company,
 * the issue and the agent so the existing purge paths need no change.
 */
export const issueResponsibilities = pgTable(
  "issue_responsibilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    responsibilityKey: text("responsibility_key").notNull(),
    /** The active revision that defined the key when it was mapped. */
    profileRevisionId: uuid("profile_revision_id").references(() => agentProfileRevisions.id, { onDelete: "set null" }),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    mappedBy: text("mapped_by").$type<IssueResponsibilityMappedBy>().notNull(),
    /** Agent id or user id; null for system dispatch. */
    mappedByActorId: text("mapped_by_actor_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    currentPerIssueUq: uniqueIndex("issue_responsibilities_current_issue_uq")
      .on(table.issueId)
      .where(sql`${table.validTo} IS NULL`),
    companyIssueFromIdx: index("issue_responsibilities_company_issue_from_idx").on(
      table.companyId,
      table.issueId,
      table.validFrom,
    ),
    companyAgentKeyIdx: index("issue_responsibilities_company_agent_key_idx").on(
      table.companyId,
      table.agentId,
      table.responsibilityKey,
    ),
  }),
);
