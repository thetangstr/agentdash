import { z } from "zod";
import {
  AGENT_RECOMMENDATION_DECISIONS,
  AGENT_RECOMMENDATION_EVIDENCE_KINDS,
  AGENT_RECOMMENDATION_KINDS,
} from "../types/performance-manager.js";

/**
 * AgentDash: Agent Performance Management gate 4 (P4.1) — request bodies for
 * the performance manager designation and its recommendations.
 */

/** `PATCH /api/companies/:companyId/performance-manager`: an agent id, or null for the Chief of Staff default. */
export const updatePerformanceManagerSchema = z
  .object({
    agentId: z.guid().nullable(),
  })
  .strict();
export type UpdatePerformanceManager = z.infer<typeof updatePerformanceManagerSchema>;

export const agentRecommendationEvidenceSchema = z
  .object({
    kind: z.enum(AGENT_RECOMMENDATION_EVIDENCE_KINDS),
    ref: z.string().trim().min(1).max(300),
  })
  .strict();

/** `POST .../evaluation/agents/:agentId/recommendations` (the performance manager only). */
export const createAgentRecommendationSchema = z
  .object({
    kind: z.enum(AGENT_RECOMMENDATION_KINDS),
    reason: z.string().trim().min(1).max(4000),
    evidence: z.array(agentRecommendationEvidenceSchema).min(1).max(50),
    proposalApprovalId: z.guid().nullable().optional(),
  })
  .strict();
export type CreateAgentRecommendation = z.infer<typeof createAgentRecommendationSchema>;

/** `POST .../recommendations/:recommendationId/decision` (the accountable person or an admin). */
export const decideAgentRecommendationSchema = z
  .object({
    decision: z.enum(AGENT_RECOMMENDATION_DECISIONS),
    note: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();
export type DecideAgentRecommendation = z.infer<typeof decideAgentRecommendationSchema>;
