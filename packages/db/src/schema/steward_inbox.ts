import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { bridgeEndpoints } from "./bridge_endpoints.js";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: the durable steward inbox — the canonical log of things a
 * specific human needs to know about, and the cursor each of their machines
 * has caught up to.
 *
 * WHY A NEW LOG, given how much event machinery already exists:
 *
 * - `live_events` is not a log. It is a 54-line in-process `EventEmitter`
 *   whose ids start at 0 on every boot and whose events reach only sockets
 *   that happen to be connected. A cursor cannot point into it.
 * - `activity_log` is durable but has no recipient. It records who acted, not
 *   who needs to hear, and its ids are random uuids so it cannot be read
 *   incrementally.
 * - `workflow_events` records `actorKind` — "what kind, never which one" — by
 *   deliberate design, so it can never address a person and must not start.
 *
 * So the missing primitive is precisely this: an ordered, per-steward,
 * incrementally-readable log. Nothing here replaces the three above; this is
 * the addressed projection they never had.
 */

/**
 * One thing one human needs to know.
 *
 * Rows are immutable. When an approval is resubmitted at a new revision that
 * is a NEW event, never an edit of the old one — a client that already synced
 * and acked revision 1 would otherwise never learn revision 2 exists.
 *
 * `stewardUserId` is resolved WHEN THE EVENT IS WRITTEN, not when it is read.
 * That is the deliberate choice: an inbox is a record of what was put in front
 * of someone, so transferring an agent to a new steward must not retroactively
 * move the old steward's history onto them, nor empty the old steward's inbox
 * of things they were already shown. Read-time resolution would do both.
 */
export const stewardInboxEvents = pgTable(
  "steward_inbox_events",
  {
    /**
     * Surrogate key only — deliberately NOT the cursor. A `bigserial` is
     * assigned when a statement runs and not when its transaction commits, so
     * a reader can observe 101 while 100 is still in flight, ack 101, and skip
     * 100 forever. `seq` below is the cursor for exactly that reason.
     */
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /**
     * Cascades, like `workflow_events` and unlike most AgentDash-MK tables. A
     * steward inbox has no meaning without the company whose work it reports
     * on, and an explicit purge in the deletion path is a thing a future
     * deletion path can forget. A foreign key cannot.
     */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The person this is addressed to. Same id space as `bridge_endpoints.user_id`. */
    stewardUserId: text("steward_user_id").notNull(),
    /**
     * Gap-free position within THIS steward's stream, assigned under a row lock
     * on `steward_inbox_sequences`. Gap-free is the whole point: it makes
     * `seq > cursor` exactly correct, so "no update is lost" is a property of
     * the schema rather than a hope about commit timing.
     */
    seq: integer("seq").notNull(),
    /** `approval.opened` | `approval.resolved`. Kept small on purpose — see the service. */
    kind: text("kind").notNull(),
    refType: text("ref_type").notNull(),
    refId: text("ref_id").notNull(),
    /**
     * The agent this concerns, when there is one.
     *
     * `set null` on purpose: an inbox item is a record of what a person was
     * TOLD, so deleting the agent later must not erase it. Same treatment the
     * approval that caused it already gets.
     */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /**
     * Caller-composed idempotency key, e.g. `approval:<id>:rev2:opened`.
     * Appending is therefore safe to retry: a duplicate is swallowed rather
     * than producing a second inbox item for one real occurrence.
     */
    dedupeKey: text("dedupe_key").notNull(),
    /**
     * Thin by policy. This log is read into a local AI client, where it becomes
     * model context and may leave the machine — so an event names the ask and
     * points at it, and never carries the evidence. Same rule the approval
     * card summary already follows, for a stricter reason.
     */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The sync query, and the guarantee that a steward's stream has no
    // duplicate positions.
    streamUq: uniqueIndex("steward_inbox_events_stream_uq").on(
      table.companyId,
      table.stewardUserId,
      table.seq,
    ),
    // Scoped by company so two companies cannot suppress each other's events
    // by colliding on a dedupe key.
    dedupeUq: uniqueIndex("steward_inbox_events_dedupe_uq").on(table.companyId, table.dedupeKey),
    refIdx: index("steward_inbox_events_ref_idx").on(table.refType, table.refId),
  }),
);

/**
 * The per-steward sequence allocator.
 *
 * A separate row rather than `max(seq) + 1` over the events table: the latter
 * races under concurrent appends and would hand two events the same position.
 * This row is locked `FOR UPDATE` for the moment it takes to claim a number,
 * which serialises appends for ONE steward and nobody else.
 */
export const stewardInboxSequences = pgTable(
  "steward_inbox_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    stewardUserId: text("steward_user_id").notNull(),
    /** The next position to hand out. First event in a stream is `seq` 1. */
    nextSeq: integer("next_seq").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stewardUq: uniqueIndex("steward_inbox_sequences_steward_uq").on(
      table.companyId,
      table.stewardUserId,
    ),
  }),
);

/**
 * How far one machine has caught up.
 *
 * Per ENDPOINT, not per steward, and that asymmetry is deliberate. Two of a
 * person's machines must each catch up independently, so delivery position is
 * a property of the machine. Whether the HUMAN has dealt with something is a
 * different question with a different answer, and it already has a home in
 * `inbox_dismissals` and in the approval's own status.
 *
 * Keeping those two apart is a direct lesson from `issue_read_states`, which
 * was made to mean both "I looked at this" and "this was deliberately put in
 * front of you". The result was an inbox that could not be emptied. One column
 * answering two questions is the bug; this is two columns in two tables.
 */
export const stewardInboxCursors = pgTable(
  "steward_inbox_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => bridgeEndpoints.id, { onDelete: "cascade" }),
    /** Highest `seq` this machine has explicitly acknowledged. 0 means "nothing yet". */
    lastAckedSeq: integer("last_acked_seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointUq: uniqueIndex("steward_inbox_cursors_endpoint_uq").on(table.endpointId),
  }),
);
