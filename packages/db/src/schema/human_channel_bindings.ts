import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * AgentDash-MK: pairs a verified provider identity with an AgentDash human.
 *
 * Kept separate from `connections` on purpose: one company bot/app credential
 * serves many human conversations, so credential lifecycle and human identity
 * pairing are different concerns with different revocation semantics.
 *
 * `user_id` mirrors `company_memberships.principal_id` (durable text principal)
 * for the same reason as `agent_stewardships`.
 */
export const humanChannelBindings = pgTable(
  "human_channel_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    /** The agent this human stewarded at binding time. */
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    provider: text("provider").notNull(),
    externalTenantId: text("external_tenant_id"),
    externalUserId: text("external_user_id").notNull(),
    externalConversationId: text("external_conversation_id"),
    /** Provider-specific routing detail (thread/topic), never secrets. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /**
     * Last inbound message from this human.
     *
     * WhatsApp only permits free-form messages inside a 24-hour window that
     * opens on the user's last inbound message; outside it, a business may send
     * only pre-approved templates. Delivery has to know which side of that line
     * it is on, and the answer changes per binding by the minute — a real
     * column rather than a metadata key, because it is read on every send.
     */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One provider identity may map to at most one active human per company,
    // and each human holds at most one active binding per provider. Rebinding
    // therefore requires an explicit revocation, never a silent takeover.
    activeExternalIdentityUq: uniqueIndex("human_channel_bindings_active_external_uq")
      .on(table.companyId, table.provider, table.externalUserId)
      .where(sql`${table.revokedAt} is null`),
    /**
     * GLOBAL: one external identity binds to at most one company at a time.
     *
     * Stronger than the per-company index above, and it exists because
     * `resolveActiveBinding` cannot be company-scoped: an inbound webhook has
     * no companyId to pass, it resolves the company FROM the binding. The code
     * therefore assumes this uniqueness, and before this index nothing enforced
     * it — the same Telegram account could be bound in several companies and
     * the lookup returned whichever row Postgres happened to hand back.
     *
     * The per-company index is now redundant and is deliberately kept: dropping
     * it would make this migration destructive, and every migration on this
     * branch is additive. It costs one index maintenance per write.
     */
    activeExternalIdentityGlobalUq: uniqueIndex("human_channel_bindings_active_external_global_uq")
      .on(table.provider, table.externalUserId)
      .where(sql`${table.revokedAt} is null`),
    activeUserUq: uniqueIndex("human_channel_bindings_active_user_uq")
      .on(table.companyId, table.provider, table.userId)
      .where(sql`${table.revokedAt} is null`),
    providerLookupIdx: index("human_channel_bindings_provider_lookup_idx").on(
      table.provider,
      table.externalUserId,
    ),
  }),
);
