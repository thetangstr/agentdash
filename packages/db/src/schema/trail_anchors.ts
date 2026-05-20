import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// AgentDash: attestation v1 (see docs/superpowers/specs/2026-05-13-delegation-and-attestation-design.md)
export const trailAnchors = pgTable(
  "trail_anchors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    prevAnchorId: uuid("prev_anchor_id").references((): AnyPgColumn => trailAnchors.id),
    prevPayloadHash: text("prev_payload_hash"),
    batchStartActivityId: uuid("batch_start_activity_id").notNull(),
    batchEndActivityId: uuid("batch_end_activity_id").notNull(),
    batchActivityCount: integer("batch_activity_count").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    manifestPreview: jsonb("manifest_preview").$type<Record<string, unknown>>(),
    adapter: text("adapter").notNull(),
    externalLogId: text("external_log_id"),
    externalBlockHeight: bigint("external_block_height", { mode: "bigint" }),
    externalAnchoredAt: timestamp("external_anchored_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    lastError: text("last_error"),
    anchoredAt: timestamp("anchored_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("trail_anchors_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("trail_anchors_company_status_idx").on(table.companyId, table.status),
    companyEndActivityIdx: index("trail_anchors_company_end_activity_idx").on(
      table.companyId,
      table.batchEndActivityId,
    ),
  }),
);
