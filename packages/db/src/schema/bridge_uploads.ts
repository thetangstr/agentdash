import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bridgeEndpoints } from "./bridge_endpoints.js";
import { companies } from "./companies.js";
import { connections } from "./connections.js";

/**
 * AgentDash (document access, slice 8): a person's own file, uploaded from
 * their own machine to their own OneDrive, through the server.
 *
 * One row per confirmed upload. It exists between "yes, upload and share" and
 * the last fragment, and afterwards as the record of what landed where and who
 * was given access.
 *
 * The Graph upload session URL is a bearer capability: anyone holding it can
 * write the file's bytes without any other credential. So it is stored
 * encrypted (same provider as connection tokens), is never returned to the
 * client, and is never logged. The client streams fragments to AgentDash and
 * AgentDash forwards them.
 *
 * Nothing here holds the person's local path or any file content: the file
 * name, size, type and SHA-256 the client declared, and ids from Microsoft.
 */
export const bridgeUploads = pgTable(
  "bridge_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The machine that confirmed it. Fragments are accepted from it alone. */
    bridgeEndpointId: uuid("bridge_endpoint_id")
      .notNull()
      .references(() => bridgeEndpoints.id, { onDelete: "cascade" }),
    /** The person uploading: the endpoint's owner when it was confirmed. */
    actorUserId: text("actor_user_id").notNull(),
    /** The person's own Microsoft connection the session was created with. */
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    /** `{ folderId, folderPath }` in the person's own drive. */
    destination: jsonb("destination").$type<Record<string, unknown>>().notNull(),
    /**
     * The confirmed sharing plan (recipients by user id and role, link,
     * message, task or issue), then, once complete, the per-recipient outcome.
     */
    sharing: jsonb("sharing").$type<Record<string, unknown>>().notNull(),
    /** Encrypted `{ uploadUrl }`. Null once the session is finished or cancelled. */
    uploadUrlEncrypted: jsonb("upload_url_encrypted").$type<Record<string, unknown>>(),
    /** open | completed | failed | cancelled */
    status: text("status").notNull().default("open"),
    driveId: text("drive_id"),
    itemId: text("item_id"),
    webUrl: text("web_url"),
    /** When Microsoft expires the upload session. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    endpointIdx: index("bridge_uploads_endpoint_idx").on(table.bridgeEndpointId, table.status),
    createdIdx: index("bridge_uploads_created_idx").on(table.createdAt),
    statusCk: check("bridge_uploads_status_ck", sql`${table.status} in ('open', 'completed', 'failed', 'cancelled')`),
  }),
);
