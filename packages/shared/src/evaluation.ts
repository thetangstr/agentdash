import { z } from "zod";

/**
 * AgentDash: Company Evaluator (Stage 1, read-only shadow) — shared vocabulary.
 *
 * Spec: docs/superpowers/specs/2026-09-05-company-evaluator-design.md.
 * Everything here is data vocabulary; formulas live in the server's
 * evaluation services and carry their own `formulaVersion`.
 */

/**
 * Schema version stamped on every ledger event. Bump when a payload shape changes.
 * 2 (Milestone 2): roster snapshots (agents, projects, goals), label additions,
 * issue snapshots carry labels, title tokens and lifecycle timestamps, DoD
 * events carry criterion ids and text hashes.
 * 3 (APM gate 3, P3.2): the agent-side sources (`EVALUATION_AGENT_SOURCE_EVENT_TYPES`),
 * typed `access.*` and `routine.trigger_deleted` activity, `issue.checked_out` as an
 * assignment plus a transition, goal snapshots carry `currentValue`/`lastUpdatedAt`,
 * agent snapshots carry `adapterType`/`model`, verdicts carry their project/goal,
 * `authz.refused` carries the V2 dimension/rule/target when the row has them.
 */
export const EVALUATION_SCHEMA_VERSION = 3;

/** Contract document version (spec §4). */
export const EVALUATION_CONTRACT_VERSION = "v1";

/** Rule 5: events inside this window are ordered by ingest time, then dedupe key. */
export const EVALUATION_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Source authority tiers (spec §6). */
export const EVALUATION_SOURCE_TIERS = ["T0", "T1", "T2", "T3"] as const;
export type EvaluationSourceTier = (typeof EVALUATION_SOURCE_TIERS)[number];

/** Actor kinds a ledger event can carry. `evaluator` is the read-only principal itself. */
export const EVALUATION_ACTOR_TYPES = ["agent", "user", "system", "plugin", "evaluator"] as const;
export type EvaluationActorType = (typeof EVALUATION_ACTOR_TYPES)[number];

/**
 * Event types the Milestone 1 ingest emits. Names are `<subject>.<fact>`.
 * `activity.other` preserves control-plane actions the evaluator does not
 * interpret yet, so nothing is dropped; the original action is in the payload.
 */
export const EVALUATION_EVENT_TYPES = [
  // contract
  "contract.declared",
  // issues (from activity_log)
  "issue.created",
  "issue.transition",
  "issue.assignment_changed",
  "issue.blockers_updated",
  "issue.comment_added",
  "issue.dod_set",
  "issue.recovery_budget_exhausted",
  "issue.snapshot",
  "issue.label_added",
  // roster facts, so a card is a function of the ledger alone (replay agreement)
  "agent.snapshot",
  "project.snapshot",
  "goal.snapshot",
  // runs
  "run.finished",
  // review / decisions
  "verdict.recorded",
  "approval.created",
  "approval.decided",
  "interaction.changed",
  // cost
  "cost.recorded",
  // agents and authority
  "agent.lifecycle",
  "authz.refused",
  // structured self-reports (T2)
  "handoff.pm_to_builder",
  "handoff.builder_to_ci",
  "handoff.tester_to_reviewer",
  "handoff.reviewer_to_tpm",
  "handoff.tpm_merge_report",
  "evidence.withdrawn",
  // evaluator outputs and appeals
  "evaluation.finding",
  "evaluation.correction",
  "evaluation.disposition",
  "evaluation.evaluator_note",
  // AgentDash (APM gate 3, P3.2; evaluation LLD §9.2) — typed activity: activity_log
  // actions that used to land as `activity.other` (no item), now named so agent
  // scoring can read them. Milestone scoring treats them exactly as before.
  "access.policy_changed",
  "access.would_refuse",
  "routine.trigger_deleted",
  // AgentDash (APM gate 3, P3.2) — the agent-side sources (EVALUATION_AGENT_SOURCE_EVENT_TYPES)
  "assessment.automated",
  "correction.recorded",
  "routine.snapshot",
  "routine.trigger_snapshot",
  "routine.run_changed",
  "deliverable.run_changed",
  "responsibility.interval",
  "profile.revision_changed",
  "profile.application_changed",
  "issue.execution_decision",
  // AgentDash (APM gate 4, P4.1) — the performance manager's advisory recommendations
  // and the owner's decision on each (EVALUATION_ADVISORY_EVENT_TYPES).
  "evaluation.agent_recommendation",
  // catch-all
  "activity.other",
] as const;
export type EvaluationEventType = (typeof EVALUATION_EVENT_TYPES)[number];

/**
 * AgentDash (APM gate 4, P4.1): advisory records appended by the performance
 * manager and the owner (a recommendation, then at most one decision on it,
 * both `evaluation.agent_recommendation`, told apart by `sourceVersion`
 * `recommended` / `decided`). They are inputs to no card: milestone and agent
 * scoring skip them, and the agent-card cut ignores them, so filing or
 * deciding a recommendation never moves a number. A "pause" recommendation
 * pauses nothing.
 */
export const EVALUATION_ADVISORY_EVENT_TYPES = ["evaluation.agent_recommendation"] as const satisfies readonly EvaluationEventType[];

/**
 * AgentDash (APM gate 3, P3.2): event types minted only from the source tables
 * gate 3 added to ingest (agent_corrections, routines, routine_triggers,
 * routine_runs + routine_run_occurrences, deliverable_runs,
 * issue_responsibilities, agent_profile_revisions/applications,
 * issue_execution_decisions). They feed agent cards only: milestone scoring
 * drops them before it folds a window, so backfilling their history can never
 * move a milestone card (no new items, no ingest-lag marker, no asOf shift).
 */
