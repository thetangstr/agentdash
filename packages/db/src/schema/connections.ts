// AgentDash: Connectors (AGE-106)
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * OAuth2 connections: each row represents a single authenticated connection
 * between an owner (user or agent) and an external provider.
 *
 * Tokens are stored encrypted via the existing `local_encrypted` secrets
 * provider — the `encryptedToken` JSONB column holds the cipher material,
 * never the plaintext token.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** "user" or "agent" — who created this connection. */
    ownerType: text("owner_type").notNull(),
    /** The user ID or agent ID that owns this connection. */
    ownerId: text("owner_id").notNull(),
    /** OAuth provider key, e.g. "google", "slack", "github". */
    provider: text("provider").notNull(),
    /** Granted OAuth scopes. */
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    /** How outbound messages/actions are attributed: "service" or "delegated". */
    sendIdentity: text("send_identity").notNull().default("service"),
    /** Per-action-class autonomy levels: { read, draft, send }. */
    autonomy: jsonb("autonomy")
      .$type<{ read: string; draft: string; send: string }>()
      .notNull()
      .default({ read: "full", draft: "full", send: "draft_only" }),
    /** Who can use this connection: "private" (owner only) or "workspace". */
    visibility: text("visibility").notNull().default("private"),
    /** Connection lifecycle: active, expired, revoked, error. */
    status: text("status").notNull().default("active"),
    /** Display label for the connected account (e.g. email address). */
    accountLabel: text("account_label"),
    /**
     * Encrypted OAuth token material (access_token, refresh_token, expiry).
     * Encrypted using the same local_encrypted_v1 scheme as company secrets.
     * NEVER store plaintext tokens.
     */
    encryptedToken: jsonb("encrypted_token").$type<Record<string, unknown>>(),
    /** PKCE code_verifier for pending authorization flows. */
    oauthState: jsonb("oauth_state").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("connections_company_idx").on(table.companyId),
    companyProviderIdx: index("connections_company_provider_idx").on(table.companyId, table.provider),
    ownerIdx: index("connections_owner_idx").on(table.companyId, table.ownerType, table.ownerId),
    statusIdx: index("connections_status_idx").on(table.companyId, table.status),
  }),
);

/**
 * Workspace-level connector defaults: sendIdentity and autonomy fallbacks.
 * One row per company. Created lazily on first access.
 */
export const connectorWorkspaceDefaults = pgTable(
  "connector_workspace_defaults",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Default send identity for the workspace. */
    sendIdentity: text("send_identity").notNull().default("service"),
    /** Default autonomy levels for the workspace. */
    autonomy: jsonb("autonomy")
      .$type<{ read: string; draft: string; send: string }>()
      .notNull()
      .default({ read: "full", draft: "full", send: "draft_only" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("connector_workspace_defaults_company_uq").on(table.companyId),
  }),
);

/**
 * Per-agent connector overrides: optional sendIdentity and autonomy
 * overrides that take precedence over connection-level and workspace defaults.
 * One row per agent.
 */
export const agentConnectorOverrides = pgTable(
  "agent_connector_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    /** Override send identity (null = use connection or workspace default). */
    sendIdentity: text("send_identity"),
    /** Override autonomy (partial — only specified keys override). */
    autonomy: jsonb("autonomy").$type<Partial<{ read: string; draft: string; send: string }>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUq: uniqueIndex("agent_connector_overrides_agent_uq").on(table.companyId, table.agentId),
  }),
);
