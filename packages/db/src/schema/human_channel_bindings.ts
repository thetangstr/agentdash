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
    activeUserUq: uniqueIndex("human_channel_bindings_active_user_uq")
      .on(table.companyId, table.provider, table.userId)
      .where(sql`${table.revokedAt} is null`),
    providerLookupIdx: index("human_channel_bindings_provider_lookup_idx").on(
      table.provider,
      table.externalUserId,
    ),
  }),
);
