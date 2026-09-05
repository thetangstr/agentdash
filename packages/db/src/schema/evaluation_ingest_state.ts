import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash: Company Evaluator — per-source high-water marks for the ingest
 * loop, so each tick reads only rows it has not seen (spec §11). Internal to
 * ingest; never an evidence source itself.
 */
export const evaluationIngestState = pgTable(
  "evaluation_ingest_state",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Source name, e.g. `activity_log`, `heartbeat_runs`, `issue_comments`. */
    source: text("source").notNull(),
    /** Source-specific cursor, e.g. `{ createdAt, id }` or `{ updatedAt }`. */
    cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.source] }),
  }),
);
