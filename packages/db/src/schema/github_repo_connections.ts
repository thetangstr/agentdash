// AgentDash (GH #782): a GitHub repository connected to a project workspace.
//
// The row says WHICH repo a project workspace may reach on GitHub and WHERE
// the credential comes from. It never holds the credential itself:
//
// - credential_source = "pat": a fine-grained personal access token pasted by
//   a company owner/admin, stored as an encrypted company secret (secret_id).
// - credential_source = "github_app" (GH #797, later): a GitHub App
//   installation; a short-lived token is minted per request from
//   github_app_installation_id and nothing is stored here.
//
// Kept out of project_workspaces.metadata on purpose: workspace metadata is
// editable by project members, and the credential lookup must not follow a
// secret reference or repo name that a member can rewrite.
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

export const githubRepoConnections = pgTable(
  "github_repo_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id, { onDelete: "cascade" }),
    /** Lower-cased `owner/name`, the match key for credential requests. */
    repoFullName: text("repo_full_name").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    defaultBranch: text("default_branch"),
    /** "pat" today; "github_app" when GH #797 lands. */
    credentialSource: text("credential_source").notNull().default("pat"),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    githubAppInstallationId: text("github_app_installation_id"),
    /** What GitHub reported at validation time (permission names only, never the token). */
    validation: jsonb("validation").$type<Record<string, unknown>>(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    connectedByUserId: text("connected_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("github_repo_connections_company_idx").on(table.companyId),
    projectIdx: index("github_repo_connections_project_idx").on(table.companyId, table.projectId),
    workspaceUq: uniqueIndex("github_repo_connections_workspace_uq").on(table.projectWorkspaceId),
  }),
);
