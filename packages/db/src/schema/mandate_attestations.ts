import { pgTable, uuid, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mandates } from "./mandates.js";

// One row per mandated action attempted by an agent — the attested receipt (or the denial).
export const mandateAttestations = pgTable(
  "mandate_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    mandateId: uuid("mandate_id").notNull().references(() => mandates.id),
    granteeAgentId: uuid("grantee_agent_id").notNull(),
    action: text("action").notNull(),
    counterpartyDid: text("counterparty_did"),
    authorized: boolean("authorized").notNull().default(false),
    reason: text("reason"),
    // Clockchain receipt fields (populated when authorized + attested)
    ledgerId: text("ledger_id"),
    blockHeight: integer("block_height"),
    eventHash: text("event_hash"),
    receiptStatus: text("receipt_status"), // anchored | pending | denied
    escalated: boolean("escalated").notNull().default(false),
    approvalId: uuid("approval_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyMandateIdx: index("mandate_attestations_company_mandate_idx").on(table.companyId, table.mandateId),
    granteeIdx: index("mandate_attestations_grantee_idx").on(table.companyId, table.granteeAgentId),
  }),
);
