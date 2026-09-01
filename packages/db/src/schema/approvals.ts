import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // AgentDash-MK: a decision is bound to the revision the decider saw, so a
    // stale button (a Telegram/Teams card from before a resubmit) fails closed
    // instead of deciding a request that has since changed.
    revision: integer("revision").notNull().default(1),
    decisionChannel: text("decision_channel"),
    decisionIdempotencyKey: text("decision_idempotency_key"),
    decisionActorRole: text("decision_actor_role"),
    overrideReason: text("override_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
    // One idempotency key per company: a provider redelivering the same
    // callback must never produce a second decision.
    decisionIdempotencyUq: uniqueIndex("approvals_company_decision_idempotency_uq")
      .on(table.companyId, table.decisionIdempotencyKey)
      .where(sql`${table.decisionIdempotencyKey} is not null`),
  }),
);
