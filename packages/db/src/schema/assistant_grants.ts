import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash assistant MCP (GH #677): OAuth 2.1 for the person-facing assistant
 * surface at `POST /api/mcp/assistant`.
 *
 * The authorization model, in one line: a grant binds (user, client, company)
 * to a scope set, and every token the AS mints hangs off one grant. Revoking
 * the grant revokes the tokens; nothing in the token tables is reachable
 * without a live grant behind it.
 *
 * `user_id` mirrors `company_memberships.principal_id` (durable text principal)
 * for the same reason as `bridge_endpoints` — the principal must survive an
 * account row being deleted.
 */
export const assistantGrants = pgTable(
  "assistant_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    /** OAuth client_id — a `dcr_…` registration id or a CIMD https URL. */
    clientId: text("client_id").notNull(),
    /** Display name shown on the consent card and the Connections list. */
    clientName: text("client_name").notNull(),
    /** Host of the redirect URI approved at consent — what the person checked. */
    redirectHost: text("redirect_host").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastWhatsNewAt: timestamp("last_whats_new_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One live grant per (person, client, company). A second consent for the
    // same triple updates this grant's scopes (that is the step-up path), so
    // the Connections list can never show two rows for one connection.
    liveGrantUq: uniqueIndex("assistant_grants_live_uq")
      .on(table.userId, table.clientId, table.companyId)
      .where(sql`${table.revokedAt} is null`),
    companyIdx: index("assistant_grants_company_idx").on(table.companyId, table.userId),
  }),
);

/**
 * Registered OAuth clients. `client_id` is the public identifier a client
 * presents: `dcr_<random>` for dynamic registration, or the metadata-document
 * URL itself for CIMD (RFC — client_id IS the document URL).
 *
 * For CIMD rows the fetched document is cached in `metadataJson`; re-fetches
 * refresh it, so a client that rotates its document gets the new copy on the
 * next resolve while every grant still points at the same row.
 */
export const assistantOauthClients = pgTable(
  "assistant_oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id").notNull(),
    registrationType: text("registration_type").notNull(), // "dcr" | "cimd"
    clientName: text("client_name").notNull(),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default([]),
    /** The verbatim registration body / fetched CIMD document. */
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    clientIdUq: uniqueIndex("assistant_oauth_clients_client_id_uq").on(table.clientId),
  }),
);

/**
 * One row per `/oauth/authorize` call. The row IS the consent request — the
 * `request` query param handed to the consent UI is this primary key.
 *
 * Lifecycle: `pending` (awaiting the person) → `approved` (codeHash written,
 * the code went out on the redirect) → `consumed` (code exchanged — a second
 * exchange attempt against a consumed code is replay, not a second token).
 * `denied` and `expired` are terminal with no code.
 */
export const assistantAuthRequests = pgTable(
  "assistant_auth_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientRowId: uuid("client_row_id")
      .notNull()
      .references(() => assistantOauthClients.id),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    /** Space-separated scope list exactly as requested — the consent ceiling. */
    scope: text("scope").notNull(),
    /** RFC 8707 resource the code is bound to. */
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    status: text("status").notNull().default("pending"),
    /** Set at approve time: who consented, to which company, via which grant. */
    userId: text("user_id"),
    companyId: uuid("company_id").references(() => companies.id),
    grantId: uuid("grant_id").references(() => assistantGrants.id),
    /** SHA-256 of the authorization code — the code itself is never stored. */
    codeHash: text("code_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeHashIdx: index("assistant_auth_requests_code_hash_idx").on(table.codeHash),
    statusIdx: index("assistant_auth_requests_status_idx").on(table.status, table.expiresAt),
  }),
);

/**
 * Opaque `pcpa_…` access tokens, SHA-256 hashed at rest. `family_id` links an
 * access token to the refresh lineage that minted it, so refresh-token-reuse
 * family revocation kills the live access tokens too — a replayed refresh
 * cannot leave a working access token behind.
 */
export const assistantAccessTokens = pgTable(
  "assistant_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => assistantGrants.id),
    familyId: uuid("family_id").notNull(),
    /** RFC 8707 audience — the canonical MCP resource URI. */
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("assistant_access_tokens_token_hash_uq").on(table.tokenHash),
    familyIdx: index("assistant_access_tokens_family_idx").on(table.familyId),
    grantIdx: index("assistant_access_tokens_grant_idx").on(table.grantId),
  }),
);

/**
 * Refresh tokens, SHA-256 hashed at rest, rotated on every use. `rotatedAt`
 * marks a token that was legitimately exchanged once; presenting it again is
 * reuse — the family is compromised and every token in it is revoked.
 */
export const assistantRefreshTokens = pgTable(
  "assistant_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => assistantGrants.id),
    familyId: uuid("family_id").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("assistant_refresh_tokens_token_hash_uq").on(table.tokenHash),
    familyIdx: index("assistant_refresh_tokens_family_idx").on(table.familyId),
    grantIdx: index("assistant_refresh_tokens_grant_idx").on(table.grantId),
  }),
);
