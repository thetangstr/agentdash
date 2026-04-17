// AgentDash: Entitlements matrix
// Pure mapping from tier → { limits, features }. Consumed by both the server
// entitlements service (canonical source for gating) and the UI hooks (display
// only — server still enforces).

import type { Tier } from "./constants.js";

export { TIERS, type Tier } from "./constants.js";

export type Entitlements = {
  tier: Tier;
  limits: {
    agents: number;
    monthlyActions: number;
    pipelines: number;
  };
  features: {
    hubspotSync: boolean;
    autoResearch: boolean;
    assessMode: boolean;
    prioritySupport: boolean;
  };
};

const TABLE: Record<Tier, Omit<Entitlements, "tier">> = {
  free: {
    limits: { agents: 2, monthlyActions: 500, pipelines: 1 },
    features: {
      hubspotSync: false,
      autoResearch: false,
      assessMode: false,
      prioritySupport: false,
    },
  },
  pro: {
    limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
    features: {
      hubspotSync: true,
      autoResearch: true,
      assessMode: true,
      prioritySupport: false,
    },
  },
  enterprise: {
    limits: { agents: 1_000, monthlyActions: 5_000_000, pipelines: 1_000 },
    features: {
      hubspotSync: true,
      autoResearch: true,
      assessMode: true,
      prioritySupport: true,
    },
  },
};

export function entitlementsForTier(tier: Tier): Entitlements {
  return { tier, ...TABLE[tier] };
}

const TIER_ORDER: Record<Tier, number> = { free: 0, pro: 1, enterprise: 2 };

export function tierAtLeast(current: Tier, required: Tier): boolean {
  return TIER_ORDER[current] >= TIER_ORDER[required];
}
