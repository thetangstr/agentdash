import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: a steward's registered webhook — the bot-less push channel.
 *
 * Two stewards independently built pollers because the product had no push;
 * one of them then tried to grant an agent Board access so channel text could
 * decide approvals. This table is the sanctioned shape of the first need and
 * the refusal of the second: the server POSTs the same ask-and-pointer digest
 * the inbox renders — never a payload, never a decision handle — and the
 * message deep-links to the page, which is where deciding stays.
 *
 * The URL is the secret: whoever holds it can post into the destination
 * channel. It is stored readable because delivering requires reading it —
 * the same standing as adapter env secrets — and it grants nothing inside
 * AgentDash: possession of the URL cannot read the inbox or decide anything.
 *
 * `lastDeliveredSeq` is a cursor over `steward_inbox_events.seq`, the same
 * gap-free sequence machine endpoints use, so "no update is lost" is a
 * property of arithmetic here too. It advances only on a delivered (2xx)
 * post: a failed delivery retries on the next sweep with the same window.
 */
export const stewardWebhooks = pgTable(
  "steward_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Same id space as `steward_inbox_events.steward_user_id`. */
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    url: text("url").notNull(),
    /**
     * Set when the registration challenge POST was answered 2xx. An
     * unverified webhook is never delivered to: a URL nobody has proven
     * writable would silently eat a steward's notifications.
     */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastDeliveredSeq: integer("last_delivered_seq").notNull().default(0),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("steward_webhooks_company_user_idx").on(table.companyId, table.userId),
    // One live registration per destination per person; a revoked row frees
    // the URL for a deliberate re-registration.
    uniqueIndex("steward_webhooks_active_url_uq")
      .on(table.companyId, table.userId, table.url)
      .where(sql`${table.revokedAt} is null`),
  ],
);
