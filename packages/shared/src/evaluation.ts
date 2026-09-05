import { z } from "zod";

/**
 * AgentDash: Company Evaluator (Stage 1, read-only shadow) — shared vocabulary.
 *
 * Spec: docs/superpowers/specs/2026-09-05-company-evaluator-design.md.
 * Everything here is data vocabulary; formulas live in the server's
 * evaluation services and carry their own `formulaVersion`.
 */

/** Schema version stamped on every ledger event. Bump when a payload shape changes. */
export const EVALUATION_SCHEMA_VERSION = 1;

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