export const EVALUATION_AGENT_SOURCE_EVENT_TYPES = [
  /** agent_corrections kind `harness_evaluation` (a paired-harness receipt); class `private_pairing:<receiptId>`. */
  "assessment.automated",
  /** Every other agent_corrections kind (a person or agent corrected the work); class `private_agent:<agentId>`. */
  "correction.recorded",
  /** routines: status, catch-up and concurrency policies, assignee (versioned; minted when they change). */
  "routine.snapshot",
  /** routine_triggers: kind, cron, timezone, enabled (versioned; minted when they change). */
  "routine.trigger_snapshot",
  /** routine_runs (one event per status) with the dispatched occurrence's `scheduledFor`. */
  "routine.run_changed",
  /** deliverable_runs (one event per status). */
  "deliverable.run_changed",
  /** issue_responsibilities: one event when an interval opens, one when it closes. */
  "responsibility.interval",
  /** agent_profile_revisions (per state and body hash): responsibility keys, obligations, deadlines. */
  "profile.revision_changed",
  /** agent_profile_applications (one event per status). */
  "profile.application_changed",
  /** issue_execution_decisions (review/approval stage decisions on an issue). */
  "issue.execution_decision",
] as const satisfies readonly EvaluationEventType[];

/** Typed activity_log actions (gate 3): milestone scoring counts them as it counted `activity.other` without an item. */
export const EVALUATION_TYPED_ACTIVITY_EVENT_TYPES = [
  "access.policy_changed",
  "access.would_refuse",
  "routine.trigger_deleted",
] as const satisfies readonly EvaluationEventType[];

/** The MAW payload types accepted as T2 self-reports (doc/maw/handoff-schemas.json). */
export const EVALUATION_HANDOFF_TYPES = [
  "pm_to_builder",
  "builder_to_ci",
  "tester_to_reviewer",
  "reviewer_to_tpm",
  "tpm_merge_report",
] as const;
export type EvaluationHandoffType = (typeof EVALUATION_HANDOFF_TYPES)[number];

/** Required evidence classes (spec §4.1). */
export const EVALUATION_EVIDENCE_CLASSES = [
  "dod_present",
  "neutral_verdict",
  "delivery_ref",
  "ci_green",
  "independent_review",
] as const;
export type EvaluationEvidenceClass = (typeof EVALUATION_EVIDENCE_CLASSES)[number];

/** The engineering default a derived contract must always use (§4, rule 16). */
export const EVALUATION_DEFAULT_REQUIRED_EVIDENCE: readonly EvaluationEvidenceClass[] = [
  "dod_present",
  "neutral_verdict",
  "delivery_ref",
  "ci_green",
  "independent_review",
];

export const evaluationMilestoneRefSchema = z.object({
  kind: z.enum(["project", "goal"]),
  id: z.guid(),
});
export type EvaluationMilestoneRef = z.infer<typeof evaluationMilestoneRefSchema>;

/** §4.3: a criterion is measurable only when it names a check. */
export const evaluationCriterionCheckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record"),
    /** e.g. `verdict.passed`, `pr.merged`, `project.status=completed` */
    record: z.string().min(1),
  }),
  z.object({
    kind: z.literal("human_attest"),
    /** The independent human who attests; never the implementer. */
    attesterUserId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("metric"),
    metricKey: z.string().min(1),
    target: z.number(),
    unit: z.string().min(1),
  }),
]);

export const evaluationAcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** Absent = unmeasurable: counts against coverage, never as satisfied. */
  check: evaluationCriterionCheckSchema.optional(),
  /** Where the text came from: `issue.definitionOfDone`, `pm_to_builder.acceptance_criteria`, `goal.metricDefinition`, `human`. */
  source: z.string().min(1),
});

/** The canonical evaluation contract, v1 (spec §4). Stored as a `contract.declared` ledger event. */
export const evaluationContractV1Schema = z.object({
  contractVersion: z.literal(EVALUATION_CONTRACT_VERSION),
  companyId: z.guid(),
  goalId: z.guid().nullable(),
  parentGoalId: z.guid().nullable(),
  milestoneRef: evaluationMilestoneRefSchema,
  accountableUserId: z.string().min(1).nullable(),
  leadAgentId: z.guid().nullable(),
  acceptanceCriteria: z.array(evaluationAcceptanceCriterionSchema),
  definitionOfDone: z.string().nullable(),
  requiredEvidence: z.array(z.enum(EVALUATION_EVIDENCE_CLASSES)),
  independenceRule: z.literal("independence/v1"),
  /** Actors who may not review this milestone's items, declared by the founder. */
  excludedReviewers: z.array(z.string()).default([]),
  /** Items only the founder may act on; there is no system record of a lock (§4.4). */
  founderLocks: z.array(z.guid()).default([]),
  outcomeTarget: z
    .object({ metricKey: z.string().min(1), target: z.number(), unit: z.string().min(1), source: z.string().min(1) })
    .nullable(),
  targetDate: z.string().date().nullable(),
  downstreamRiskAcceptance: z.string().nullable(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime().nullable(),
  /** `declared` by the accountable human, or `derived` by the evaluator (confidence capped at Medium). */
  source: z.enum(["declared", "derived"]),
});
export type EvaluationContractV1 = z.infer<typeof evaluationContractV1Schema>;

// ---------------------------------------------------------------------------
// AgentDash: Agent Performance Management gate 2 — the agent as a subject
// (doc/plans/2026-10-29-agent-evaluation-lld.md §2–3). Additive: V1 milestone
// contracts, `evaluationMilestoneRefSchema` and V1 parsing are unchanged. Gate 2
// only DECLARES agent contracts; scoring the agent subject is gate 3.
// ---------------------------------------------------------------------------

/** Contract document version for the agent subject. A string like V1's `"v1"`, so `contractVersion` stays one type. */
export const EVALUATION_CONTRACT_V2_VERSION = "v2";

export const EVALUATION_SUBJECT_KINDS = ["project", "goal", "agent"] as const;
export type EvaluationSubjectKind = (typeof EVALUATION_SUBJECT_KINDS)[number];

/** What is being evaluated (§2). Milestone (V1) contracts keep `EvaluationMilestoneRef`. */
export const evaluationSubjectRefSchema = z.object({
  kind: z.enum(EVALUATION_SUBJECT_KINDS),
  id: z.guid(),
});
export type EvaluationSubjectRef = z.infer<typeof evaluationSubjectRefSchema>;

/**
 * Coverage classes (§4): which kinds of evidence must be present. Only a
 * grouping — each check has its own typed predicate, so a broadened class can
 * never satisfy `pr.merged`. The V1 evidence classes stay valid.
 */
export const EVALUATION_COVERAGE_CLASSES = [
  ...EVALUATION_EVIDENCE_CLASSES,
  "deliverable_shipped",
  "independent_check",
  "human_acceptance",
  "automated_acceptance",
  "use_recorded",
] as const;
export type EvaluationCoverageClass = (typeof EVALUATION_COVERAGE_CLASSES)[number];

/** Human steps the work is expected to need. They are not interventions (§6.3). */
export const EVALUATION_EXPECTED_HUMAN_STEPS = ["approval", "sign_off", "answer"] as const;
export type EvaluationExpectedHumanStep = (typeof EVALUATION_EXPECTED_HUMAN_STEPS)[number];

export const EVALUATION_AUTOMATED_JUDGES = ["independent_agent", "harness", "evaluator"] as const;
export type EvaluationAutomatedJudge = (typeof EVALUATION_AUTOMATED_JUDGES)[number];

/** Upper bound on a relative deadline: a year. */
const EVALUATION_DEADLINE_MAX_HOURS = 24 * 366;

export const evaluationResponsibilityDeadlineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("after_trigger"), hours: z.number().positive().max(EVALUATION_DEADLINE_MAX_HOURS) }).strict(),
  z.object({ kind: z.literal("after_assignment"), hours: z.number().positive().max(EVALUATION_DEADLINE_MAX_HOURS) }).strict(),
  /** Goals have no target-date column; a goal-bound deadline lives here. */
  z.object({ kind: z.literal("by_date"), date: z.string().date() }).strict(),
]);
export type EvaluationResponsibilityDeadline = z.infer<typeof evaluationResponsibilityDeadlineSchema>;

