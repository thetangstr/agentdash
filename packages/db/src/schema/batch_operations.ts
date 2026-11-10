import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { BatchCounts } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { assistantGrants } from "./assistant_grants.js";

/**
 * AgentDash admin powers, part 2: one batch of changes to many records.
 *
 * The row is the audit record of the batch. A preview writes it with the
 * exact records and the exact change to each; a confirm spends the single-use
 * handle (conditional UPDATE on `status = 'previewed'`); the runner then sends
 * each item through the record's own single-record route. Expiry flips the
 * status and deletes nothing.
 */
export const batchOperations = pgTable(
  "batch_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** A key of the server's kinds registry, for example `issue.update`. */
    kind: text("kind").notNull(),
    /** The normalized requested change, as the kind's schema parsed it. */
    change: jsonb("change").$type<Record<string, unknown>>().notNull(),
    /** `ui` (a person in the product) or `assistant` (their own Claude, part 5). */
    origin: text("origin").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    assistantGrantId: uuid("assistant_grant_id").references(() => assistantGrants.id, { onDelete: "set null" }),
    /** previewed → running → completed | interrupted; or expired, cancelled. */
    status: text("status").notNull().default("previewed"),
    /** sha256 of the UI confirm handle. Only the hash is stored. */
    confirmTokenHash: text("confirm_token_hash"),
    /** Assistant origin only (part 5): the hash of the code shown in the browser. */
    confirmCodeHash: text("confirm_code_hash"),
    confirmCodeAttempts: integer("confirm_code_attempts").notNull().default(0),
    /** sha256 of the canonical JSON of the previewed items. */
    previewDigest: text("preview_digest").notNull(),
    itemCount: integer("item_count").notNull(),
    counts: jsonb("counts").$type<BatchCounts>().notNull().default({ applied: 0, refused: 0, failed: 0, unknown: 0 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    executorHeartbeatAt: timestamp("executor_heartbeat_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("batch_operations_company_created_idx").on(table.companyId, table.createdAt),
    creatorConfirmedIdx: index("batch_operations_creator_confirmed_idx").on(table.createdByUserId, table.confirmedAt),
    grantConfirmedIdx: index("batch_operations_grant_confirmed_idx").on(table.assistantGrantId, table.confirmedAt),
    statusHeartbeatIdx: index("batch_operations_status_heartbeat_idx").on(table.status, table.executorHeartbeatAt),
    confirmTokenHashUq: uniqueIndex("batch_operations_confirm_token_hash_uq").on(table.confirmTokenHash),
    originCk: check("batch_operations_origin_ck", sql`${table.origin} in ('ui', 'assistant')`),
    statusCk: check(
      "batch_operations_status_ck",
      sql`${table.status} in ('previewed', 'running', 'completed', 'interrupted', 'expired', 'cancelled')`,
    ),
    itemCountCk: check("batch_operations_item_count_ck", sql`${table.itemCount} >= 1`),
  }),
);

/**
 * One record of a batch: what it was, what the preview said it would become,
 * the fingerprint of the touched fields at preview (drift check), and what
 * happened. `unknown` is a first-class outcome: the request was sent and no
 * answer came back, so it is never retried; a person records a verdict.
 */
export const batchOperationItems = pgTable(
  "batch_operation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => batchOperations.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** What a person calls the record, captured at preview. */
    label: text("label").notNull(),
    /** Only the fields the change touches. */
    before: jsonb("before").$type<Record<string, unknown>>().notNull(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    /**
     * For an applied record: the touched fields as re-read after the route
     * answered. When they differ from `after` the route did something other
     * than the preview, and the item says so (`reason_code = applied_differently`).
     */
    actual: jsonb("actual").$type<Record<string, unknown>>(),
    /** pending | applying | applied | refused | failed | unknown */
    outcome: text("outcome").notNull().default("pending"),
    reasonCode: text("reason_code"),
    /** Written for the person, at most 500 characters. */
    reason: text("reason"),
    httpStatus: integer("http_status"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    reconciledByUserId: text("reconciled_by_user_id"),
    reconciledVerdict: text("reconciled_verdict"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchEntityUq: uniqueIndex("batch_operation_items_batch_entity_uq").on(table.batchId, table.entityType, table.entityId),
    batchOrdinalUq: uniqueIndex("batch_operation_items_batch_ordinal_uq").on(table.batchId, table.ordinal),
    outcomeCk: check(
      "batch_operation_items_outcome_ck",
      sql`${table.outcome} in ('pending', 'applying', 'applied', 'refused', 'failed', 'unknown')`,
    ),
    verdictCk: check(
      "batch_operation_items_verdict_ck",
      sql`${table.reconciledVerdict} is null or ${table.reconciledVerdict} in ('landed', 'did_not_land')`,
    ),
  }),
);
