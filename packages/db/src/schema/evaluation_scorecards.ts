import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash: Company Evaluator — stored projections (decision D6).
 *
 * One row per version of a milestone card. The card is a pure function of the
 * ordered ledger up to `throughEventId`; `replay` must reproduce `card` and
 * `cardHash` byte-for-byte. Rendering is a UI concern and is not stored.
 */
export const evaluationScorecards = pgTable(
  "evaluation_scorecards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** `project` | `goal` (decision D3) */
    milestoneKind: text("milestone_kind").notNull(),
    milestoneId: uuid("milestone_id").notNull(),
    version: integer("version").notNull(),
    contractVersion: text("contract_version").notNull(),
    formulaVersion: text("formula_version").notNull(),
    throughEventId: uuid("through_event_id"),
    card: jsonb("card").$type<Record<string, unknown>>().notNull(),
    /** sha256 of the canonical card JSON — what replay agreement is measured against. */
    cardHash: text("card_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionUq: uniqueIndex("evaluation_scorecards_version_uq").on(
      table.companyId,
      table.milestoneKind,
      table.milestoneId,
      table.version,
    ),
  }),
);