/**
 * What a person says good looks like for one responsibility (§3). Authored by
 * a person; an agent may draft it for a human to approve (D2). Criteria reuse
 * the V1 criterion shape; a criterion's identity is the tuple
 * `(contractEventId, responsibilityKey, criterionId, checkHash)`.
 */
export const evaluationResponsibilityContractSchema = z
  .object({
    criteria: z
      .array(evaluationAcceptanceCriterionSchema)
      .max(50)
      .refine((criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length, {
        message: "criterion ids must be unique within a responsibility",
      }),
    coverage: z.array(z.enum(EVALUATION_COVERAGE_CLASSES)).max(EVALUATION_COVERAGE_CLASSES.length),
    deadline: evaluationResponsibilityDeadlineSchema.optional(),
    outcomeLinks: z.array(z.object({ goalId: z.guid() }).strict()).max(20),
    expectedHumanSteps: z.array(z.enum(EVALUATION_EXPECTED_HUMAN_STEPS)).max(EVALUATION_EXPECTED_HUMAN_STEPS.length),
    judges: z
      .object({
        automated: z.array(z.enum(EVALUATION_AUTOMATED_JUDGES)).max(EVALUATION_AUTOMATED_JUDGES.length),
        human: z
          .object({
            userId: z.string().min(1),
            sampleRate: z.number().min(0).max(1),
            minPerWindow: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** Owner-agreed only; `null` or absent = report only, no threshold. */
    thresholds: z.record(z.string().min(1), z.number()).nullable().optional(),
  })
  .strict();
export type EvaluationResponsibilityContract = z.infer<typeof evaluationResponsibilityContractSchema>;

/**
 * The agent contract, v2 (§3). Stored as a `contract.declared` ledger event
 * with source id `agent:<agentId>` when a profile revision is applied.
 */
export const evaluationContractV2Schema = z
  .object({
    contractVersion: z.literal(EVALUATION_CONTRACT_V2_VERSION),
    companyId: z.guid(),
    subjectRef: evaluationSubjectRefSchema.extend({ kind: z.literal("agent") }),
    accountableUserId: z.string().min(1).nullable(),
    profileRevisionId: z.guid(),
    independenceRule: z.literal("independence/v1"),
    responsibilities: z
      .array(evaluationResponsibilityContractSchema.extend({ key: z.string().min(1).max(80) }).strict())
      .max(50)
      .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
        message: "responsibility keys must be unique",
      }),
  })
  .strict();
export type EvaluationContractV2 = z.infer<typeof evaluationContractV2Schema>;

/**
 * Which contract version a `contract.declared` payload carries, without
 * validating it. The milestone resolver reads only `"v1"`; an agent (`"v2"`)
 * contract is not an invalid milestone contract and must not be counted as one.
 */
export function evaluationContractVersionOf(payload: unknown): "v1" | "v2" | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const inner = record.contract && typeof record.contract === "object" ? (record.contract as Record<string, unknown>) : record;
  const version = inner.contractVersion;
  return version === EVALUATION_CONTRACT_VERSION || version === EVALUATION_CONTRACT_V2_VERSION ? version : null;
}

/** Confidence tiers (spec §7) and their display labels. */
export const EVALUATION_CONFIDENCE_TIERS = ["high", "medium", "low", "insufficient"] as const;
export type EvaluationConfidenceTier = (typeof EVALUATION_CONFIDENCE_TIERS)[number];
export const EVALUATION_CONFIDENCE_LABELS: Record<EvaluationConfidenceTier, string> = {
  high: "strong evidence",
  medium: "adequate evidence",
  low: "limited evidence",
  insufficient: "insufficient evidence",
};

/** Rule 12: issues carrying this label are the evaluator's own output and leave every scored population. */
export const EVALUATION_REVIEW_LABEL = "evaluator-review";

/** Metric keys (spec §5). Outcome metrics score milestones; operating metrics score agents and the company row. */
export const EVALUATION_OUTCOME_METRICS = ["O1", "O2", "O3", "O4", "O5"] as const;
export type EvaluationOutcomeMetric = (typeof EVALUATION_OUTCOME_METRICS)[number];
export const EVALUATION_OPERATING_METRICS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"] as const;
export type EvaluationOperatingMetric = (typeof EVALUATION_OPERATING_METRICS)[number];
export type EvaluationMetricKey = EvaluationOutcomeMetric | EvaluationOperatingMetric;

export const EVALUATION_METRIC_NAMES: Record<EvaluationMetricKey, string> = {
  O1: "Acceptance satisfied",
  O2: "Deadline adherence",
  O3: "Downstream risk index",
  O4: "Goal progress",
  O5: "Evidence hygiene",
  P1: "Autonomy",
  P2: "Judgment",
  P3: "Factual accuracy",
  P4: "Handoff quality",
  P5: "Recovery",
  P6: "Authority compliance",
  P7: "Cycle time",
  P8: "Token and cost efficiency",
  P9: "Duplicate and rework rate",
};

/**
 * §5.3 composite weights. Metrics absent here are shown, never scored. O4 keeps
 * its weight but is display-only until goal measurements exist (nothing is
 * imputed from a status), so the outcome composite renormalises over the rest.
 */
export const EVALUATION_OUTCOME_WEIGHTS: Partial<Record<EvaluationMetricKey, number>> = { O1: 0.4, O2: 0.15, O3: 0.2, O4: 0.1, O5: 0.15 };
export const EVALUATION_OPERATING_WEIGHTS: Partial<Record<EvaluationMetricKey, number>> = { P1: 0.2, P2: 0.2, P3: 0.25, P4: 0.15, P9: 0.2 };
/** §5.3 guards: minimum included metrics for a composite to exist. */
export const EVALUATION_COMPOSITE_MIN_INCLUDED = { outcome: 2, operating: 3 } as const;
/** A composite needs at least this share of its included weight resting on decidable records (rule 10 against continuous starvation). */
export const EVALUATION_COMPOSITE_COVERAGE_FLOOR = 0.5;
/**
 * No single metric may supply more than this share of a composite's effective weight; otherwise the score is
 * withheld and the metric named. 0.75 keeps §5.3's two-metric minimum reachable for every pair that includes O1
 * (O1 + O2 or O1 + O5 at full coverage is 72.7%); a metric standing in for a missing one (77%+) is still caught.
 */
export const EVALUATION_COMPOSITE_MAX_CONCENTRATION = 0.75;

/** §7 tier boundaries on coverage. */
export const EVALUATION_TIER_THRESHOLDS = { high: 0.8, medium: 0.5, low: 0.2 } as const;

/** §9.1 exception catalogue. */
export const EVALUATION_EXCEPTION_IDS = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12", "E13", "E14"] as const;
export type EvaluationExceptionId = (typeof EVALUATION_EXCEPTION_IDS)[number];
export const EVALUATION_EXCEPTION_SEVERITIES = ["routine", "material", "immediate"] as const;
export type EvaluationExceptionSeverity = (typeof EVALUATION_EXCEPTION_SEVERITIES)[number];
/** Routing vocabulary (§9.1): who a raised exception is addressed to. */
export const EVALUATION_EXCEPTION_ROUTES = ["accountable_owner", "manager", "both_managers", "founder_view"] as const;
export type EvaluationExceptionRoute = (typeof EVALUATION_EXCEPTION_ROUTES)[number];

/** `severity` is the default; the rules may raise it (E2 is material for delivery or authority claims, §9.1). */
export const EVALUATION_EXCEPTIONS: Record<EvaluationExceptionId, { title: string; severity: EvaluationExceptionSeverity; routes: readonly EvaluationExceptionRoute[] }> = {
  E1: { title: "unsupported completion", severity: "material", routes: ["accountable_owner"] },
  E2: { title: "contradiction", severity: "routine", routes: ["both_managers"] },
  E3: { title: "authority breach", severity: "immediate", routes: ["founder_view", "accountable_owner"] },
  E4: { title: "self-review", severity: "immediate", routes: ["founder_view", "manager"] },
  E5: { title: "stale work", severity: "routine", routes: ["accountable_owner"] },
  E6: { title: "duplicate work", severity: "routine", routes: ["manager"] },
  E7: { title: "cost anomaly", severity: "routine", routes: ["manager"] },
  E8: { title: "excessive intervention", severity: "routine", routes: ["manager"] },
  E9: { title: "unresolved downstream risk", severity: "material", routes: ["accountable_owner"] },
  E10: { title: "missing DoD at start", severity: "routine", routes: ["manager"] },
  E11: { title: "emission drop", severity: "routine", routes: ["manager"] },
  E12: { title: "DoD narrowed", severity: "material", routes: ["accountable_owner", "founder_view"] },
  E13: { title: "evidence withdrawn", severity: "material", routes: ["accountable_owner"] },
  E14: { title: "reviewer concentration", severity: "routine", routes: ["both_managers"] },
};
/** D11: the kind of principal an agent API key mints. `evaluator` keys are read-only (spec §10.2). */
export const EVALUATION_PRINCIPAL_KINDS = ["agent", "evaluator"] as const;
export type EvaluationPrincipalKind = (typeof EVALUATION_PRINCIPAL_KINDS)[number];

/**
 * Spec §10.2: the only non-safe requests a read-only (evaluator) principal may
 * make. Each route enforces its own constraints (findings are ledger inserts;
 * review items land only in the evaluator project, labelled, `todo`, assigned
 * to a human; correction notes attach evidence, never decide). Snapshots are
 * taken by the cadence or an administrator, never by the principal. Everything
 * else — issues, verdicts, approvals, agents, keys, releases — is refused
 * before any router sees it.
 */
export const EVALUATOR_WRITE_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/api\/companies\/[^/]+\/evaluation\/findings$/,
  /^\/api\/companies\/[^/]+\/evaluation\/review-items$/,
  /^\/api\/companies\/[^/]+\/evaluation\/corrections\/[^/]+\/note$/,
];

export const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The reason code the read-only gate records on refusals; scoring excludes these from P6. */
export const EVALUATOR_READ_ONLY_REASON = "EVALUATOR_READ_ONLY";

export function isEvaluatorWriteAllowed(method: string, path: string): boolean {
  if (SAFE_HTTP_METHODS.has(method.toUpperCase())) return true;
  const clean = path.split("?")[0]!.replace(/\/+$/, "");
  return EVALUATOR_WRITE_ROUTE_PATTERNS.some((re) => re.test(clean));
}

/** §10.1: the evaluator agent's role; §9.2: the project its review items land in. */
export const EVALUATOR_AGENT_ROLE = "evaluator";
export const EVALUATION_REVIEW_PROJECT_NAME = "Evaluator review items";

// ---------------------------------------------------------------------------
// AgentDash: Agent Performance Management gate 3, P3.1 freeze — the shared
// vocabulary for evidence access classes, typed check predicates, agent
// dispositions, owed work and the agent card
// (doc/plans/2026-10-29-agent-evaluation-lld.md §3–§12,
// doc/plans/2026-10-29-apm-gate3-build-spec.md). Additive only: V1 milestone
// contracts, the evidence classes and their semantics (`pr.merged` →
// `delivery_ref`), and the existing disposition kinds are unchanged.
// ---------------------------------------------------------------------------

/** Exported for the agent contract's readers; the schemas above are unchanged. */
export type EvaluationCriterionCheck = z.infer<typeof evaluationCriterionCheckSchema>;
export type EvaluationAcceptanceCriterion = z.infer<typeof evaluationAcceptanceCriterionSchema>;

/** The agent subject ref (V2 contracts, agent cards, bindings). */
export const evaluationAgentSubjectRefSchema = evaluationSubjectRefSchema.extend({ kind: z.literal("agent") }).strict();
export type EvaluationAgentSubjectRef = z.infer<typeof evaluationAgentSubjectRefSchema>;

// ---- Evidence access classes (LLD §9.1) -----------------------------------

/**
 * Who may read a ledger event and drill into it. Stored on
 * `evaluation_events.access_class`; rows ingested before gate 3 are `company`.
 * - `company`: members with company access (today's behaviour).
 * - `project:<projectId>`: principals who may read that project (restricted-project rules).
 * - `private_pairing:<receiptId>`: the represented person, the paired agent's steward and accountable user, admins.
 * - `private_agent:<agentId>`: the agent's steward and accountable user, admins.
 */
export const EVALUATION_ACCESS_CLASS_KINDS = ["company", "project", "private_pairing", "private_agent"] as const;
export type EvaluationAccessClassKind = (typeof EVALUATION_ACCESS_CLASS_KINDS)[number];

export type EvaluationAccessClass =
  | "company"
  | `project:${string}`
  | `private_pairing:${string}`
  | `private_agent:${string}`;

/** The column default; also what every pre-gate-3 row carries. */
export const EVALUATION_DEFAULT_ACCESS_CLASS = "company" as const satisfies EvaluationAccessClass;

export type ParsedEvaluationAccessClass =
  | { kind: "company" }
  | { kind: "project"; projectId: string }
  | { kind: "private_pairing"; receiptId: string }
  | { kind: "private_agent"; agentId: string };

/** Lowercase canonical uuid only, so one class has exactly one spelling and string equality is class equality. */
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse a stored or supplied class. Returns null for anything that is not one
 * canonical class (unknown kind, missing or non-canonical id, whitespace,
 * extra parts). Readers treat null as readable by company admins only: an
 * unparseable class never widens access.
 */
export function parseEvaluationAccessClass(value: unknown): ParsedEvaluationAccessClass | null {
  if (typeof value !== "string") return null;
  if (value === "company") return { kind: "company" };
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (!CANONICAL_UUID_RE.test(id)) return null;
  if (kind === "project") return { kind: "project", projectId: id };
  if (kind === "private_pairing") return { kind: "private_pairing", receiptId: id };
  if (kind === "private_agent") return { kind: "private_agent", agentId: id };
  return null;
}

export function isEvaluationAccessClass(value: unknown): value is EvaluationAccessClass {
  return parseEvaluationAccessClass(value) !== null;
}

/** The canonical string for a parsed class. Ids are lowercased; a non-uuid id is a programming error and throws. */
export function formatEvaluationAccessClass(parsed: ParsedEvaluationAccessClass): EvaluationAccessClass {
  if (parsed.kind === "company") return "company";
  const id = (parsed.kind === "project" ? parsed.projectId : parsed.kind === "private_pairing" ? parsed.receiptId : parsed.agentId).toLowerCase();
  if (!CANONICAL_UUID_RE.test(id)) throw new Error(`evaluation access class ${parsed.kind} needs a uuid, got "${id}"`);
  return `${parsed.kind}:${id}` as EvaluationAccessClass;
}

export const evaluationAccessClassSchema = z.custom<EvaluationAccessClass>((value) => isEvaluationAccessClass(value), {
  message: "expected company, project:<uuid>, private_pairing:<uuid> or private_agent:<uuid>",
});

// ---- Typed check predicates and coverage (LLD §4) --------------------------

/** `record` checks the milestone evaluator resolves today, each to one evidence class. Semantics unchanged. */
export const EVALUATION_MILESTONE_RECORD_PREDICATES = ["verdict.passed", "pr.merged", "ci.green", "dod.present"] as const;
/**
 * `record` checks added for agent responsibilities. Each is its own typed
 * predicate over its own records, so a shipped deliverable can never satisfy
 * `pr.merged`. The milestone resolver does not know these names and keeps
 * reporting them as an unknown record check (undecidable), as today.
 */
export const EVALUATION_AGENT_RECORD_PREDICATES = [
  /** `deliverable_runs.shipped_at` for the occurrence's run. */
  "deliverable.shipped",
  /** `deliverable_runs.check_passed`, with checks run by something other than the assembler. */
  "deliverable.checks_passed",
  /** Both named approvals approved by real (non-synthetic) users. */
  "deliverable.approved",
  /** A bound harness check (LLD §5.3) for this criterion and work version. */
  "harness.criterion_passed",
  /** Delivery inside the contract `deadline` (LLD §7). */
  "obligation.on_time",
  /** A `use_confirmed` disposition by a person, or a later connector record of downstream use. */
  "use.confirmed",
] as const;
export const EVALUATION_RECORD_PREDICATES = [...EVALUATION_MILESTONE_RECORD_PREDICATES, ...EVALUATION_AGENT_RECORD_PREDICATES] as const;
export type EvaluationRecordPredicate = (typeof EVALUATION_RECORD_PREDICATES)[number];

/** Spellings the milestone resolver already accepts for a predicate (`scoring/contract.ts` `parseRecordCheck`). */
export const EVALUATION_RECORD_PREDICATE_ALIASES: Readonly<Record<string, EvaluationRecordPredicate>> = {
  "regression_gates.pass": "ci.green",
};

/**
 * The coverage class (a grouping, not a predicate) each predicate's evidence
 * belongs to; null = in no coverage class. The four milestone predicates map
 * to the evidence class they resolve to today.
 */
export const EVALUATION_PREDICATE_COVERAGE: Readonly<Record<EvaluationRecordPredicate, EvaluationCoverageClass | null>> = {
  "verdict.passed": "neutral_verdict",
  "pr.merged": "delivery_ref",
  "ci.green": "ci_green",
  "dod.present": "dod_present",
  "deliverable.shipped": "deliverable_shipped",
  "deliverable.checks_passed": "independent_check",
  "deliverable.approved": "human_acceptance",
  "harness.criterion_passed": "automated_acceptance",
  "obligation.on_time": null,
  "use.confirmed": "use_recorded",
};

/** A `metric` check whose `metricKey` is `goal:<goalId>` reads that goal's snapshot `currentValue`/`lastUpdatedAt` (LLD §4). */
export const EVALUATION_GOAL_METRIC_KEY_PREFIX = "goal:";

/** What a criterion's check is evaluated as. Agent scoring dispatches on `kind`; nothing maps one predicate onto another's records. */
export type EvaluationTypedPredicate =
  /** No check declared: unmeasurable, counts against coverage, never satisfied. */
  | { kind: "none" }
  | { kind: "record"; predicate: EvaluationRecordPredicate; coverage: EvaluationCoverageClass | null }
  /** `project.status=<value>` / `goal.status=<value>`. */
  | { kind: "status"; subject: "project" | "goal"; value: string }
  /** Recorded by the named attester as a bound `criterion_attest` disposition. */
  | { kind: "human_attest"; attesterUserId: string }
  | { kind: "goal_metric"; goalId: string; target: number; unit: string }
  /** Any other metric key: no measurement source, undecidable. */
  | { kind: "metric"; metricKey: string; target: number; unit: string }
  /** An unknown `record` name: undecidable, reported as such. */
  | { kind: "unknown"; record: string };

/** Resolve a criterion's check to its typed predicate. Pure. Agrees with the milestone resolver on every name it knows. */
export function evaluationTypedPredicate(check: EvaluationCriterionCheck | null | undefined): EvaluationTypedPredicate {
  if (!check) return { kind: "none" };
  if (check.kind === "human_attest") return { kind: "human_attest", attesterUserId: check.attesterUserId };
  if (check.kind === "metric") {
    if (check.metricKey.startsWith(EVALUATION_GOAL_METRIC_KEY_PREFIX)) {
      const goalId = check.metricKey.slice(EVALUATION_GOAL_METRIC_KEY_PREFIX.length);
      if (CANONICAL_UUID_RE.test(goalId)) return { kind: "goal_metric", goalId, target: check.target, unit: check.unit };
    }
    return { kind: "metric", metricKey: check.metricKey, target: check.target, unit: check.unit };
  }
  const record = check.record;
  const name = Object.prototype.hasOwnProperty.call(EVALUATION_RECORD_PREDICATE_ALIASES, record) ? EVALUATION_RECORD_PREDICATE_ALIASES[record]! : record;
  if ((EVALUATION_RECORD_PREDICATES as readonly string[]).includes(name)) {
    const predicate = name as EvaluationRecordPredicate;
    return { kind: "record", predicate, coverage: EVALUATION_PREDICATE_COVERAGE[predicate] };
  }
  const status = /^(project|goal)\.status=([a-z_]+)$/.exec(record);
  if (status) return { kind: "status", subject: status[1] as "project" | "goal", value: status[2]! };
  return { kind: "unknown", record };
}

// ---- Criterion identity and work items (LLD §3, §5.3) ----------------------

/**
 * A criterion's identity: `(contractEventId, responsibilityKey, criterionId,
 * checkHash)`. `checkHash` is the rule-17 check hash — the first 16 hex
 * characters of sha256 over the canonical JSON `{ check }` (`criterionKey` in
 * `server/src/services/evaluation/scoring/contract.ts`), so rewording the text
 * keeps the criterion and changing the check starts a new one.
 */
export const evaluationCriterionRefSchema = z
  .object({
    contractEventId: z.guid(),
    responsibilityKey: z.string().min(1).max(80),
    criterionId: z.string().min(1),
    checkHash: z.string().regex(/^[0-9a-f]{16}$/, "checkHash is 16 lowercase hex characters"),
  })
  .strict();
export type EvaluationCriterionRef = z.infer<typeof evaluationCriterionRefSchema>;

/** One unambiguous string per tuple, for maps and dedupe keys. */
export function evaluationCriterionRefKey(ref: EvaluationCriterionRef): string {
  return JSON.stringify([ref.contractEventId, ref.responsibilityKey, ref.criterionId, ref.checkHash]);
}

/** The work a judgment or a case is about: an issue (a work version) or a deliverable run (deliverables have no issue). */
export const EVALUATION_WORK_ITEM_KINDS = ["issue", "deliverable_run"] as const;
export type EvaluationWorkItemKind = (typeof EVALUATION_WORK_ITEM_KINDS)[number];
export const evaluationWorkItemRefSchema = z.object({ kind: z.enum(EVALUATION_WORK_ITEM_KINDS), id: z.guid() }).strict();
export type EvaluationWorkItemRef = z.infer<typeof evaluationWorkItemRefSchema>;

// ---- Dispositions (LLD §4, §10, §12) ---------------------------------------

/**
 * Every disposition kind `POST evaluation/dispositions` accepts. The first six
 * are the Milestone 3–5 kinds; their bodies and handling are unchanged.
 */
export const EVALUATION_DISPOSITION_KINDS = [
  "correction_decided",
  "criterion_attest",
  "contract_exception_accepted",
  "exception_reviewed",
  "exception_missed",
  "shadow_note",
  "use_confirmed",
  "disagreement_noted",
] as const;
export type EvaluationDispositionKind = (typeof EVALUATION_DISPOSITION_KINDS)[number];
/** Kinds that bind to an agent subject. `criterion_attest` is agent-bound only when the body carries `binding`. */
export const EVALUATION_AGENT_DISPOSITION_KINDS = ["criterion_attest", "use_confirmed", "disagreement_noted"] as const;
export type EvaluationAgentDispositionKind = (typeof EVALUATION_AGENT_DISPOSITION_KINDS)[number];

/** What a bound attestation is about: the criterion tuple, the subject agent and the work item (LLD §4, §5.3). */
export const evaluationCriterionAttestBindingSchema = z
  .object({
    criterion: evaluationCriterionRefSchema,
    subjectRef: evaluationAgentSubjectRefSchema,
    item: evaluationWorkItemRefSchema,
  })
  .strict();
export type EvaluationCriterionAttestBinding = z.infer<typeof evaluationCriterionAttestBindingSchema>;

const dispositionEvidenceRefsSchema = z.array(z.guid()).max(50);
const dispositionNoteSchema = z.string().min(1).max(4000);

/**
 * `criterion_attest` bound to an agent criterion, recorded by the criterion's
 * named attester (not admin-only). A body WITH `binding` is this shape; a body
 * without it is the Milestone (V1) attest, unchanged. The payload deliberately
 * has no top-level `criterionId`/`issueId`, so the milestone matcher
 * (`criterionDispositions` in `scoring/evidence.ts`) never counts it, and a V1
 * attest (no tuple) never satisfies an agent criterion: attestations do not
 * cross subjects.
 */
export const evaluationAgentCriterionAttestSchema = z
  .object({
    kind: z.literal("criterion_attest"),
    binding: evaluationCriterionAttestBindingSchema,
    result: z.enum(["satisfied", "unsatisfied"]),
    evidenceRefs: dispositionEvidenceRefsSchema.min(1),
    note: dispositionNoteSchema.optional(),
  })
  .strict();

/** A person confirms the work was used (the `use.confirmed` predicate; LLD §4). A fact of use, not acceptance or outcome. */
export const evaluationUseConfirmedSchema = z
  .object({
    kind: z.literal("use_confirmed"),
    subjectRef: evaluationAgentSubjectRefSchema,
    item: evaluationWorkItemRefSchema,
    responsibilityKey: z.string().min(1).max(80).optional(),
    note: dispositionNoteSchema.optional(),
    evidenceRefs: dispositionEvidenceRefsSchema.default([]),
  })
  .strict();

/**
 * The accountable person notes a criterion-level disagreement between bound
 * judgments (LLD §10). Both judgments stay; this records that a person saw
 * it. It never settles the disagreement or picks a winner.
 */
export const evaluationDisagreementNotedSchema = z
  .object({
    kind: z.literal("disagreement_noted"),
    subjectRef: evaluationAgentSubjectRefSchema,
    item: evaluationWorkItemRefSchema,
    criterion: evaluationCriterionRefSchema,
    /** The disagreeing judgments' ledger events. */
    judgmentEventIds: z
      .array(z.guid())
      .min(2)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, { message: "judgment event ids must be distinct" }),
    note: dispositionNoteSchema,
  })
  .strict();

