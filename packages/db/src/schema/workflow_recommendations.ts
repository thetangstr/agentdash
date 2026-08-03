import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: the review agent's RECOMMENDATION half.
 *
 * Slice B built measurement — one row per transition, attached to a pipeline
 * and never to a person. This is what reads those rows back: an org-level
 * observer that notices a pattern across cycles and puts a suggestion in front
 * of one named human. **It observes and suggests; it never acts.** There is no
 * status here meaning "applied", and nothing in the codebase executes a
 * recommendation — acceptance is the record that a person agreed, and the
 * change it suggests is an implementer's to make.
 *
 * ## What a recommendation is allowed to be about
 *
 * A pipeline, and a step within it. Never an individual — the constraint B made
 * structural, inherited here rather than restated as a policy.
 *
 * The hard case, and the reason `workflow_recommendations_step_not_a_seat_ck`
 * exists: an **approval seat**. Slice G resolved "who waited on whom" by
 * recording `approval.first` / `approval.second` with `approver_1` /
 * `approver_2`, which is honest for a per-run metric read on demand. It is not
 * honest as a standing recommendation, because a deliverable names exactly one
 * user per seat on its own row and a check constraint guarantees the two seats
 * are two different people. "Seat one is your bottleneck" therefore has no
 * reading that is not "this named colleague is slow" — a per-employee
 * response-time report, which is the documented task-mining backlash and the
 * fastest way to lose adoption at the exact moment the system starts working.
 *
 * So a seat-shaped `step_key` is refused by the database, not merely skipped by
 * the deriver. The deriver could be rewritten; the constraint has to be
 * migrated away, in a commit somebody has to write on purpose.
 *
 * ## Why there is no free-text column
 *
 * A recommendation's sentence is **rendered** at read time from `kind`,
 * `step_key`, and the integer counts in `observation`. There is deliberately no
 * `detail`, `note`, or `summary` column, because a free-text field pointed at a
 * human is precisely where a sentence about a named colleague would eventually
 * arrive — from a later slice, a migration, or a well-meaning caller. Nothing
 * anywhere can write prose into this table.
 *
 * ## Why `recipient_user_id` is not a contradiction
 *
 * It is the **addressee**, the same kind of column as
 * `fact_corrections.created_by_user_id`: it says where a suggestion is sent so
 * it can reach somebody, never who the suggestion is about. It is resolved to
 * the pipeline owner — for a deliverable, the FIRST approver — and deliberately
 * not the second: the second seat is the more senior one, and the version of
 * this feature where a CEO receives efficiency recommendations about the work
 * below them is the version that kills adoption. A pipeline whose owner cannot
 * be resolved raises nothing at all, because routing it up the org chart
 * instead is worse than staying silent.
 *
 * ## The honest limit
 *
 * `pipeline_id` and `step_key` are correlation keys. A deliverable fact names
 * an owning agent, and an agent has a steward, so someone holding authority
 * over `workflow_recommendations`, `deliverable_facts`, and
 * `agent_stewardships` can still join their way to a person. That is weaker
 * than the seat case — a stewardship is reassignable and an ask may be answered
 * by the agent, the harness, or the person — but it is not nothing, and it is
 * stated rather than claimed away. What this table guarantees is that it
 * contains no such name and that nothing reading it alone can produce a
 * per-person number.
 */
