// AgentDash: Smart model routing — resolves model tier for heartbeat dispatch

import { SMALL_MODELS } from "@agentdash/shared";
import type { SkillVerification } from "@agentdash/shared";

export interface ModelRoutingSkillInput {
  modelTier: string | null;
  maxToolCalls: number | null;
  verification: SkillVerification | null;
}

export interface ModelRoutingStageInput {
  modelTier: string | null;
}

export interface ModelRoutingAgentInput {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface ModelRoutingResult {
  model: string;
  tier: "small" | "default";
}

/**
 * Resolve which model to use for a heartbeat dispatch.
 *
 * Priority: pipeline stage modelTier > skill modelTier > agent default.
 * Only "small" overrides the agent default. Unknown adapter types fall back to default.
 */
export function resolveModelTier(params: {
  agent: ModelRoutingAgentInput;
  skill: ModelRoutingSkillInput | null;
  pipelineStage: ModelRoutingStageInput | null;
}): ModelRoutingResult {
  const { agent, skill, pipelineStage } = params;
  const agentModel = (agent.adapterConfig.model as string) ?? "";

  // Priority: pipeline stage > skill > default
  const tier = pipelineStage?.modelTier ?? skill?.modelTier ?? null;

  if (tier === "small") {
    const smallModel = SMALL_MODELS[agent.adapterType];
    if (smallModel) {
      return { model: smallModel, tier: "small" };
    }
    // Unknown adapter type — can't route to small, fall back to default
  }

  return { model: agentModel, tier: "default" };
}
