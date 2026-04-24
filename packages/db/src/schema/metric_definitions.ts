import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    unit: text("unit"),
    dataSourceType: text("data_source_type").notNull(),
    dataSourceConfig: jsonb("data_source_config").notNull().$type<Record<string, unknown>>().default({}),
    aggregation: text("aggregation").notNull().default("latest"),
    collectionMethod: text("collection_method").notNull().default("poll"),
    pollIntervalMinutes: integer("poll_interval_minutes"),
    pluginId: uuid("plugin_id").references(() => plugins.id),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("metric_definitions_company_key_unique").on(table.companyId, table.key),
    index("metric_definitions_company_idx").on(table.companyId),
  ],
);
