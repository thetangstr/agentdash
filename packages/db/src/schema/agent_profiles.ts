import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  AgentOperatingProfileV1,
  AgentProfileApplicationStatus,
  AgentProfileApplicationStepRecord,
  AgentProfileApproverAuthority,
  AgentProfileBases,
  AgentProfileProvenanceMap,
  AgentProfileRevisionState,
  AgentProfileSourceRef,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * AgentDash: Agent Performance Management gate 2 — the operating profile
 * (doc/plans/2026-10-29-agent-performance-management-lld.md §3.2).
 *
 * Side tables, not columns on `agents` (A5). A profile is a history of
 * revisions; only `active_revision_id` is in force, and only the serialized
 * application switches it. Drafts, approvals and applications are separate
 * records: saving a draft writes revision rows and nothing else.
 *
 * Foreign keys cascade from the company, the agent and the profile, and set
 * null from approvals and runs, so the existing company and agent purge paths
 * (which delete in a fixed order and know nothing about these tables) never
 * hit a NO ACTION violation.
 */
export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Null = an unbound draft for a role not hired yet. Unique when set. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    activeRevisionId: uuid("active_revision_id").references((): AnyPgColumn => agentProfileRevisions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUq: uniqueIndex("agent_profiles_agent_uq").on(table.agentId),
    companyIdx: index("agent_profiles_company_idx").on(table.companyId),
  }),
);

/**
 * One revision of a profile. Only `draft` rows are edited (with the body hash
 * as `If-Match`); proposing freezes the body and records `bases`. Revision 0
 * (derived from today's records) is computed on read and never stored.
 */
export const agentProfileRevisions = pgTable(
  "agent_profile_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull().references(() => agentProfiles.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    basedOnRevisionId: uuid("based_on_revision_id").references((): AnyPgColumn => agentProfileRevisions.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<AgentProfileRevisionState>().notNull().default("draft"),
    body: jsonb("body").$type<AgentOperatingProfileV1>().notNull(),
    bodyHash: text("body_hash").notNull(),
    provenance: jsonb("provenance").$type<AgentProfileProvenanceMap>().notNull().default({}),
    sourceRefs: jsonb("source_refs").$type<AgentProfileSourceRef[]>().notNull().default([]),
    /** Null until proposed. */
    bases: jsonb("bases").$type<AgentProfileBases>(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    profileRevisionUq: uniqueIndex("agent_profile_revisions_profile_revision_uq").on(
      table.profileId,
      table.revisionNumber,
    ),
    companyProfileStateIdx: index("agent_profile_revisions_company_profile_state_idx").on(
      table.companyId,
      table.profileId,
      table.state,
    ),
    approvalIdx: index("agent_profile_revisions_approval_idx").on(table.approvalId),
  }),
);

/**
 * The application receipt (overview LLD §4.2). One per approval. Steps are
 * idempotent by `(application id, step)` and recorded in `steps`; a failure
 * leaves `failed` without switching the active revision, and resume continues
 * from the first incomplete step. At most one application per agent is
 * `in_progress` at a time (the advisory lock serializes; the index backs it).
 */
export const agentProfileApplications = pgTable(
  "agent_profile_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id").notNull().references(() => agentProfileRevisions.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    status: text("status").$type<AgentProfileApplicationStatus>().notNull().default("pending"),
    steps: jsonb("steps").$type<AgentProfileApplicationStepRecord[]>().notNull().default([]),
    approverUserId: text("approver_user_id"),
    approverAuthority: jsonb("approver_authority").$type<AgentProfileApproverAuthority>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalUq: uniqueIndex("agent_profile_applications_approval_uq").on(table.approvalId),
    oneInProgressPerAgentUq: uniqueIndex("agent_profile_applications_in_progress_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.status} = 'in_progress'`),
    companyAgentCreatedIdx: index("agent_profile_applications_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    revisionIdx: index("agent_profile_applications_revision_idx").on(table.revisionId),
  }),
);
