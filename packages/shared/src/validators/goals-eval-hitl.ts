// AgentDash: goals-eval-hitl
import { z } from "zod";

// ---------------------------------------------------------------------------
// GoalMetricDefinition
// ---------------------------------------------------------------------------

export const goalMetricDefinitionSchema = z.object({
  target: z.union([z.number(), z.string()]),
  unit: z.string().min(1),
  source: z.string().min(1),
  baseline: z.union([z.number(), z.string()]).optional(),
  currentValue: z.union([z.number(), z.string()]).optional(),
  lastUpdatedAt: z.string().datetime().optional(),
});

export type GoalMetricDefinition = z.infer<typeof goalMetricDefinitionSchema>;

// ---------------------------------------------------------------------------
// DefinitionOfDone
// ---------------------------------------------------------------------------

export const definitionOfDoneCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean(),
});

export type DefinitionOfDoneCriterion = z.infer<typeof definitionOfDoneCriterionSchema>;

export const definitionOfDoneSchema = z.object({
  summary: z.string().min(1),
  criteria: z
    .array(definitionOfDoneCriterionSchema)
    .min(1, "DoD must have at least one criterion"),
  goalMetricLink: z.string().optional(),
});

export type DefinitionOfDone = z.infer<typeof definitionOfDoneSchema>;

// ---------------------------------------------------------------------------
// Verdict enums
// ---------------------------------------------------------------------------

export const verdictOutcomeSchema = z.enum([
  "passed",
  "failed",
  "revision_requested",
  "escalated_to_human",
  "pending",
]);

export type VerdictOutcome = z.infer<typeof verdictOutcomeSchema>;

export const verdictEntityTypeSchema = z.enum(["goal", "project", "issue"]);

export type VerdictEntityType = z.infer<typeof verdictEntityTypeSchema>;

// ---------------------------------------------------------------------------
// VerdictRubricScores
// ---------------------------------------------------------------------------

export const verdictRubricScoresSchema = z.record(
  z.string(),
  z.union([
    z.number(),
    z.object({
      score: z.number().min(0).max(5),
      justification: z.string().optional(),
    }),
  ]),
);

export type VerdictRubricScores = z.infer<typeof verdictRubricScoresSchema>;

// ---------------------------------------------------------------------------
// CreateVerdictInput
// ---------------------------------------------------------------------------

export const createVerdictInputSchema = z
  .object({
    companyId: z.string().uuid(),
    entityType: verdictEntityTypeSchema,
    goalId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    issueId: z.string().uuid().optional(),
    reviewerAgentId: z.string().uuid().optional(),
    reviewerUserId: z.string().optional(),
    outcome: verdictOutcomeSchema,
    rubricScores: verdictRubricScoresSchema.optional(),
    justification: z.string().optional(),
  })
  .refine(
    (v) => {
      const entityCount = [v.goalId, v.projectId, v.issueId].filter(Boolean).length;
      if (entityCount !== 1) return false;
      if (v.entityType === "goal" && !v.goalId) return false;
      if (v.entityType === "project" && !v.projectId) return false;
      if (v.entityType === "issue" && !v.issueId) return false;
      return true;
    },
    {
      message:
        "Exactly one of (goalId, projectId, issueId) must be set and must match entityType",
    },
  )
  .refine(
    (v) => {
      const reviewerCount = [v.reviewerAgentId, v.reviewerUserId].filter(Boolean).length;
      return reviewerCount === 1;
    },
    {
      message: "Exactly one of (reviewerAgentId, reviewerUserId) must be set",
    },
  );

export type CreateVerdictInput = z.infer<typeof createVerdictInputSchema>;

// ---------------------------------------------------------------------------
// VerdictReviewCardPayload  (cardKind: "verdict_review")
// ---------------------------------------------------------------------------

export const verdictReviewCardPayloadSchema = z.object({
  verdictId: z.string().uuid(),
  /** Discriminated by entityType — exactly one of goalId/projectId/issueId is non-null. */
  issueId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  goalId: z.string().uuid().optional(),
  entityType: verdictEntityTypeSchema,
  outcome: verdictOutcomeSchema,
  rubricScores: verdictRubricScoresSchema.optional(),
  justification: z.string().optional(),
  reviewerAgentId: z.string().uuid().optional(),
  reviewerUserId: z.string().optional(),
});

export type VerdictReviewCardPayload = z.infer<typeof verdictReviewCardPayloadSchema>;

// ---------------------------------------------------------------------------
// HumanTasteGateCardPayload  (cardKind: "human_taste_gate")
// ---------------------------------------------------------------------------

export const humanTasteGateCardPayloadSchema = z.object({
  approvalId: z.string().uuid(),
  /** The original escalated_to_human verdict that triggered this gate. */
  verdictId: z.string().uuid(),
  issueId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  goalId: z.string().uuid().optional(),
  entityType: verdictEntityTypeSchema,
  /** Human-readable summary of what needs review. */
  summary: z.string(),
  /** Why CoS escalated (taste-critical, low-confidence, etc.). */
  rationale: z.string(),
  /** Deep link to the issue/project/goal in the UI. */
  reviewUrl: z.string().optional(),
});

export type HumanTasteGateCardPayload = z.infer<typeof humanTasteGateCardPayloadSchema>;
