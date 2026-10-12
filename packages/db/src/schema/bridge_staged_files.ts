import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bridgeEndpoints } from "./bridge_endpoints.js";
import { companies } from "./companies.js";
import { issueAttachments } from "./issue_attachments.js";
import { stewardInboxActionHandles } from "./steward_inbox_actions.js";

/**
 * AgentDash (co-worker slice 5): a file the person's own session uploaded for
 * a send-back or a request that has not been confirmed yet.
 *
 * The bytes are stored once, under the company's `bridge-staged` namespace,
 * when the session uploads them against a live `reply` or `request_work`
 * handle whose read-back named this exact sha256 and size. Confirming the
 * handle turns the row into a real attachment that points at the same
 * object (`attached_at`, `attachment_id`). A row that is still unattached
 * after `expires_at` (the handle's own expiry) is swept: its object is
 * deleted, then the row.
 */
export const bridgeStagedFiles = pgTable(
  "bridge_staged_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Null once the handle row is gone; the sweep still finds the row by expiry. */
    handleId: uuid("handle_id").references(() => stewardInboxActionHandles.id, { onDelete: "set null" }),
    bridgeEndpointId: uuid("bridge_endpoint_id").references(() => bridgeEndpoints.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").notNull(),
    provider: text("provider").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    /** The name as the read-back named it, before versioning. */
    originalFilename: text("original_filename").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    attachmentId: uuid("attachment_id").references(() => issueAttachments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    handleShaUq: uniqueIndex("bridge_staged_files_handle_sha_uq").on(table.handleId, table.sha256),
    expiryIdx: index("bridge_staged_files_expiry_idx").on(table.expiresAt),
  }),
);
