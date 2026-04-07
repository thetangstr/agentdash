import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentServiceAccounts = pgTable(
  "agent_service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    provider: text("provider").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    encryptedTokens: jsonb("encrypted_tokens").$type<Record<string, unknown>>(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentProviderUq: uniqueIndex("agent_service_accounts_unique_idx").on(
      table.agentId,
      table.provider,
    ),
  }),
);
