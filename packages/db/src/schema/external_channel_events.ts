import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { humanChannelBindings } from "./human_channel_bindings.js";

/**
 * AgentDash-MK: the deduplication and audit boundary for inbound provider
 * events.
 *
 * Deliberately stores a payload DIGEST rather than the payload: this table
 * exists to prove an event was seen exactly once, not to archive message
 * content or the secrets a provider callback may carry.
 */
export const externalChannelEvents = pgTable(
  "external_channel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    provider: text("provider").notNull(),
    /** Provider's own event id — Telegram `update_id`, Teams activity id. */
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type"),
    bindingId: uuid("binding_id").references(() => humanChannelBindings.id),
    /** Approval revision this event was issued against, when applicable. */
    approvalRevision: integer("approval_revision"),
    processingState: text("processing_state").notNull().default("claimed"),
    payloadDigest: text("payload_digest"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Scoped by company so two companies sharing a provider id space cannot
    // suppress each other's events.
    eventUq: uniqueIndex("external_channel_events_provider_company_event_uq").on(
      table.provider,
      table.companyId,
      table.externalEventId,
    ),
    companyCreatedIdx: index("external_channel_events_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
