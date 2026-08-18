import { z } from "zod";
import { AGENT_FACT_SOURCE_KINDS } from "../types/agent-facts.js";

/**
 * Ask another agent for a named fact.
 *
 * `requestedByAgentId` is deliberately absent: the requester is the
 * authenticated agent, never a body field. Accepting one would let any agent
 * file asks in another's name and manufacture provenance for a figure.
 *
 * `runId` plus `factKey` is the dedup key. One ask per fact per run is a
 * product promise as much as a technical one — a person who is asked the same
 * question three times in one cycle stops answering, and that is the failure
 * mode this whole design is trying to avoid.
 */
export const askAgentFactSchema = z
  .object({
    targetAgentId: z.string().uuid(),
    factKey: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
    pipelineId: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(4000),
  })
  .strict();
export type AskAgentFact = z.infer<typeof askAgentFactSchema>;

/**
 * Answer a fact request.
 *
 * `sourceKind` is required and closed. An answer without a classifiable source
 * is a figure nobody can check later, and "trust me" is not a provenance.
 */
export const answerAgentFactSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
    sourceKind: z.enum(AGENT_FACT_SOURCE_KINDS),
  })
  .strict();
export type AnswerAgentFact = z.infer<typeof answerAgentFactSchema>;

/**
 * A steward answering their own agent's question.
 *
 * No `sourceKind`: it is forced to "human" by the service. A caller that could
 * choose the label could record a recollection as a connector reading, and the
 * whole point of the source kind is that a reader can tell those apart.
 */
export const answerAsStewardSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type AnswerAsSteward = z.infer<typeof answerAsStewardSchema>;

export const declineAgentFactSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type DeclineAgentFact = z.infer<typeof declineAgentFactSchema>;
