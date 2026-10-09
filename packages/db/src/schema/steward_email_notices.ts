import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: one row per thing that started waiting on a person — an agent's
 * question addressed to them, or an approval opened for an agent they answer
 * for — and what became of the email about it.
 *
 * This is the durable half of the inbox email. Detection writes `pending`
 * rows; the sender folds every pending row for a person into one email at
 * most once per window, and the window is read from `settled_at` of their
 * last `sent` (or `uncertain`) row, so a restart neither re-sends nor forgets
 * anything. Rows are claimed (`sending`) before the send, so two sweeps or two
 * processes never mail the same rows.
 *
 * The row stores the pointer's KEY, never its text: what the email says is
 * rebuilt at send time, and only the pointer (agent name, issue identifier,
 * link) ever leaves the server.
 */
export const stewardEmailNotices = pgTable(
  "steward_email_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** `question:<interactionId>` or `approval:<approvalId>:rev<n>`. */
    refKey: text("ref_key").notNull(),
    /** `question` | `approval`. */
    kind: text("kind").notNull(),
    refId: uuid("ref_id").notNull(),
    /**
     * `pending` → `sending` (claimed by one sweep) → `sent`, or back to
     * `pending` with a backoff after a definite failure, or `failed` after the
     * attempt cap, or `uncertain` when the send's outcome is unknown (never
     * resent: at most once). Settled without an email: `baseline`, `stale`,
     * `opted_out`, `undeliverable`.
     */
    status: text("status").notNull().default("pending"),
    /** When a sweep claimed it for sending. A `sending` row past its lease is settled `uncertain`. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Definite send failures so far. */
    attempts: integer("attempts").notNull().default(0),
    /** Not before this, after a failure. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    refUq: uniqueIndex("steward_email_notices_ref_uq").on(table.companyId, table.userId, table.refKey),
    userStatusIdx: index("steward_email_notices_user_status_idx").on(table.userId, table.status),
  }),
);
