import { pgTable, uuid, text, timestamp, integer, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { metricDefinitions } from "./metric_definitions.js";
import { experiments } from "./experiments.js";
import { researchCycles } from "./research_cycles.js";

export const measurements = pgTable(
  "measurements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    metricDefinitionId: uuid("metric_definition_id").notNull().references(() => metricDefinitions.id),
    experimentId: uuid("experiment_id").references(() => experiments.id),
    cycleId: uuid("cycle_id").references(() => researchCycles.id),
    value: doublePrecision("value").notNull(),
    rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
    sampleSize: integer("sample_size"),
    confidenceInterval: jsonb("confidence_interval").$type<{ lower: number; upper: number; confidenceLevel: number }>(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    collectionMethod: text("collection_method").notNull(),
    dataSourceSnapshot: jsonb("data_source_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("measurements_company_metric_idx").on(table.companyId, table.metricDefinitionId, table.collectedAt),
    index("measurements_experiment_idx").on(table.experimentId, table.collectedAt),
    index("measurements_cycle_idx").on(table.cycleId, table.collectedAt),
  ],
);
