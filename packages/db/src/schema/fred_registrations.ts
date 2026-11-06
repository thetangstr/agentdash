// AgentDash: protected built-in guide identity; editable agent metadata grants no exemption.
import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { FredBriefContent, FredRegistrationState } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { documentRevisions } from "./document_revisions.js";

export const fredRegistrations = pgTable("fred_registrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  mainIssueId: uuid("main_issue_id").references(() => issues.id, { onDelete: "set null" }),
  ownerUserId: text("owner_user_id").notNull(),
  state: text("state").$type<FredRegistrationState>().notNull().default("materializing"),
  mandateVersion: text("mandate_version").notNull(),
  briefRevision: integer("brief_revision").notNull().default(0),
  brief: jsonb("brief").$type<FredBriefContent>(),
  briefDocumentRevisionId: uuid("brief_document_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("fred_registrations_company_unique").on(table.companyId),
  uniqueIndex("fred_registrations_agent_unique").on(table.agentId),
  uniqueIndex("fred_registrations_issue_unique").on(table.mainIssueId),
  check("fred_registrations_state_check", sql`${table.state} in ('materializing', 'ready', 'repair_needed')`),
  check("fred_registrations_brief_revision_check", sql`${table.briefRevision} >= 0`),
]);
