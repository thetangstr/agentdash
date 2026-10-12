import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { assets } from "./assets.js";
import { issueComments } from "./issue_comments.js";

export const issueAttachments = pgTable(
  "issue_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    issueCommentId: uuid("issue_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    /**
     * AgentDash (co-worker slice 5): files sent through the bridge or by an
     * agent are versioned per base name on their issue. The base name is the
     * file's name without its version suffix, lowercased (`q3 figures.csv`);
     * `version` is 1, 2, 3... per (issue, base name). The highest version is
     * the issue's current file for that name. Both are null for a file a
     * person attached on the page, which is not versioned.
     */
    versionBaseName: text("version_base_name"),
    version: integer("version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_attachments_company_issue_idx").on(table.companyId, table.issueId),
    issueCommentIdx: index("issue_attachments_issue_comment_idx").on(table.issueCommentId),
    assetUq: uniqueIndex("issue_attachments_asset_uq").on(table.assetId),
    versionUq: uniqueIndex("issue_attachments_version_uq").on(table.issueId, table.versionBaseName, table.version),
  }),
);