/** The agent-subject disposition bodies. The route tries this union when a body is one of these kinds (and, for `criterion_attest`, carries `binding`). */
export const evaluationAgentDispositionSchema = z.discriminatedUnion("kind", [
  evaluationAgentCriterionAttestSchema,
  evaluationUseConfirmedSchema,
  evaluationDisagreementNotedSchema,
]);
export type EvaluationAgentDisposition = z.infer<typeof evaluationAgentDispositionSchema>;

// ---- Roles, judges, obligations, fatal classes (LLD §5–§7) -----------------

/** LLD §5.1. A feedback recipient is not a performance subject unless it is also the producer. */
export const AGENT_WORK_ROLES = ["responsible", "producer", "contributor", "reviewer", "requester", "feedback_recipient"] as const;
export type AgentWorkRole = (typeof AGENT_WORK_ROLES)[number];

/** Who judged, for per-criterion tallies (LLD §6.2): a person, an independent agent, the harness, the evaluator's record checks, the agent itself. */
export const AGENT_JUDGE_KINDS = ["person", "independent_agent", "harness", "evaluator", "self"] as const;
export type AgentJudgeKind = (typeof AGENT_JUDGE_KINDS)[number];
export const AGENT_JUDGMENT_RESULTS = ["pass", "fail", "unknown"] as const;
export type AgentJudgmentResult = (typeof AGENT_JUDGMENT_RESULTS)[number];

