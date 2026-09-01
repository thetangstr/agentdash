import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: a human's local machine, enrolled to do work for AgentDash agents.
 *
 * The owner's requirement was "a human's local claude can handle a request from
 * agentdash agents", and that settles the shape: the local side is a WORKER THAT
 * PULLS. The server never dials out to a laptop — no inbound port, no firewall
 * hole, nothing listening on someone's machine. The endpoint long-polls for work
 * it has been assigned.
 *
 * **The honest limit, stated here because it is inherent and unfixable by code:**
 * the owner ceiling constrains what may be ASKED of an endpoint, not what the
 * endpoint COULD do. A local Claude has its host machine's full reach — its
 * files, its shells, its logged-in sessions. Nothing on this server can bound
 * that. This is exactly why HubSpot was built native instead of over the bridge:
 * there the ceiling is a real gate at `resolveActingAs`. The controls that
 * actually bind here are enrollment (a machine cannot claim to be someone's
 * endpoint by asserting it), task scoping, approval-gating of act-class tasks,
 * and audit.
 *
 * `user_id` mirrors `company_memberships.principal_id` (durable text principal)
 * for the same reason as `agent_stewardships` and `human_channel_bindings`: the
 * principal must survive an account row being deleted.
 */
export const bridgeEndpoints = pgTable(
  "bridge_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    /** Human-chosen name, e.g. "work laptop". Shown wherever the endpoint acts. */
    label: text("label").notNull(),
    /** SHA-256 of the bearer token. The plaintext is returned exactly once. */
    tokenHash: text("token_hash").notNull(),
    /**
     * What this endpoint declared it can do, validated at enrollment.
     * Namespaced (`bridge:read`, `bridge:act`) so the vocabulary can join the
     * ceiling's `providers`/`dataScopes` dimensions later without a new column.
     */
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("bridge_endpoints_token_hash_uq").on(table.tokenHash),
    // One live endpoint per label per person. Re-enrolling the same machine must
    // replace rather than accumulate, or "revoke my laptop" leaves a second
    // credential for the same laptop still answering.
    activeLabelUq: uniqueIndex("bridge_endpoints_active_label_uq")
      .on(table.companyId, table.userId, table.label)
      .where(sql`${table.revokedAt} is null`),
    companyIdx: index("bridge_endpoints_company_idx").on(table.companyId, table.userId),
  }),
);
