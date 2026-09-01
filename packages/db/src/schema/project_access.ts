import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";

/**
 * A5 (2026-08-16): the access list for a RESTRICTED project.
 *
 * Empty for projects with visibility 'company' — the open-by-default model
 * means most projects never have a row here. A restricted project is visible
 * to admins, its creator, and the principals listed; the lead agent is added
 * automatically when a project is restricted so the agent doing the work
 * does not lose sight of it.
 */
export const projectAccess = pgTable(
  "project_access",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(), // 'user' | 'agent'
    principalId: text("principal_id").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.principalType, table.principalId] }),
  }),
);
