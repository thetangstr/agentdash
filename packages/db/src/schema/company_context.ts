import { pgTable, uuid, text, timestamp, numeric, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { onboardingSources } from "./onboarding_sources.js";

export const companyContext = pgTable(
  "company_context",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    contextType: text("context_type").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.80"),
    sourceId: uuid("source_id").references(() => onboardingSources.id),
    verifiedByUserId: text("verified_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("company_context_company_type_key_unique").on(table.companyId, table.contextType, table.key),
    index("company_context_company_type_idx").on(table.companyId, table.contextType),
  ],
);