/**
 * The four acceptance facts (LLD §1), as the drill-down names them: automated
 * acceptance, human acceptance, use, business outcome. None implies another.
 */
export const AGENT_ACCEPTANCE_FACTS = ["automated", "human", "use", "outcome"] as const;
export type AgentAcceptanceFact = (typeof AGENT_ACCEPTANCE_FACTS)[number];

/**
 * AgentDash (APM gate 3, P3.7): the case-filter value that matches rows with no
 * responsibility (`responsibility=`) or no criterion (`criterion=`). Never a
 * responsibility key (keys start with a letter or digit) nor a criterion tuple
 * key (`evaluationCriterionRefKey` is a JSON array).
 */
export const AGENT_CASE_FILTER_NONE = "(none)";

/**
 * Owed-occurrence kinds (LLD §7): `scheduled` = a schedule trigger's fire time;
 * `received` = a run a webhook/API trigger received; `deliverable` = a
 * deliverable run opened; `assigned` = an issue mapped to the responsibility;
 * `goal` = the contract deadline of a goal responsibility.
 */
export const AGENT_OBLIGATION_OCCURRENCE_KINDS = ["scheduled", "received", "deliverable", "assigned", "goal"] as const;
export type AgentObligationOccurrenceKind = (typeof AGENT_OBLIGATION_OCCURRENCE_KINDS)[number];

