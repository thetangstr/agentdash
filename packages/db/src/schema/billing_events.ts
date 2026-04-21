// AgentDash: billing_events table
// Audit log for every Stripe webhook event processed. Used for idempotency
// (skip duplicates by stripeEventId) and for debugging billing flows.

import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    stripeEventId: text("stripe_event_id").notNull(),
    stripeEventType: text("stripe_event_type").notNull(),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
    error: text("error"),
  },
  (t) => [
    index("billing_events_company_idx").on(t.companyId),
    // Unique on stripe_event_id so the INSERT itself is the idempotency gate.
    // Stripe can deliver the same event concurrently; a SELECT-then-INSERT
    // pattern would race. ON CONFLICT DO NOTHING + .returning() lets the
    // handler distinguish "first time" from "duplicate" atomically.
    uniqueIndex("billing_events_stripe_event_idx").on(t.stripeEventId),
  ],
);
