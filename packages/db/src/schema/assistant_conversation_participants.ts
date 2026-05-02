import { pgTable, uuid, text, varchar, timestamp, index, unique } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { assistantConversations, assistantMessages } from "./assistant_conversations.js";

export const assistantConversationParticipants = pgTable(
  "assistant_conversation_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastReadMessageId: uuid("last_read_message_id").references(() => assistantMessages.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    unique("acp_conversation_user_unique").on(table.conversationId, table.userId),
    index("acp_conversation_idx").on(table.conversationId),
    index("acp_user_idx").on(table.userId),
  ],
);
