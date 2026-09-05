import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash: Company Evaluator — the append-only evaluation ledger.
 *
 * One row per fact the evaluator learned about the company, ingested from the
 * control plane's own records (T0), verified external sources (T1) or agents'
 * structured self-reports (T2). Rows are never updated or deleted: migration
 * 0127 installs a trigger that refuses UPDATE and DELETE unless the session
 * has set `agentdash.ledger_purge = 'on'`, which only the company-deletion
 * path does. Corrections are new rows that reference the disputed one.
 *
 * Spec: docs/superpowers/specs/2026-09-05-company-evaluator-design.md §8, §11.
 */
export const evaluationEvents = pgTable(
  "evaluation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Scope hints for milestone membership; no foreign keys so the ledger outlives its subjects. */
    projectId: uuid("project_id"),
    goalId: uuid("goal_id"),
    /** `agent` | `user` | `system` | `plugin` | `evaluator` */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    /** Where the fact came from: the source table and row, and the per-table version that makes one transition one event. */
    sourceTable: text("source_table").notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: text("source_version").notNull(),
    /** sha256 of the canonical source row at ingest, for in-window mutation detection (rule 13). */
    sourceRowHash: text("source_row_hash"),
    /** `issue.transition`, `run.finished`, `verdict.recorded`, `handoff.pm_to_builder`, … see EVALUATION_EVENT_TYPES. */
    eventType: text("event_type").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    /** When the fact happened (clamped for self-reports) versus when the evaluator learned it. */
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    ingestTime: timestamp("ingest_time", { withTimezone: true }).notNull().defaultNow(),
    /** `(companyId, sourceTable, sourceId, eventType, sourceVersion)` joined — unique, so re-ingest is a no-op. */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Links two sources reporting one fact so it is counted once. */
    correlationId: text("correlation_id"),
  },
  (table) => ({
    dedupeUq: uniqueIndex("evaluation_events_dedupe_uq").on(table.dedupeKey),
    companyTimeIdx: index("evaluation_events_company_time_idx").on(table.companyId, table.eventTime),
    companyTypeIdx: index("evaluation_events_company_type_idx").on(table.companyId, table.eventType),
    companyProjectIdx: index("evaluation_events_company_project_idx").on(table.companyId, table.projectId),
    sourceIdx: index("evaluation_events_source_idx").on(table.companyId, table.sourceTable, table.sourceId),
  }),
);
