// AgentDash: per-company feature-flag hooks.
// Thin react-query wrapper over the existing feature-flag API + the selected
// company from context. One fetch per company; individual flags read from the map.
import { useQuery } from "@tanstack/react-query";
import { goalsEvalHitlApi, goalsEvalHitlQueryKeys } from "../api/goals-eval-hitl";
import { useCompany } from "../context/CompanyContext";

export interface FeatureFlagState {
  /** Whether the flag list has loaded yet. */
  isLoading: boolean;
  /** enabled flag keys → true. Unknown keys are treated as disabled. */
  flags: Record<string, boolean>;
  isEnabled: (flagKey: string) => boolean;
}

export function useFeatureFlags(): FeatureFlagState {
  const { selectedCompanyId } = useCompany();

  const query = useQuery({
    queryKey: goalsEvalHitlQueryKeys.featureFlags(selectedCompanyId ?? "none"),
    queryFn: () => goalsEvalHitlApi.listFeatureFlags(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    staleTime: 60_000,
  });

  const flags: Record<string, boolean> = {};
  for (const row of query.data ?? []) {
    flags[row.flagKey] = row.enabled;
  }

  return {
    isLoading: query.isLoading,
    flags,
    isEnabled: (flagKey: string) => flags[flagKey] === true,
  };
}

/** Convenience: read a single flag. */
export function useFeatureFlag(flagKey: string): { isLoading: boolean; enabled: boolean } {
  const { isLoading, isEnabled } = useFeatureFlags();
  return { isLoading, enabled: isEnabled(flagKey) };
}
