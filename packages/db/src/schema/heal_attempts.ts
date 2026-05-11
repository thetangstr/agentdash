import { pgTable, uuid, text, timestamp, jsonb, real, boolean, index } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Tracks individual healing attempts made by the run-healer service.
 * Each row represents one LLM diagnosis + fix attempt on a run.
 */
export const healAttempts = pgTable(
  "heal_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    /** LLM diagnosis response as JSON */
    diagnosis: jsonb("diagnosis").notNull(),
    /** One of: retry | adapter_switch | config_update | manual_required */
    fixType: text("fix_type").notNull(),
    /** What action was actually taken (may differ from suggested if bounded) */
    actionTaken: text("action_taken"),
    /** Whether the fix resolved the issue (null = unknown/not yet determined) */
    succeeded: boolean("succeeded"),
    /** LLM API cost in USD for this diagnosis */
    costUsd: real("cost_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("heal_attempts_run_id_idx").on(table.runId),
    index("heal_attempts_created_at_idx").on(table.createdAt),
  ],
);

/** Audit log for all healer events (scans, diagnoses, fixes, skips). */
export const healEvents = pgTable(
  "heal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Event type: scan | diagnose | fix_applied | fix_failed | skipped */
    eventType: text("event_type").notNull(),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /** Arbitrary JSON details specific to the event type */
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("heal_events_event_type_idx").on(table.eventType),
    index("heal_events_created_at_idx").on(table.createdAt),
  ],
);

export type HealAttempt = typeof healAttempts.$inferSelect;
export type HealEvent = typeof healEvents.$inferSelect;
