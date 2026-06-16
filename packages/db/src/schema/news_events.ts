import { pgTable, uuid, text, timestamp, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// AgentDash: Atlas Wire world-events newsroom. One row per logged world event.
// Source of truth for research data + the Clockchain receipt. Deduped on
// (companyId, sourceUrlHash). Authored by the beat agent (agentId).
export const newsEvents = pgTable(
  "news_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    beat: text("beat").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    sourceUrl: text("source_url").notNull(),
    sourceUrlHash: text("source_url_hash").notNull(),
    sourceOutlet: text("source_outlet"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    clockchainTime: text("clockchain_time"),
    eventHash: text("event_hash").notNull(),
    ledgerId: text("ledger_id"),
    blockHeight: text("block_height"),
    clockchainTool: text("clockchain_tool"),
    entities: jsonb("entities").$type<string[]>(),
    geo: jsonb("geo").$type<{ country?: string; region?: string }>(),
    confidence: real("confidence"),
    inflection: jsonb("inflection").$type<Record<string, unknown>>(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIngestedIdx: index("news_events_company_ingested_idx").on(table.companyId, table.ingestedAt),
    companyBeatIdx: index("news_events_company_beat_idx").on(table.companyId, table.beat),
    dedupeIdx: uniqueIndex("news_events_company_source_hash_uq").on(table.companyId, table.sourceUrlHash),
  }),
);
