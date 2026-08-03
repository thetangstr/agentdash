import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { bridgeEndpoints } from "./bridge_endpoints.js";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: one unit of work an AgentDash agent asked a human's machine to do.
 *
 * Delivery is pull-only. A task sits `queued` until an endpoint long-polls and
 * claims it; the claim is a conditional UPDATE so two Claudes polling the same
 * endpoint can never both receive it.
 *
 * `task_class` decides the gate. A `read` task gathers information and runs on
 * the endpoint's own authority. An `act` task changes something and cannot be
 * delivered until a steward has approved it through the ordinary approvals
 * service — the bridge gets no private path to action.
 *
 * Lease lapse is deliberately asymmetric. A `read` task whose lease expires
 * re-queues once, because re-reading is harmless. An `act` task terminates as
 * `outcome_unknown` and never re-queues: the endpoint may have completed the
 * side effect before going quiet, and a duplicated side effect is worse than a
 * missing one. Same reasoning as connector sends.
 */
export const bridgeTasks = pgTable(
  "bridge_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    endpointId: uuid("endpoint_id").notNull().references(() => bridgeEndpoints.id),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    /** "read" | "act" — see the asymmetry note above. */
    taskClass: text("task_class").notNull(),
    instruction: text("instruction").notNull(),
    /** queued | awaiting_approval | claimed | completed | declined | expired */
    status: text("status").notNull().default("queued"),
    /**
     * Set for `act` tasks. Until the linked approval is approved the task is
     * `awaiting_approval` and no poll will ever see it.
     */
    approvalId: uuid("approval_id").references(() => approvals.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** How many times a lapsed lease has re-queued this task. `act` never exceeds 0. */
    requeueCount: text("requeue_count").notNull().default("0"),
    /** SHA-256 of the single-use token that authorizes submitting this task's result. */
    resultTokenHash: text("result_token_hash"),
    /** Framed as untrusted before it is stored — it came from a machine we cannot see. */
    result: text("result"),
    /** completed | declined | outcome_unknown | expired */
    outcome: text("outcome"),
    declineReason: text("decline_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    // The poll query: oldest queued task for this endpoint.
    pollIdx: index("bridge_tasks_poll_idx").on(table.endpointId, table.status, table.createdAt),
    companyIdx: index("bridge_tasks_company_idx").on(table.companyId, table.status),
    approvalIdx: index("bridge_tasks_approval_idx").on(table.approvalId),
    // A result token is single-use; uniqueness makes a replayed submission a
    // database error rather than a second write.
    resultTokenUq: uniqueIndex("bridge_tasks_result_token_uq")
      .on(table.resultTokenHash)
      .where(sql`${table.resultTokenHash} is not null`),
  }),
);
