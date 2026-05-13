import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Tracks which users have received the one-time "your CoS is waiting"
 * cold-start re-engagement email. One row per user, enforced by the
 * UNIQUE constraint on user_id.
 */
export const reengagementEmails = pgTable("reengagement_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
