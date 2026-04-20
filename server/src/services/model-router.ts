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

/**
 * Check whether a run exceeded the skill's maxToolCalls limit.
 */
export function checkMaxToolCalls(
  toolCallCount: number,
  maxToolCalls: number | null,
): { passed: boolean; reason?: string } {
  if (maxToolCalls === null) return { passed: true };
  if (toolCallCount > maxToolCalls) {
    return { passed: false, reason: `exceeded_max_tool_calls: ${toolCallCount} > ${maxToolCalls}` };
  }
  return { passed: true };
}

/**
 * Check whether a small-model run's output passes the skill's verification rule.
 * Schema verification does a key-presence check. Effect verification is a no-op
 * here (exit-code checks happen at the adapter level).
 */
export function checkVerification(
  result: Record<string, unknown>,
  verification: { type: string; zodSchema?: string; command?: string } | null,
): { passed: boolean; reason?: string } {
  if (!verification || verification.type === "none") return { passed: true };

  if (verification.type === "schema" && verification.zodSchema) {
    try {
      const expected = JSON.parse(verification.zodSchema) as Record<string, unknown>;
      const missingKeys = Object.keys(expected).filter((k) => !(k in result));
      if (missingKeys.length > 0) {
        return { passed: false, reason: `schema_mismatch: missing keys: ${missingKeys.join(", ")}` };
      }
      return { passed: true };
    } catch {
      return { passed: false, reason: "schema_parse_error" };
    }
  }

  if (verification.type === "effect") {
    // Effect verification (exit-code check) happens externally
    return { passed: true };
  }

  return { passed: true };
}
