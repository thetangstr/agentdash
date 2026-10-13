import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * AgentDash (co-worker learning loop): "what changed" after a person or another
 * agent corrected an agent's work, waiting to be delivered on the agent's next
 * wake.
 *
 * One row per correction signal: the steward sent the work back through their
 * own Claude (draft against final revision, plus the lessons they wrote), a
 * question answered differently from the agent's recommendation, a rejected
 * approval, a task reopened after the agent closed it, a requester asking for
 * changes, or a hand-off sent back by another agent.
 *
 * **A queue, not a log.** The audit of what happened is the activity log; this
 * table only carries the server-written summary to the agent. A row is claimed
 * by the run whose context includes it (`delivered_run_id`) and is offered
 * again only when that run ended without succeeding, at most
 * `delivery_attempts` times, so a run that never started does not swallow it.
 *
 * **Informs, never grants.** The summary is text for the agent to learn from.
 * Nothing reads it for an authorization decision; the lessons in it are saved,
 * by the agent, into its own memory, which is equally inert.
 */
export const agentCorrections = pgTable(
  "agent_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The agent whose work was corrected, and who receives the summary. */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    /** One of AGENT_CORRECTION_KINDS (services/agent-corrections.ts). */
    kind: text("kind").notNull(),
    /** Server-written, capped. Quoted text inside it is attributed to its author. */
    summary: text("summary").notNull(),
    /** Structured detail: lessons, revision numbers, the options involved. */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    /** Who made the correction: "user" or "agent", and their id. */
    sourceActorType: text("source_actor_type").notNull(),
    sourceActorId: text("source_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredRunId: uuid("delivered_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  },
  (table) => ({
    agentPendingIdx: index("agent_corrections_agent_idx").on(table.companyId, table.agentId, table.createdAt),
    issueIdx: index("agent_corrections_issue_idx").on(table.issueId),
  }),
);
