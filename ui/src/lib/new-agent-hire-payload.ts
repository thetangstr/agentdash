import type { CreateConfigValues } from "../components/AgentConfigForm";
import { buildNewAgentRuntimeConfig } from "./new-agent-runtime-config";

export function buildNewAgentHirePayload(input: {
  name: string;
  workforceTemplateId?: string;
  effectiveRole: string;
  title?: string;
  /** What the agent should do, in the owner's words. */
  capabilities?: string;
  reportsTo?: string | null;
  selectedSkillKeys?: string[];
  configValues: CreateConfigValues;
  adapterConfig: Record<string, unknown>;
  requireHarnessPreflight?: boolean;
}) {
  const {
    name,
    workforceTemplateId,
    effectiveRole,
    title,
    capabilities,
    reportsTo,
    selectedSkillKeys = [],
    configValues,
    adapterConfig,
    requireHarnessPreflight,
  } = input;

  return {
    name: name.trim(),
    role: effectiveRole,
    ...(workforceTemplateId ? { workforceTemplateId } : {}),
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(capabilities?.trim() ? { capabilities: capabilities.trim() } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(selectedSkillKeys.length > 0 ? { desiredSkills: selectedSkillKeys } : {}),
    adapterType: configValues.adapterType,
    defaultEnvironmentId: configValues.defaultEnvironmentId ?? null,
    adapterConfig,
    runtimeConfig: buildNewAgentRuntimeConfig({
      heartbeatEnabled: configValues.heartbeatEnabled,
      intervalSec: configValues.intervalSec,
      cheapModel: configValues.cheapModel,
      cheapModelEnabled: configValues.cheapModelEnabled,
    }),
    budgetMonthlyCents: 0,
    ...(requireHarnessPreflight ? { requireHarnessPreflight: true } : {}),
  };
}
