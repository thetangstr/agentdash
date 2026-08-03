import { z } from "zod";
import {
  DELIVERABLE_CADENCES,
  DELIVERABLE_CHECK_KINDS,
  DELIVERABLE_CHECK_SEVERITIES,
  DELIVERABLE_FACT_SOURCE_TYPES,
  FACT_CORRECTION_KINDS,
} from "../types/deliverables.js";

/**
 * AgentDash-MK: the implementer's definition surface.
 *
 * These validators describe what an implementer submits, not what a customer
 * does. There is no self-service authoring path anywhere above them: the routes
 * that consume these schemas are administrator-only, and an ordinary member —
 * of any membership role — is refused.
 */

const key = z
  .string()
  .trim()
  .min(1)
  .max(120)
  // Keys travel into `pipelineId`, into `stepKey`, and into an MCP resource
  // URI. A key with a slash or a space in it would be three different strings
  // by the time it arrived, which is a class of bug nobody finds quickly.
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lowercase and contain only letters, digits, . _ -");

export const createDeliverableSchema = z
  .object({
    key,
    name: z.string().trim().min(1).max(200),
    cadence: z.enum(DELIVERABLE_CADENCES),
    assemblerAgentId: z.string().uuid(),
    /**
     * Two approvers, and they must be two people. One human in both seats is
     * one approval with extra ceremony, and G7's "nothing ships without both
     * approvals" would then be satisfiable by a single decision.
     */
    firstApproverUserId: z.string().trim().min(1).max(200),
    secondApproverUserId: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine((value) => value.firstApproverUserId !== value.secondApproverUserId, {
    message: "The two approvers must be different people",
    path: ["secondApproverUserId"],
  });
export type CreateDeliverable = z.infer<typeof createDeliverableSchema>;

/**
 * One fact in the list. **This is the encoding artifact.**
 *
 * `derivation` is required and free text on purpose: it is the sentence a human
 * reads when they ask where a number comes from, and it is the thing the MCP
 * resource serves. A fact with no stated derivation is a fact nobody can
 * question.
 */
export const createDeliverableFactSchema = z
  .object({
    key,
    label: z.string().trim().min(1).max(200),
    sourceType: z.enum(DELIVERABLE_FACT_SOURCE_TYPES),
    derivation: z.string().trim().min(1).max(4000),
    ownerAgentId: z.string().uuid(),
    connectorProvider: z.string().trim().min(1).max(60).optional(),
    connectorConfig: z.record(z.unknown()).optional(),
    orderIndex: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.sourceType === "system"
        ? Boolean(value.connectorProvider && value.connectorConfig)
        : !value.connectorProvider && !value.connectorConfig,
    {
      message:
        "A system fact needs a connector provider and target; a human fact must not carry one",
      path: ["connectorProvider"],
    },
  );
export type CreateDeliverableFact = z.infer<typeof createDeliverableFactSchema>;

export const createDeliverableCheckSchema = z
  .object({
    key,
    kind: z.enum(DELIVERABLE_CHECK_KINDS),
    config: z.record(z.unknown()),
    severity: z.enum(DELIVERABLE_CHECK_SEVERITIES).optional(),
  })
  .strict();
export type CreateDeliverableCheck = z.infer<typeof createDeliverableCheckSchema>;

/**
 * A correction, recorded against the FACT.
 *
 * There is no field naming whose figure was wrong, and there is nowhere to put
 * one. `reason` is about the number; the author is taken from the authenticated
 * actor, the way an answer's provenance is, and never from the body.
 */
export const recordFactCorrectionSchema = z
  .object({
    factKey: z.string().trim().min(1).max(120),
    correction: z
      .object({ kind: z.enum(FACT_CORRECTION_KINDS) })
      .passthrough(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type RecordFactCorrection = z.infer<typeof recordFactCorrectionSchema>;
