import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    // AgentDash (AGE-24): provenance. A steward who finds a key named "default"
    // on their agent could not tell who or what minted it. `source` says what
    // did (agent creation, onboarding, a connect code, a person at the keys
    // panel); the created-by columns say who, when a person or agent did.
    // No foreign keys on purpose: provenance must outlive the principal.
    source: text("source").notNull().default("manual"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    // AgentDash (Company Evaluator, decision D11): a key minted for the
    // read-only evaluator principal carries `principalKind = "evaluator"`.
    // The actor middleware marks such actors read-only and refuses every
    // non-safe request outside the evaluator write allowlist. Null means an
    // ordinary agent key; nothing changes for those.
    principalKind: text("principal_kind"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: index("agent_api_keys_key_hash_idx").on(table.keyHash),
    companyAgentIdx: index("agent_api_keys_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
