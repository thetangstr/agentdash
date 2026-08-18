import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The local error sink — where captureServerError writes instead of a remote
 * service (decided 2026-08-16: nothing egresses from a client box; alerts
 * carry a summary, this table carries the substance).
 *
 * One row per fingerprint, counted, not one row per occurrence: an error loop
 * overnight must not fill the disk with copies of itself. `lastContext` keeps
 * only the most recent occurrence's request shape — history beyond that is
 * what the count and timestamps are for.
 */
export const serverErrors = pgTable(
  "server_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** hash(name + message template + top stack frame), ids stripped. */
    fingerprint: text("fingerprint").notNull().unique(),
    name: text("name").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    /** method/url/status of the LAST occurrence. Request bodies excluded. */
    lastContext: jsonb("last_context").$type<Record<string, unknown>>(),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lastSeenIdx: index("server_errors_last_seen_idx").on(table.lastSeen),
  }),
);
