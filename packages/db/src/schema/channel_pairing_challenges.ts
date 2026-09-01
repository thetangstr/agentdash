import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { humanChannelBindings } from "./human_channel_bindings.js";

/**
 * AgentDash-MK: short-lived single-use tokens that complete a channel pairing.
 *
 * Provider-generic on purpose. Telegram mints one and carries it in a
 * `t.me/<bot>?start=TOKEN` deep link; WhatsApp and Teams reuse the same table
 * with their own delivery mechanism, so the ceremony has one implementation and
 * one set of expiry and replay rules rather than three that drift.
 *
 * The token is server-generated random material rather than a signed payload,
 * for the same reason `channel_callback_tokens` is: the value travels through a
 * channel the user can read and forward, so it must not BE the authority. It is
 * a handle, and every scrap of authority — which company, which human, whether
 * it is still valid — is resolved from this row.
 *
 * `user_id` mirrors `company_memberships.principal_id` (durable text principal)
 * for the same reason as `agent_stewardships` and `human_channel_bindings`.
 */
export const channelPairingChallenges = pgTable(
  "channel_pairing_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The opaque handle carried in the deep link. */
    token: text("token").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** The binding this challenge produced, once it completes. */
    bindingId: uuid("binding_id").references(() => humanChannelBindings.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUq: uniqueIndex("channel_pairing_challenges_token_uq").on(table.token),
    // One outstanding challenge per human per provider. Minting a second must
    // replace the first rather than leave two live tokens for one identity —
    // otherwise a token the user abandoned stays redeemable by anyone who saw it.
    activeUserUq: uniqueIndex("channel_pairing_challenges_active_user_uq")
      .on(table.companyId, table.provider, table.userId)
      .where(sql`${table.consumedAt} is null`),
    companyIdx: index("channel_pairing_challenges_company_idx").on(table.companyId, table.provider),
  }),
);