export const AGENT_OBLIGATION_END_STATES = [
  "delivered_on_time",
  "delivered_late",
  "in_progress",
  "not_started",
  "missed",
  "blocked_on_person",
  "blocked_on_access",
  "blocked_on_platform",
  "skipped_by_policy",
  "cancelled",
  "cause_unknown",
] as const;
export type AgentObligationEndState = (typeof AGENT_OBLIGATION_END_STATES)[number];

/** End states that need evidence: a pending question or approval, a refusal on the issue, a scheduler/budget/quota/adapter failure record. */
export const AGENT_OBLIGATION_BLOCK_STATES = ["blocked_on_person", "blocked_on_access", "blocked_on_platform"] as const;
export type AgentObligationBlockState = (typeof AGENT_OBLIGATION_BLOCK_STATES)[number];
export function isAgentObligationBlockState(state: string): state is AgentObligationBlockState {
  return (AGENT_OBLIGATION_BLOCK_STATES as readonly string[]).includes(state);
}

/** Shown first on the card, whatever the averages (LLD §6.4). */
export const AGENT_FATAL_CLASSES = [
  /** Fabricated facts, claims or prices. */
  "fabrication",
  /** Leakage across companies or into restricted data. */
  "leakage",
  "unauthorized_execution",
  "false_execution_claim",
] as const;
export type AgentFatalClass = (typeof AGENT_FATAL_CLASSES)[number];

