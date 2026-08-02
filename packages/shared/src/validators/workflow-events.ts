import { z } from "zod";
import {
  WORKFLOW_ACTOR_KINDS,
  WORKFLOW_EVENT_TYPES,
  type WorkflowEventType,
} from "../types/workflow-events.js";

/**
 * AgentDash-MK: the payload allowlist.
 *
 * This is the gate that keeps a person out of the measurement substrate. It is
 * a **closed allowlist**, not a blocklist: each event type declares exactly
 * which keys its payload may carry, `.strict()` rejects everything else, and
 * none of the declared keys is a person or an agent. There is no key to smuggle
 * an identifier through, so no blocklist has to anticipate the name someone
 * would have used.
 *
 * The database carries a blocklist check as well. That one is the backstop for
 * writers who never come through here — a later slice, a migration, a psql
 * session — and it is deliberately the weaker of the two mechanisms. This is
 * the strong one.
 *
 * Note what is absent and must stay absent: agent ids. An AgentDash agent is
 * bound 1:1 to a steward, so recording which agent acted records which human
 * did, one join later.
 */
const emptyPayload = z.object({}).strict();

const workflowEventPayloadSchemas = {
  fact_asked: z.object({ factKey: z.string().min(1) }).strict(),
  fact_answered: z
    .object({
      factKey: z.string().min(1),
      /** "connector" | "agent" | "human" — the kind of source, never the source. */
      sourceKind: z.string().min(1).optional(),
      answerChars: z.number().int().nonnegative().optional(),
    })
    .strict(),
  approval_requested: z
    .object({
      approvalType: z.string().min(1),
      taskClass: z.string().min(1).optional(),
    })
    .strict(),
  approval_decided: z
    .object({
      approvalType: z.string().min(1),
      decision: z.enum(["approved", "rejected"]),
      /** Delivery channel, e.g. "web" | "telegram" | "teams". */
      channel: z.string().min(1).nullable().optional(),
      /** The ROLE that decided ("steward", "owner"), never the person in it. */
      actorRole: z.string().min(1).nullable().optional(),
      override: z.boolean().optional(),
    })
    .strict(),
  escalation_opened: z
    .object({
      taskClass: z.string().min(1),
      approvalGated: z.boolean(),
    })
    .strict(),
  escalation_expired: z
    .object({
      taskClass: z.string().min(1),
      outcome: z.string().min(1),
      requeued: z.boolean(),
    })
    .strict(),
  step_completed: z
    .object({
      taskClass: z.string().min(1).optional(),
      /** Length only. The result itself is untrusted content that lives on its own row. */
      resultChars: z.number().int().nonnegative().optional(),
    })
    .strict(),
  step_failed: z
    .object({
      taskClass: z.string().min(1).optional(),
      reasonChars: z.number().int().nonnegative().optional(),
    })
    .strict(),
  correction_recorded: z
    .object({
      version: z.number().int().positive().optional(),
      correctionChars: z.number().int().nonnegative().optional(),
    })
    .strict(),
} satisfies Record<WorkflowEventType, z.ZodTypeAny>;

export function workflowEventPayloadSchema(eventType: WorkflowEventType): z.ZodTypeAny {
  return workflowEventPayloadSchemas[eventType] ?? emptyPayload;
}

/**
 * One emitted transition.
 *
 * There is no actor identifier field and no optional one. A caller that wanted
 * to record who acted would have to change this type, the table, and the check
 * constraint — which is the amount of friction a rule needs to survive the
 * first person who asks "but who was slow?".
 */
export const emitWorkflowEventSchema = z
  .object({
    companyId: z.string().trim().min(1),
    pipelineId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
    stepKey: z.string().trim().min(1).max(200),
    eventType: z.enum(WORKFLOW_EVENT_TYPES),
    actorKind: z.enum(WORKFLOW_ACTOR_KINDS),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

export type EmitWorkflowEvent = z.infer<typeof emitWorkflowEventSchema>;
