import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { routineRuns } from "./routines.js";

/**
 * AgentDash: Agent Performance Management gate 3 — which scheduled occurrence
 * a routine run was dispatched for (evaluation LLD §7).
 *
 * Owed work is generated from versioned trigger definitions, so a period in
 * which nothing ran still counts. To match an occurrence `(triggerId,
 * scheduledFor)` to the run that served it, schedule dispatch records the fire
 * time it claimed here; today's run receipts don't identify the occurrence.
 * One row per dispatched schedule run (catch-up runs each get their own fire
 * time). Webhook/API runs are their own occurrence and get no row.
 *
 * A side table beside upstream `routine_runs` rather than a new column on it
 * (A5). Rows cascade with the company and the run, so existing purge paths
 * need no change. `trigger_id` has no foreign key, like the ledger's subject
 * hints: the occurrence's identity must survive the trigger being deleted
 * (`routine_runs.trigger_id` is set null then).
 */
export const routineRunOccurrences = pgTable(
  "routine_run_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineRunId: uuid("routine_run_id").notNull().references(() => routineRuns.id, { onDelete: "cascade" }),
    triggerId: uuid("trigger_id").notNull(),
    /** The fire time the dispatch claimed (the trigger's `next_run_at` it consumed, or the catch-up cursor). */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineRunUq: uniqueIndex("routine_run_occurrences_routine_run_uq").on(table.routineRunId),
    companyTriggerScheduledIdx: index("routine_run_occurrences_company_trigger_scheduled_idx").on(
      table.companyId,
      table.triggerId,
      table.scheduledFor,
    ),
  }),
);
