import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: the measurement substrate.
 *
 * One row per transition in a piece of work — an ask, an answer, an escalation,
 * a correction, an approval. Together they answer the only question that
 * decides whether this is a business: how many minutes of human attention does
 * this deliverable still cost, and is that number falling.
 *
 * ## Events attach to the pipeline, never to a person as subject
 *
 * `actor_kind` records **what kind** of actor acted — human, agent, system. It
 * never records which one. There is deliberately:
 *
 *   - no user-subject column,
 *   - no agent column (an agent is bound 1:1 to a steward, so an agent id is a
 *     person by another name),
 *   - and no index by which either could be grouped.
 *
 * This is the same structural enforcement as Rule B in the harness control
 * channel. The reporting path does not *decline* to break work down per person;
 * there is nothing here to break it down by. A policy someone must remember is
 * not a control, and this one has to hold for years under pressure from whoever
 * next asks "but who was slow?".
 *
 * It is not squeamishness. An agent measuring "efficiency across human-agent
 * workflows" is, from an employee's chair, an agent watching how fast they
 * respond and how much help they needed. That is the documented task-mining
 * backlash, and it is the fastest way to lose adoption at the exact moment the
 * system starts working.
 *
 *   ✅ "This deliverable needed 40 minutes of review this week, down from 95."
 *   ❌ "Sarah took three days to answer."
 *
 * ## Why the payload has a check constraint
 *
 * `payload` is jsonb, which is a hole in the argument above: any caller could
 * put a user id in it and reconstruct exactly what the columns refuse. The
 * service layer closes this with a per-event-type allowlist — the permitted
 * keys are declared and none of them is a person — but a service-layer rule
 * only binds callers who go through the service. A future slice, a migration,
 * or a psql session would not.
 *
 * So the database refuses too. `workflow_events_payload_no_person_ck` matches
 * the serialized payload against identifier-shaped names and rejects the row.
 * It reads the whole serialized text rather than only the top-level keys,
 * because a check that inspects only the top level is a check someone routes
 * around by nesting one object. It fails closed: a legitimate value that merely
 * looks like a person identifier is rejected, which is the correct direction
 * for this constraint to err in.
 *
 * The regex is a blocklist and blocklists are never complete. It is the
 * backstop, not the gate; the closed allowlist in
 * `server/src/services/workflow-events.ts` is the gate.
 *
 * ## The honest limit
 *
 * `run_id` and `pipeline_id` are correlation keys that may point at rows in
 * other tables which do name people (an approval records its decider). Someone
 * holding authority over BOTH tables can therefore still join their way to a
 * person. What this table guarantees is that it contains no such name, exposes
 * no such column or index, and that nothing reading it alone — including the
 * review agent — can produce a per-person number.
 */
export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascades, unlike most AgentDash-MK tables. Measurement is a by-product of
    // a company's work and has no meaning without it; leaving orphan rows to be
    // swept by hand would mean the only thing outliving a deleted company is
    // the record of how hard its people worked.
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /**
     * The recurring work stream. A deliverable pipeline id once those exist;
     * until then a work-stream key that names a kind of work and nobody who
     * does it — `approval:hire_agent`, `bridge:act`, `agent_directives`.
     */
    pipelineId: text("pipeline_id").notNull(),
    /** One execution of that stream. */
    runId: text("run_id").notNull(),
    /** The step or fact within the run. Corrections group by this. */
    stepKey: text("step_key").notNull(),
    eventType: text("event_type").notNull(),
    /** 'human' | 'agent' | 'system' — what kind, never which one. */
    actorKind: text("actor_kind").notNull(),
    /**
     * Elapsed time attributable to this transition. On a human-actor event this
     * is elapsed-under-review, not measured attention — nothing here can see a
     * person's calendar, and claiming otherwise would be the more invasive
     * design as well as the less honest one.
     */
    durationMs: integer("duration_ms"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("workflow_events_run_idx").on(table.companyId, table.runId, table.occurredAt),
    pipelineIdx: index("workflow_events_pipeline_idx").on(
      table.companyId,
      table.pipelineId,
      table.occurredAt,
    ),
    actorKindCk: check(
      "workflow_events_actor_kind_ck",
      sql`${table.actorKind} in ('human', 'agent', 'system')`,
    ),
    payloadObjectCk: check(
      "workflow_events_payload_object_ck",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    payloadNoPersonCk: check(
      "workflow_events_payload_no_person_ck",
      sql`${table.payload}::text !~* '"(user_?id|user_?ids|actor_?user_?id|assignee_?id|principal_?id|steward_?id|member_?id|agent_?id|agent_?ids|owner_?id|decided_?by[a-z_]*|requested_?by[a-z_]*|answered_?by[a-z_]*|approved_?by[a-z_]*|email)"'`,
    ),
  }),
);
