import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { bridgeEndpoints } from "./bridge_endpoints.js";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";
import { humanChannelBindings } from "./human_channel_bindings.js";

/**
 * AgentDash-MK: short-lived opaque tokens carried in provider callback data.
 *
 * Telegram caps `callback_data` at 64 bytes, and a signed payload carrying an
 * approval uuid plus revision plus decision does not fit. More importantly the
 * button must not BE the authority — anything embedded in it is replayable and
 * inspectable by the client. So the button carries only a random handle and
 * every scrap of authority is resolved server-side from this row.
 */
export const channelCallbackTokens = pgTable(
  "channel_callback_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The opaque handle placed in callback_data. */
    token: text("token").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    bindingId: uuid("binding_id").references(() => humanChannelBindings.id),
    /**
     * Set for a steward-inbox token instead of `bindingId`: the inbox is
     * delivered to an enrolled machine, not to a chat channel. Bound so a
     * token that leaks to another of the person's endpoints is inert there,
     * rather than merely being re-checked for authority at redemption.
     */
    bridgeEndpointId: uuid("bridge_endpoint_id").references(() => bridgeEndpoints.id, {
      onDelete: "cascade",
    }),
    /** Revision the card was rendered against; a later revision is stale. */
    approvalRevision: integer("approval_revision").notNull(),
    decision: text("decision").notNull(),
    provider: text("provider").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUq: uniqueIndex("channel_callback_tokens_token_uq").on(table.token),
    approvalIdx: index("channel_callback_tokens_approval_idx").on(table.approvalId),
  }),
);
