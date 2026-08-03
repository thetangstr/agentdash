import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { bridgeTasks } from "./bridge_tasks.js";
import { companies } from "./companies.js";

/**
 * AgentDash-MK: one agent asking another for a named fact.
 *
 * A deliverable's figures come from three places: a connector can fetch them, an
 * agent can be asked for them, or nobody has them. This table is the middle
 * case, and the design commitment behind it is **trigger, not automate** — the
 * ask prompts whatever that person already does rather than replacing their
 * method. Retrieval versus reconstruction becomes a dial rather than a
 * precondition for shipping anything at all.
 *
 * ## Provenance lives here, deliberately
 *
 * `answered_by_agent_id`, `answer_source_kind`, and `answered_at` record who
 * answered, from what source, and when. That is the opposite of the rule
 * governing `workflow_events`, and the difference is not an inconsistency.
 *
 * A figure in a deliverable that nobody can trace is a figure nobody can check,
 * so the fact must carry its author. A *measurement* of how fast people work
 * must not, because that is a different artifact with a different reader and a
 * documented history of being rejected by the people it describes. The two
 * tables are separate so the distinction survives someone joining them by
 * accident: this row names an agent, and the event about it does not.
 *
 * ## One ask per fact per run
 *
 * `agent_fact_requests_run_fact_uq` is not an optimization. A person asked the
 * same question three times in one cycle stops answering, and the whole system
 * is a bet on them continuing to answer. The uniqueness is enforced in the
 * database rather than by a check-then-insert because two collectors racing on
 * the same run would otherwise both find nothing and both ask.
 *
 * ## The lease
 *
 * An escalated fact carries `lease_expires_at` whether or not the harness took
 * the task, because a harness that accepts and then goes quiet leaves the fact
 * exactly as outstanding as one that was never reachable. When the lease lapses
 * the fact becomes `missing` and `flagged` — never silently dropped. An
 * assembled deliverable with an unmarked hole in it is worse than one that says
 * where the hole is, and it is the shape of error that survives review.
 */
export const agentFactRequests = pgTable(
  "agent_fact_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascades: a fact request has no meaning without the company whose
    // deliverable it belongs to, and orphan rows here would outlive the work
    // they describe while still naming the agents that handled it.
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The recurring work stream this fact belongs to. Matches `workflow_events`. */
    pipelineId: text("pipeline_id").notNull(),
    /** One execution of that stream. Half of the dedup key. */
    runId: text("run_id").notNull(),
    /** The named fact. The other half of the dedup key, and the event `stepKey`. */
    factKey: text("fact_key").notNull(),
    /** What was actually asked, in words the answering agent's steward will read. */
    question: text("question").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** asked | answered | declined | escalated | missing | held */
    status: text("status").notNull().default("asked"),
    /**
     * Framed as untrusted before it is stored, and framed again on the way out.
     *
     * The AgentDash agent that receives this lives in a shared environment and
     * is continuously exposed to other agents' output, so an answer is a
     * potential injection channel into whatever assembles the deliverable — and,
     * one hop further, into the harness holding real credentials. Framed rather
     * than sanitized: stripping instruction-looking text mangles legitimate
     * output and still misses novel phrasings.
     */
    answer: text("answer"),
    /**
     * An answer the inbound filter escalated instead of passing.
     *
     * Separate from `answer` rather than a flag beside it, because the question
     * "may the requesting agent read this" must be answerable from the column
     * it reads. A single column plus a boolean is one forgotten `if` away from
     * delivering held content, and the read path here has three callers.
     *
     * Stored FRAMED, like `answer`. A hold is a decision about travel, not a
     * licence to park raw untrusted text where a future reader finds it bare.
     */
    heldAnswer: text("held_answer"),
    /** Why the filter held it — decidable rule categories, never a judgement. */
    filterCategories: jsonb("filter_categories").$type<string[]>(),
    /** Rule ids, so a reviewer reads which predicate fired rather than a verdict. */
    filterRuleIds: jsonb("filter_rule_ids").$type<string[]>(),
    /**
     * The approval a human decides. `set null` rather than cascade: an approval
     * swept away must not take the fact's record of having been held with it.
     */
    filterApprovalId: uuid("filter_approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    /** connector | harness | human | agent | external */
    answerSourceKind: text("answer_source_kind"),
    answeredByAgentId: uuid("answered_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    /** The bridge task that carried the ask to the steward's own machine, if any. */
    escalationTaskId: uuid("escalation_task_id").references(() => bridgeTasks.id, {
      onDelete: "set null",
    }),
    /**
     * False when no live endpoint existed to ask, which is what turns the
     * escalation into a Teams notice instead. Recorded rather than inferred: an
     * escalation nobody could deliver is a different fact about the week than
     * one a harness answered slowly.
     */
    harnessReachable: boolean("harness_reachable"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Surfaced to the approver. A missing fact must never read as an absent one. */
    flagged: boolean("flagged").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runFactUq: uniqueIndex("agent_fact_requests_run_fact_uq").on(
      table.companyId,
      table.runId,
      table.factKey,
    ),
    targetIdx: index("agent_fact_requests_target_idx").on(
      table.companyId,
      table.targetAgentId,
      table.status,
    ),
    requesterIdx: index("agent_fact_requests_requester_idx").on(
      table.companyId,
      table.requestedByAgentId,
      table.status,
    ),
    /** The sweep query: escalated rows whose lease has lapsed. */
    leaseIdx: index("agent_fact_requests_lease_idx").on(table.status, table.leaseExpiresAt),
    statusCk: check(
      "agent_fact_requests_status_ck",
      sql`${table.status} in ('asked', 'answered', 'declined', 'escalated', 'missing', 'held')`,
    ),
    sourceKindCk: check(
      "agent_fact_requests_source_kind_ck",
      sql`${table.answerSourceKind} is null or ${table.answerSourceKind} in ('connector', 'harness', 'human', 'agent', 'external')`,
    ),
    /**
     * An agent cannot ask itself. The dedup key would still hold, but a
     * self-directed ask is a way to write a figure into a deliverable with
     * provenance that says an agent produced it on request — which is exactly
     * the fabrication this table's provenance exists to make visible.
     */
    notSelfCk: check(
      "agent_fact_requests_not_self_ck",
      sql`${table.requestedByAgentId} <> ${table.targetAgentId}`,
    ),
    /**
     * Framing is a property of the stored row, not only of the write path.
     * A migration or a psql session that stores a raw answer fails here, which
     * is the backstop for the read-path framing in the service.
     */
    answerFramedCk: check(
      "agent_fact_requests_answer_framed_ck",
      sql`${table.answer} is null or ${table.answer} like '<untrusted-agent-answer>%'`,
    ),
    /**
     * Held content is framed too.
     *
     * Held content is read by a human deciding whether to release it, which is
     * a reader, and a reader of untrusted text needs to be told what it is
     * reading. Content that is withheld is not content that stopped being
     * hostile.
     */
    heldAnswerFramedCk: check(
      "agent_fact_requests_held_answer_framed_ck",
      sql`${table.heldAnswer} is null or ${table.heldAnswer} like '<untrusted-agent-answer>%'`,
    ),
    /**
     * A hold always names its approval.
     *
     * Without this, `held` with a null approval id is a fact nobody can ever
     * release — a silent drop wearing a better name, and the exact failure the
     * lease sweep exists to prevent one table over.
     */
    heldHasApprovalCk: check(
      "agent_fact_requests_held_has_approval_ck",
      sql`${table.status} <> 'held' or (${table.heldAnswer} is not null and ${table.filterApprovalId} is not null)`,
    ),
  }),
);
