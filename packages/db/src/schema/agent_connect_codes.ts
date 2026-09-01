import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { agentApiKeys } from "./agent_api_keys.js";
import { companies } from "./companies.js";

/**
 * A short, single-use code that a person types once to pair their own machine
 * with an agent.
 *
 * The thing this replaces is handing someone a raw `pcp_<48hex>` agent key.
 * That key is long-lived, unnamed, shown once, and identical on every device it
 * lands on — so it gets pasted into chat windows, it cannot be revoked for one
 * laptop without breaking the rest, and nobody can answer "which machines have
 * this?". A connect code is the opposite on every axis: it expires in minutes,
 * dies on first use, and what it hands back is a key named for the device that
 * redeemed it.
 *
 * The code is never stored. Only its hash is, exactly as with invite tokens —
 * a leaked database backup must not hand out live pairings.
 */
export const agentConnectCodes = pgTable(
  "agent_connect_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** sha256 of the normalized code. The code itself is never persisted. */
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    /** What the redeeming machine called itself, for the device list later. */
    redeemedDeviceName: text("redeemed_device_name"),
    /**
     * The key this code produced. Kept so revoking a device can be traced back
     * to the pairing that created it, and so a redeemed code can never be made
     * to mint a second key.
     */
    issuedApiKeyId: uuid("issued_api_key_id").references(() => agentApiKeys.id),
    createdByUserId: text("created_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique so a hash collision surfaces as a constraint violation to retry,
    // rather than two live codes silently sharing one row.
    codeHashUniqueIdx: uniqueIndex("agent_connect_codes_code_hash_unique_idx").on(table.codeHash),
    agentStateIdx: index("agent_connect_codes_agent_state_idx").on(
      table.companyId,
      table.agentId,
      table.redeemedAt,
      table.expiresAt,
    ),
  }),
);