/** Agent-card exceptions (LLD §6.3, §10). Only `unauthorized_execution` is an authority breach (E3); a refusal alone is an attempt. */
export const AGENT_EXCEPTION_KINDS = ["unauthorized_execution", "repeated_after_refusal", "disagreement"] as const;
export type AgentExceptionKind = (typeof AGENT_EXCEPTION_KINDS)[number];

// ---- The agent card (LLD §2, §6, §8, §11) ----------------------------------

/** Card shape version. */
export const AGENT_CARD_VERSION = "agent-card/1";
/** Agent formula version (LLD §6.3); separate from the milestone `FORMULA_VERSION`. Verify refuses to compare across it. */
export const AGENT_METRICS_VERSION = "agent-metrics/1";
/** `evaluation_scorecards.milestone_kind` for agent cards; `milestone_id` is the agent id (LLD §2). */
export const AGENT_CARD_SCORECARD_KIND = "agent";

/** The six sections, in the order of the overview LLD §1 questions. */
export const AGENT_CARD_SECTIONS = ["obligations", "quality", "acceptance", "cost", "bounds", "decisions"] as const;
export type AgentCardSectionKey = (typeof AGENT_CARD_SECTIONS)[number];

/**
 * How a section reaches a viewer. `visible`: the viewer reads every access
 * class the section rests on. `partial`: some; the numbers count only what
 * the viewer can read. `not_visible`: none; "Not visible to you", no counts.
 */
