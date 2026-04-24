import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyConnectors = pgTable(
  "company_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("disconnected"),
    credentialMode: text("credential_mode")
      .notNull()
      .default("service_account"),
    encryptedTokens: jsonb("encrypted_tokens").$type<Record<string, unknown>>(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default([]),
    connectedBy: uuid("connected_by"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_connectors_company_idx").on(table.companyId),
    companyProviderUq: uniqueIndex("company_connectors_unique_idx").on(
      table.companyId,
      table.provider,
    ),
  }),
);
