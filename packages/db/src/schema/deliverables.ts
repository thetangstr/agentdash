import { sql } from "drizzle-orm";
import {
  boolean,
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
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: the weekly deliverable pipeline.
 *
 * One recurring artifact, produced end to end. Facts are fetched where they
 * exist and **requested from whoever produces them where they don't**, assembled
 * with provenance on every figure, checked by something that did not do the
 * assembling, approved by two named humans in sequence, and shipped — leaving a
 * machine-readable record of how each number was made.
 *
 * The owner direction that shapes all of it is **trigger, not automate**. The
 * goal is not to replace how people produce their numbers; it is to trigger
 * whatever they already do, collect the result in one place in one format, and
 * attach provenance. Retrieval-versus-reconstruction is therefore a dial, not a
 * precondition: whatever can be fetched is fetched, whatever cannot is asked
 * for, and a fact nobody can supply lands `missing` and flagged rather than
 * quietly absent.
 *
 * Every company FK cascades. Phase 0 shipped without it and nine suites failed
 * teardown on orphan rows, so it is a lesson rather than a preference.
 */

/**
 * The definition. Authored by an **implementer**, never by the customer.
 *
 * There is deliberately no self-service authoring surface anywhere above this
 * table. Self-service process capture has no working analogue — every one that
 * works (Prialto's Engagement Managers being the clearest) has a third party
 * doing the encoding — so the fact list is produced by someone watching one
 * real cycle, and the routes that write here are administrator-only.
 */
export const deliverables = pgTable(
  "deliverables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Stable handle. Appears in `pipelineId` and in the MCP resource URI. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** weekly | monthly. What decides when the scheduler opens the next run. */
    cadence: text("cadence").notNull(),
    /**
     * The agent that collects and assembles. It is the requester on every
     * agent-to-agent ask, so it can never also be the owner of a `human` fact —
     * an agent asking itself would manufacture provenance for a figure nobody
     * produced.
     */
    assemblerAgentId: uuid("assembler_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Two approvers, and they decide in order.
     *
     * Both are named at definition time rather than resolved from an org chart,
     * because "who signs this off" is a property of the artifact and not of
     * anybody's reporting line. The check below refuses one person holding both
     * seats: two approvals from the same human is one approval with extra
     * ceremony, and G7 would then be satisfiable by a single decision.
     */
    firstApproverUserId: text("first_approver_user_id").notNull(),
    secondApproverUserId: text("second_approver_user_id").notNull(),
    /** active | paused. A paused deliverable opens no runs. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("deliverables_company_key_uq").on(table.companyId, table.key),
    companyIdx: index("deliverables_company_idx").on(table.companyId),
    cadenceCk: check("deliverables_cadence_ck", sql`${table.cadence} in ('weekly', 'monthly')`),
    statusCk: check("deliverables_status_ck", sql`${table.status} in ('active', 'paused')`),
    distinctApproversCk: check(
      "deliverables_distinct_approvers_ck",
      sql`${table.firstApproverUserId} <> ${table.secondApproverUserId}`,
    ),
  }),
);

/**
 * The fact list. **This is the encoding artifact** — the thing the implementer
 * produces by watching one cycle, and the only durable record of how this
 * organization's numbers are actually made.
 *
 * Each fact is `system` (fetched through a connector under the owner's own
 * on-behalf-of identity) or `human` (asked of the owning agent, which tries
 * first and escalates to its steward's harness if it cannot answer). The split
 * is the dial: moving a fact from `human` to `system` is what "more of this is
 * automated now" looks like, and it is a one-row change.
 */
export const deliverableFacts = pgTable(
  "deliverable_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    /** The named figure. Doubles as the `stepKey` on every event about it. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** system | human */
    sourceType: text("source_type").notNull(),
    /** How it is computed, in prose. Read by a human, served over MCP. */
    derivation: text("derivation").notNull(),
    /**
     * Whose figure this is: the OBO principal's agent for `system`, the agent
     * to ask for `human`. One column rather than two because it answers one
     * question — which agent this fact belongs to — and two would let a row
     * name a reader and a different owner, which nothing downstream could act on.
     */
    ownerAgentId: uuid("owner_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** e.g. `sharepoint`. Null for `human`, enforced below. */
    connectorProvider: text("connector_provider"),
    /** The exact target: site, item, and named table or range. */
    connectorConfig: jsonb("connector_config").$type<Record<string, unknown>>(),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableKeyUq: uniqueIndex("deliverable_facts_deliverable_key_uq").on(
      table.deliverableId,
      table.key,
    ),
    orderIdx: index("deliverable_facts_order_idx").on(table.deliverableId, table.orderIndex),
    companyIdx: index("deliverable_facts_company_idx").on(table.companyId),
    sourceTypeCk: check(
      "deliverable_facts_source_type_ck",
      sql`${table.sourceType} in ('system', 'human')`,
    ),
    /**
     * A `system` fact without a connector target is a fact nothing can fetch,
     * and a `human` fact carrying one is a fact two mechanisms would race for.
     * Both are definition bugs and both are caught here rather than at 3am in a
     * collection loop.
     */
    sourceShapeCk: check(
      "deliverable_facts_source_shape_ck",
      sql`(${table.sourceType} = 'system') = (${table.connectorProvider} is not null and ${table.connectorConfig} is not null)`,
    ),
  }),
);

/**
 * The acceptance tests, authored with the fact list and **never by the thing
 * that assembles**.
 *
 * That is the load-bearing half of "the check is independent". A checker whose
 * criteria the assembler could write is a checker the assembler passes by
 * construction, and no amount of running it on a separate code path would help.
 * The routes that write this table are administrator-only, exactly like the
 * fact list, and an agent key reaches them with a 403.
 */
export const deliverableChecks = pgTable(
  "deliverable_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** moved_more_than | missing | matches_prior | range | custom */
    kind: text("kind").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    /**
     * blocking | advisory. A blocking failure stops the run from being
     * presented at all; an advisory one is a flag the first approver sees.
     */
    severity: text("severity").notNull().default("blocking"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableKeyUq: uniqueIndex("deliverable_checks_deliverable_key_uq").on(
      table.deliverableId,
      table.key,
    ),
    companyIdx: index("deliverable_checks_company_idx").on(table.companyId),
    kindCk: check(
      "deliverable_checks_kind_ck",
      sql`${table.kind} in ('moved_more_than', 'missing', 'matches_prior', 'range', 'custom')`,
    ),
    severityCk: check(
      "deliverable_checks_severity_ck",
      sql`${table.severity} in ('blocking', 'advisory')`,
    ),
  }),
);

/**
 * One cycle.
 *
 * The three constraints at the bottom are the whole of G3 and G7 expressed
 * where they cannot be forgotten. Everything else about "the check is
 * independent" and "nothing ships without both approvals" is code, and code is
 * one refactor away from not being true.
 */
export const deliverableRuns = pgTable(
  "deliverable_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    /**
     * The period this run is for — `2026-W31`, `2026-07`. Unique per
     * deliverable, so two schedulers ticking together open one run rather than
     * two, and a retry is idempotent without a lock.
     */
    runKey: text("run_key").notNull(),
    /** collecting | assembled | checked | awaiting_approval | approved | shipped | abandoned */
    status: text("status").notNull().default("collecting"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    assembledAt: timestamp("assembled_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkPassed: boolean("check_passed"),
    /** One entry per declared check: key, kind, severity, passed, detail. */
    checkOutcome: jsonb("check_outcome").$type<Record<string, unknown>[]>(),
    /**
     * A digest of the values the CHECK actually read, recomputed from the
     * persisted rows at the moment it ran.
     *
     * This is what makes self-certification structurally impossible rather than
     * discouraged. An assembler that ran the check and then adjusted a figure
     * would leave a run whose stored digest no longer matches its own values,
     * and the review surface refuses to present it. The assembler cannot
     * recompute the digest either — writing `check_draft_hash` is the check's
     * act, and a run whose values moved has to be checked again.
     */
    checkDraftHash: text("check_draft_hash"),
    /**
     * The approvals, in order. `set null` rather than cascade: an approval row
     * swept away must not erase the run's record of having been approved, which
     * is the record G7 is about.
     */
    firstApprovalId: uuid("first_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    firstApprovedAt: timestamp("first_approved_at", { withTimezone: true }),
    secondApprovalId: uuid("second_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    secondApprovedAt: timestamp("second_approved_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    abandonReason: text("abandon_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runKeyUq: uniqueIndex("deliverable_runs_run_key_uq").on(table.deliverableId, table.runKey),
    companyStatusIdx: index("deliverable_runs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    statusCk: check(
      "deliverable_runs_status_ck",
      sql`${table.status} in ('collecting', 'assembled', 'checked', 'awaiting_approval', 'approved', 'shipped', 'abandoned')`,
    ),
    /**
     * G3. Nothing reaches `checked` or beyond without the check's own three
     * artifacts. An assembler that wanted to certify itself would have to write
     * a digest of values it can no longer change.
     */
    checkedHasVerdictCk: check(
      "deliverable_runs_checked_has_verdict_ck",
      sql`${table.status} not in ('checked', 'awaiting_approval', 'approved', 'shipped')
          or (${table.checkedAt} is not null and ${table.checkOutcome} is not null and ${table.checkDraftHash} is not null)`,
    ),
    /**
     * G5. A second approval cannot exist before the first one landed. This is
     * what makes the two approvals *sequential* rather than merely two, and it
     * holds against a caller that creates both up front and collects them in
     * whichever order they arrive.
     */
    sequentialApprovalCk: check(
      "deliverable_runs_sequential_approval_ck",
      sql`${table.secondApprovalId} is null or ${table.firstApprovedAt} is not null`,
    ),
    /**
     * G7. Nothing ships without both. Asserted in the database because the
     * adversarial test has to attempt the violation somewhere the service layer
     * cannot be the thing under test.
     */
    bothApprovalsToShipCk: check(
      "deliverable_runs_both_approvals_to_ship_ck",
      sql`${table.status} not in ('approved', 'shipped')
          or (${table.firstApprovalId} is not null and ${table.firstApprovedAt} is not null
              and ${table.secondApprovalId} is not null and ${table.secondApprovedAt} is not null)`,
    ),
  }),
);

/**
 * Durable corrections, carried forward across runs.
 *
 * **This is the learning loop, and it attaches to the fact — never to a
 * person.** Nothing here names whose figure was wrong. There is no subject
 * column, no index by which corrections could be grouped by author, and the
 * service that reads this table filters on `fact_id` and nothing else.
 *
 * `created_by_user_id` records who made the correction, which is authorship
 * provenance of the same kind as an answer's `answered_by_agent_id`: it says
 * where a change came from so it can be questioned. What is refused is the
 * other direction — a column that would let this table answer "how many
 * corrections has this person's work needed", which is a performance record
 * wearing a data model.
 *
 * One active correction per fact, so a new one retires its predecessor rather
 * than stacking into an order-dependent pile nobody can reason about.
 */
export const factCorrections = pgTable(
  "fact_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    factId: uuid("fact_id")
      .notNull()
      .references(() => deliverableFacts.id, { onDelete: "cascade" }),
    /**
     * `{ kind: 'replace_source' | 'annotate' | 'override_value', ... }`.
     *
     * `replace_source` rewrites where a `system` fact is read from and is
     * carried forward silently — it is a corrected derivation, and the next run
     * simply reads the right place. `annotate` attaches a durable note that
     * travels into the draft and the MCP record. `override_value` replaces the
     * collected figure and is carried forward **always flagged**, because a
     * number nobody re-derives is a stale premise, and a human at the end
     * catches errors but not wrong foundations.
     */
    correction: jsonb("correction").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    originRunId: uuid("origin_run_id").references(() => deliverableRuns.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => ({
    activeByFactUq: uniqueIndex("fact_corrections_active_fact_uq")
      .on(table.factId)
      .where(sql`${table.retiredAt} is null`),
    companyIdx: index("fact_corrections_company_idx").on(table.companyId),
    kindCk: check(
      "fact_corrections_kind_ck",
      sql`${table.correction} ->> 'kind' in ('replace_source', 'annotate', 'override_value')`,
    ),
  }),
);

/**
 * One fact's value in one run.
 *
 * `source_ref` is the exact call that produced it and `method` is how. The
 * constraint below refuses a `fetched` or `answered` value without both: a
 * figure with no provenance is a bug, not a degraded case, and the whole point
 * of the derivation record is that it is a by-product of producing the
 * deliverable rather than something anybody writes down afterwards.
 */
export const factValues = pgTable(
  "fact_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => deliverableRuns.id, { onDelete: "cascade" }),
    factId: uuid("fact_id")
      .notNull()
      .references(() => deliverableFacts.id, { onDelete: "cascade" }),
    value: jsonb("value"),
    /** fetched | asked | answered | missing */
    status: text("status").notNull(),
    /** The exact call made — a Graph path, or the fact-request id. */
    sourceRef: text("source_ref"),
    /** How the figure was obtained, including any correction applied. */
    method: text("method"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    flagged: boolean("flagged").notNull().default(false),
    flagReason: text("flag_reason"),
    /**
     * Which agent produced the figure. Not a user: collection is agent-to-agent
     * and the answering agent's row is where a person can be reached from, one
     * deliberate join away, by someone who needs to ask about the number.
     */
    answeredByAgentId: uuid("answered_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    appliedCorrectionId: uuid("applied_correction_id").references(() => factCorrections.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runFactUq: uniqueIndex("fact_values_run_fact_uq").on(table.runId, table.factId),
    companyIdx: index("fact_values_company_idx").on(table.companyId),
    statusCk: check(
      "fact_values_status_ck",
      sql`${table.status} in ('fetched', 'asked', 'answered', 'missing')`,
    ),
    provenanceCk: check(
      "fact_values_provenance_ck",
      sql`${table.status} not in ('fetched', 'answered')
          or (${table.sourceRef} is not null and ${table.method} is not null and ${table.fetchedAt} is not null)`,
    ),
  }),
);
