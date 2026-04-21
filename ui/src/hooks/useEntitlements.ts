// AgentDash: useEntitlements hook
// Thin wrapper over TanStack Query so gated UI affordances can read the
// current tier + limits + features. The server remains the single source
// of truth — this hook is display-only.

import { useQuery } from "@tanstack/react-query";
import { entitlementsApi, type Entitlements, type Tier } from "../api/entitlements";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

const FREE_FALLBACK: Entitlements = {
  tier: "free",
  limits: { agents: 2, monthlyActions: 500, pipelines: 1 },
  features: {
    hubspotSync: false,
    autoResearch: false,
    assessMode: false,
    prioritySupport: false,
  },
};

export type SubscriptionStatus = "active" | "past_due" | "canceled" | "trialing";

export interface UseEntitlementsResult {
  entitlements: Entitlements;
  tier: Tier;
  isLoading: boolean;
  hasFeature: (feature: keyof Entitlements["features"]) => boolean;
  isAtLeast: (min: Tier) => boolean;
  stripeCustomerId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  currentPeriodEnd: string | null;
}

const TIER_ORDER: Record<Tier, number> = { free: 0, pro: 1, enterprise: 2 };

export function useEntitlements(): UseEntitlementsResult {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? null;

  const { data, isLoading } = useQuery({
    queryKey: companyId
      ? queryKeys.entitlements.detail(companyId)
      : ["entitlements", "none"],
    queryFn: () => entitlementsApi.get(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });

  const entitlements = data ?? FREE_FALLBACK;
  const raw = data as (Entitlements & {
    stripeCustomerId?: string | null;
    subscriptionStatus?: string | null;
    currentPeriodEnd?: string | null;
  }) | undefined;

  return {
    entitlements,
    tier: entitlements.tier,
    isLoading,
    hasFeature: (feature) => entitlements.features[feature],
    isAtLeast: (min) => TIER_ORDER[entitlements.tier] >= TIER_ORDER[min],
    stripeCustomerId: raw?.stripeCustomerId ?? null,
    subscriptionStatus: (raw?.subscriptionStatus ?? null) as SubscriptionStatus | null,
    currentPeriodEnd: raw?.currentPeriodEnd ?? null,
  };
}
