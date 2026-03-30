import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";
import { agents } from "./agents.js";

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    semver: text("semver"),
    markdown: text("markdown").notNull(),
    fileInventory: jsonb("file_inventory").notNull().$type<Array<Record<string, unknown>>>().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    changeSummary: text("change_summary"),
    diffFromPrevious: text("diff_from_previous"),
    status: text("status").notNull().default("draft"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_versions_skill_version_unique").on(table.skillId, table.versionNumber),
    index("skill_versions_company_skill_status_idx").on(table.companyId, table.skillId, table.status),
  ],
);