export const workflowRecommendations = pgTable(
  "workflow_recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascades, like `workflow_events`. A recommendation has no meaning
    // without the company whose work it observed.
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The recurring work stream this is about — `deliverable:<key>`. */
    pipelineId: text("pipeline_id").notNull(),
    /** The step or fact within it. Never a seat; see the check below. */
    stepKey: text("step_key").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("open"),
    /** How many cycles the window covered. */
    cyclesObserved: integer("cycles_observed").notNull(),
    /**
     * How many of those cycles actually carried the pattern. This is the
     * number that has to reach three, and the number a re-raise compares
     * against — a declined recommendation comes back only when the condition
     * got worse, never merely because the tick came round again.
     */
    evidenceCycles: integer("evidence_cycles").notNull(),
    /**
     * The newest cycle in the window the recommendation was derived from.
     * Present so a decided recommendation can be told apart from a fresh
     * observation of the same pattern.
     */
    latestRunId: text("latest_run_id").notNull(),
    /** Integers only, by allowlist in the validator. No strings, so no names. */
    observation: jsonb("observation").$type<Record<string, number>>().notNull(),
    /**
     * The rows this claim rests on, and a query that reproduces the read.
     *
     * A recommendation without evidence is an opinion, and this system's whole
     * claim is that it measures rather than asserts — so "cites its events" is
     * a constraint rather than a convention.
     */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    /** The addressee — the pipeline owner. See the note above. */
    recipientUserId: text("recipient_user_id").notNull(),
    /**
     * The approval this was raised through. `set null` rather than cascade: a
     * swept approval row must not erase the record that a suggestion was made.
     *
     * Nullable because the row is written first and the approval opened
     * against it — a recommendation that failed to open its approval is
     * visible as an unrouted row rather than being lost.
     */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => ({
    /**
     * One open recommendation per pattern. The tick runs on a timer, and a
     * surface that repeats the same suggestion every pass is a surface people
     * stop reading — after which a real finding scrolls past with the rest,
     * which is the reviewer-capitulation mode this system spends its whole
     * design budget mitigating.
     */
    openPatternUq: uniqueIndex("workflow_recommendations_open_pattern_uq")
      .on(table.companyId, table.pipelineId, table.kind, table.stepKey)
      .where(sql`status = 'open'`),
    recipientIdx: index("workflow_recommendations_recipient_idx").on(
      table.companyId,
      table.recipientUserId,
      table.status,
    ),
    pipelineIdx: index("workflow_recommendations_pipeline_idx").on(
      table.companyId,
      table.pipelineId,
    ),
    kindCk: check(
      "workflow_recommendations_kind_ck",
      sql`${table.kind} in ('recurring_correction', 'chronic_escalation_stall')`,
    ),
    /**
     * No `applied`, no `executed`. Advisory is a property of the state machine,
     * not a promise in a comment.
     */
    statusCk: check(
      "workflow_recommendations_status_ck",
      sql`${table.status} in ('open', 'accepted', 'declined')`,
    ),
    minimumCyclesCk: check(
      "workflow_recommendations_minimum_cycles_ck",
      sql`${table.evidenceCycles} >= 3 and ${table.cyclesObserved} >= ${table.evidenceCycles}`,
    ),
    /**
     * The seat exclusion. Over-broad on purpose: it refuses a legitimate step
     * whose key merely looks like an approval seat, which is the correct
     * direction for this one to err in.
     */
    stepNotASeatCk: check(
      "workflow_recommendations_step_not_a_seat_ck",
      sql`${table.stepKey} !~* '^approval[._]|^approver[._]?[0-9]|_approver_?[0-9]'`,
    ),
    /** H4, in the database: a recommendation that cites nothing cannot exist. */
    citesEvidenceCk: check(
      "workflow_recommendations_cites_evidence_ck",
      sql`jsonb_typeof(${table.evidence}) = 'object'
          and jsonb_typeof(${table.evidence} -> 'eventIds') = 'array'
          and jsonb_array_length(${table.evidence} -> 'eventIds') > 0`,
    ),
    /**
     * The same backstop `workflow_events` carries, for the same reason and with
     * the same honest limitation: it is a blocklist, so it is the backstop and
     * not the gate. The gate is the closed observation allowlist in
     * `packages/shared/src/validators/workflow-recommendations.ts`, where every
     * permitted key is an integer and a name has nowhere to go.
     */
    noPersonCk: check(
      "workflow_recommendations_no_person_ck",
      sql`(${table.observation}::text || ${table.evidence}::text) !~* '"(user_?id|user_?ids|actor_?user_?id|assignee_?id|principal_?id|steward_?id|member_?id|agent_?id|agent_?ids|owner_?id|approver_?user_?id|decided_?by[a-z_]*|requested_?by[a-z_]*|answered_?by[a-z_]*|approved_?by[a-z_]*|email)"'`,
    ),
  }),
);
