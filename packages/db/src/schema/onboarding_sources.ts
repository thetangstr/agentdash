import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { onboardingSessions } from "./onboarding_sessions.js";

export const onboardingSources = pgTable(
  "onboarding_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => onboardingSessions.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceLocator: text("source_locator").notNull(),
    rawContent: text("raw_content"),
    extractedSummary: text("extracted_summary"),
    extractedEntities: jsonb("extracted_entities").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("onboarding_sources_company_session_idx").on(table.companyId, table.sessionId),
  ],
);
