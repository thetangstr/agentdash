import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bridgeEndpoints } from "./bridge_endpoints.js";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: a proposed action, read back to a person, waiting to be confirmed.
 *
 * Deciding an approval from the inbox is authorised by a handle that is minted
 * for one approval at one revision and spent once. Directing work needs the
 * same shape for the same reason: the endpoint credential must not become a
 * general write credential, or connecting a laptop would be equivalent to
 * handing out company authority.
 *
 * `channel_callback_tokens` could not be reused -- its `approval_id` is NOT
 * NULL, and a work assignment has no approval behind it.
 *
 * The row exists between "here is what I understood" and "yes, do it". It
 * stores the RESOLVED action, not the sentence the person typed: names are
 * resolved to agent ids before the handle is minted, so what is confirmed is
 * exactly what was read back and never a re-interpretation of free text.
 */
export const stewardInboxActionHandles = pgTable(
  "steward_inbox_action_handles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The opaque handle. Never logged, never accepted from a command line. */
    token: text("token").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Bound to the machine it was delivered to, as decision handles are. */
    bridgeEndpointId: uuid("bridge_endpoint_id")
      .notNull()
      .references(() => bridgeEndpoints.id, { onDelete: "cascade" }),
    /**
     * The person it was minted for. Authority is re-checked against this at
     * redemption, so a handle is proof of delivery and never of permission.
     */
    actorUserId: text("actor_user_id").notNull(),
    /** `assign_work` | `set_cadence`. */
    kind: text("kind").notNull(),
    /** The resolved action, exactly as it was read back. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUq: uniqueIndex("steward_inbox_action_handles_token_uq").on(table.token),
    endpointIdx: index("steward_inbox_action_handles_endpoint_idx").on(table.bridgeEndpointId),
  }),
);
