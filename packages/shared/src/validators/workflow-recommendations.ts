import { z } from "zod";
import {
  WORKFLOW_RECOMMENDATION_KINDS,
  type WorkflowRecommendationKind,
} from "../types/workflow-recommendations.js";

/**
 * AgentDash-MK: the observation allowlist.
 *
 * The same shape as B's payload allowlist and for the same reason: a **closed**
 * allowlist per kind, `.strict()`, and every permitted key a non-negative
 * integer. A recommendation's observation cannot carry a string at all, so
 * there is no field in which a name, an id, or an email could travel — no
 * blocklist has to anticipate what someone would have called it.
 *
 * The database carries a blocklist check too. That one is the backstop for
 * writers that never come through here; this is the gate.
 */
const observationSchemas = {
  recurring_correction: z
    .object({
      cyclesObserved: z.number().int().nonnegative(),
      cyclesWithEvidence: z.number().int().nonnegative(),
      correctionCount: z.number().int().nonnegative(),
    })
    .strict(),
  chronic_escalation_stall: z
    .object({
      cyclesObserved: z.number().int().nonnegative(),
      cyclesWithEvidence: z.number().int().nonnegative(),
      expiredCount: z.number().int().nonnegative(),
      maxStallMs: z.number().int().nonnegative(),
    })
    .strict(),
} satisfies Record<WorkflowRecommendationKind, z.ZodTypeAny>;

export function workflowRecommendationObservationSchema(
  kind: WorkflowRecommendationKind,
): z.ZodTypeAny {
  return observationSchemas[kind];
}

/**
 * The cited evidence.
 *
 * `eventIds` is `.min(1)` here and non-empty by check constraint in the table.
 * Both, because H4's claim — that this system measures rather than asserts — is
 * only true if a recommendation without its rows cannot exist, and a rule that
 * lives only in a validator binds only the callers who use it.
 */
export const workflowRecommendationEvidenceSchema = z
  .object({
    query: z.string().min(1).max(2000),
    runIds: z.array(z.string().min(1)).min(1),
    eventIds: z.array(z.string().uuid()).min(1),
    eventTypes: z.array(z.string().min(1)).min(1),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })
  .strict();

/**
 * What the deriver may raise.
 *
 * There is no route that consumes this schema. The only writer is the
 * derivation itself, and that is deliberate: a caller-supplied recommendation
 * would be a free-text field pointed at a human, which is exactly where a
 * sentence about a named colleague would arrive.
 */
export const raiseWorkflowRecommendationSchema = z
  .object({
    pipelineId: z.string().trim().min(1).max(200),
    stepKey: z.string().trim().min(1).max(200),
    kind: z.enum(WORKFLOW_RECOMMENDATION_KINDS),
    cyclesObserved: z.number().int().positive(),
    evidenceCycles: z.number().int().positive(),
    latestRunId: z.string().trim().min(1).max(200),
    observation: z.record(z.number()),
    evidence: workflowRecommendationEvidenceSchema,
  })
  .strict();
export type RaiseWorkflowRecommendation = z.infer<typeof raiseWorkflowRecommendationSchema>;
