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
 */
export const EVALUATION_SCHEMA_VERSION = 2;

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
  // catch-all
  "activity.other",
] as const;
export type EvaluationEventType = (typeof EVALUATION_EVENT_TYPES)[number];

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
  id: z.string().uuid(),
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
  companyId: z.string().uuid(),
  goalId: z.string().uuid().nullable(),
  parentGoalId: z.string().uuid().nullable(),
  milestoneRef: evaluationMilestoneRefSchema,
  accountableUserId: z.string().min(1).nullable(),
  leadAgentId: z.string().uuid().nullable(),
  acceptanceCriteria: z.array(evaluationAcceptanceCriterionSchema),
  definitionOfDone: z.string().nullable(),
  requiredEvidence: z.array(z.enum(EVALUATION_EVIDENCE_CLASSES)),
  independenceRule: z.literal("independence/v1"),
  /** Actors who may not review this milestone's items, declared by the founder. */
  excludedReviewers: z.array(z.string()).default([]),
  /** Items only the founder may act on; there is no system record of a lock (§4.4). */
  founderLocks: z.array(z.string().uuid()).default([]),
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

/** §5.3 composite weights. Metrics absent here are shown, never scored. */
export const EVALUATION_OUTCOME_WEIGHTS: Partial<Record<EvaluationMetricKey, number>> = { O1: 0.4, O2: 0.15, O3: 0.2, O4: 0.1, O5: 0.15 };
export const EVALUATION_OPERATING_WEIGHTS: Partial<Record<EvaluationMetricKey, number>> = { P1: 0.2, P2: 0.2, P3: 0.25, P4: 0.15, P9: 0.2 };
/** §5.3 guards: minimum included metrics for a composite to exist. */
export const EVALUATION_COMPOSITE_MIN_INCLUDED = { outcome: 2, operating: 3 } as const;

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
