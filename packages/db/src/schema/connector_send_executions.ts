import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { connections } from "./connections.js";

/**
 * AgentDash-MK: what actually happened when an approved `connector_send` ran.
 *
 * Separate from the approval on purpose. The human's decision and the write's
 * outcome are different facts, and conflating them loses the case that matters
 * most: an approval cleanly `approved` whose write may or may not have landed.
 * A status column on `approvals` could not express that without making every
 * existing status check ambiguous.
 *
 * One row per approval, enforced by a unique index. That is the anti-retry
 * mechanism: a second execution attempt for the same approval cannot insert, so
 * an ambiguous outcome can never be "resolved" by trying again. For a CRM of
 * record a duplicate contact is worse than a missing one.
 */
export const connectorSendExecutions = pgTable(
  "connector_send_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    connectionId: uuid("connection_id").references(() => connections.id),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    provider: text("provider").notNull(),
    objectType: text("object_type").notNull(),
    operation: text("operation").notNull(),
    /** sha256 of the properties as approved. Proves what was decided was sent. */
    payloadDigest: text("payload_digest").notNull(),
    /** succeeded | failed | outcome_unknown */
    outcome: text("outcome").notNull(),
    /** Provider-assigned id, when the write returned one. */
    externalId: text("external_id"),
    /** Machine-readable reason; never the payload, never provider body text. */
    reason: text("reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    // The whole anti-duplicate-write mechanism. Not advisory.
    approvalUq: uniqueIndex("connector_send_executions_approval_uq").on(table.approvalId),
    companyIdx: index("connector_send_executions_company_idx").on(table.companyId, table.outcome),
  }),
);