export const AGENT_CARD_SECTION_VISIBILITY = ["visible", "partial", "not_visible"] as const;
export type AgentCardSectionVisibility = (typeof AGENT_CARD_SECTION_VISIBILITY)[number];

export const AGENT_CARD_GAP_CODES = [
  /** No applied profile: no criteria, so acceptance can't be decided (derived-contract behaviour). */
  "NO_APPLIED_PROFILE",
  /** Work done in the window that maps to no responsibility. */
  "UNMAPPED_WORK",
  "CRITERION_WITHOUT_CHECK",
  /** A coverage class the contract asks for that no source in this company produces. */
  "COVERAGE_WITHOUT_SOURCE",
  /** Access the profile requests that isn't working (access LLD §10: a readiness gap). */
  "ACCESS_REQUESTED_NOT_WORKING",
  /** Automated observations that name no criterion tuple; visible in the drill-down, never satisfy a criterion. */
  "UNBOUND_JUDGMENTS",
  /** Deliverable periods with no run: the cadence is free text, so owed periods are unknown. */
  "OWED_PERIODS_UNKNOWN",
  /** The window starts before a source or snapshot field existed; that history is unknown. */
  "HISTORY_BEFORE_SOURCE",
] as const;
export type AgentCardGapCode = (typeof AGENT_CARD_GAP_CODES)[number];

/** Pinned replay input: a milestone card recomputed with `scoreMilestone` from the agent card's own cut (LLD §8). */
export const agentCardDependencyCitationSchema = z
  .object({
    kind: z.enum(["project", "goal"]),
    id: z.guid(),
    throughSeq: z.number().int().nonnegative(),
    formulaVersion: z.string().min(1),
    /** sha256 of the canonical milestone card (`cardHash`). */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The open flag used when the window had no roster snapshot of the milestone; verify pins it. */
    fallbackOpen: z.boolean(),
  })
  .strict();
export type AgentCardDependencyCitation = z.infer<typeof agentCardDependencyCitationSchema>;

/**
 * Everything `scoreAgent` needs besides the ledger rows, stored on the card so
 * verify re-runs it exactly (LLD §6.1). `asOf` decides what is overdue; no
 * wall clock is read inside scoring. `window.from ≤ window.to ≤ asOf`; every
 * dependency is cut at the card's `throughSeq`; dependencies are unique and
 * sorted by kind, then id.
 */
export const agentCardReplayInputsSchema = z
  .object({
    throughSeq: z.number().int().nonnegative(),
    asOf: z.string().datetime(),
    window: z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict(),
    dependencies: z.array(agentCardDependencyCitationSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const from = Date.parse(value.window.from);
    const to = Date.parse(value.window.to);
    const asOf = Date.parse(value.asOf);
    if (from > to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window", "from"], message: "window.from is after window.to" });
    if (to > asOf) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window", "to"], message: "window.to is after asOf" });
    let previous: string | null = null;
    value.dependencies.forEach((dependency, index) => {
      if (dependency.throughSeq !== value.throughSeq) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies", index, "throughSeq"], message: "a dependency is recomputed from the card's own cut" });
      }
      const key = `${dependency.kind}:${dependency.id}`;
      if (previous !== null && key <= previous) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies", index], message: "dependencies are unique and sorted by kind, then id" });
      }
      previous = key;
    });
  });
export type AgentCardReplayInputs = z.infer<typeof agentCardReplayInputsSchema>;

/**
 * An owed occurrence's id: the LLD §7 tuple as one string. Every part before
 * the last is a uuid (no `:`), so the last part (an ISO time, a run key, a
 * date) may contain `:` and the id stays unambiguous.
 */
export function agentObligationOccurrenceId(
  source:
    | { kind: "scheduled"; triggerId: string; scheduledFor: string }
    | { kind: "received"; triggerId: string; routineRunId: string }
    | { kind: "deliverable"; deliverableId: string; runKey: string }
    | { kind: "assigned"; issueId: string; mappingId: string }
    | { kind: "goal"; goalId: string; deadline: string },
): string {
  switch (source.kind) {
    case "scheduled":
      return `scheduled:${source.triggerId}:${source.scheduledFor}`;
    case "received":
      return `received:${source.triggerId}:${source.routineRunId}`;
    case "deliverable":
      return `deliverable:${source.deliverableId}:${source.runKey}`;
    case "assigned":
      return `assigned:${source.issueId}:${source.mappingId}`;
    case "goal":
      return `goal:${source.goalId}:${source.deadline}`;
  }
}
