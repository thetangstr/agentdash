import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * AgentDash: a person's own notification choices. No row means every default,
 * so adding a preference never needs a backfill.
 */
export const userNotificationPreferences = pgTable(
  "user_notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** Email me when my agents ask me something or need a decision. Default on. */
    inboxEmail: boolean("inbox_email").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_notification_preferences_user_uq").on(table.userId),
  }),
);
